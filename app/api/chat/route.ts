import { type NextRequest } from "next/server";
import { turn, type TurnInput } from "@/harness/turn";
import { DeepSeekAdapter } from "@/harness/modelAdapter";
import { Tracer } from "@/harness/tracer";
import { EventLog } from "@/harness/eventLog";
import { createUserSupabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createMemoryStore,
  createSupabaseProfileGateway,
} from "@/lib/memoryStore";
import { supabaseInteractionStore } from "@/lib/drugInteractions";
import type { UserContext } from "@/harness/gate";
import type { InteractionStore } from "@/lib/drugInteractions";
import {
  parseChatBody,
  buildChatTurnPorts,
  type ChatRequestBody,
} from "@/lib/chatApi";
import {
  createLogMealHandler,
  LOG_MEAL_SCHEMA,
  type ProposalStore,
} from "@/harness/logMeal";
import { SUBMIT_ANSWER_SCHEMA } from "@/harness/submitAnswer";
import {
  createQueryCatalogHandler,
  createInMemoryQueryRunner,
  QUERY_CATALOG_SCHEMA,
} from "@/harness/queryCatalog";
import { loadConfiguredCatalog } from "@/catalog/snapshotLoader";
import {
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "@/catalog/queryCatalog";
import { createSupabaseProposalStore } from "@/lib/proposalStore";
import {
  createSupabaseMealLogStore,
  listUserMealRecords,
} from "@/lib/mealLogStore";
import type { MealRecord, QueryRunner } from "@/catalog/queryCatalog";
import { createSupabaseQueryRunner } from "@/lib/sqlQueryRunner";
import { assertSessionSubject, getSessionFromHeader } from "@/lib/auth";
import type { ChatMessage, ToolHandler } from "@/harness/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-level catalog (built once at cold start: CATALOG_SNAPSHOT_PATH
// snapshot when configured, else seed data — issue #60)
const catalog = loadConfiguredCatalog();
const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
const toolSchemas = [
  LOG_MEAL_SCHEMA,
  QUERY_CATALOG_SCHEMA,
  SUBMIT_ANSWER_SCHEMA,
] as const;

// ─── Tool wiring ───────────────────────────────────────────────────────

function buildToolMap(
  sessionUserId: string,
  proposalStore: ProposalStore,
  queryRunner: QueryRunner,
): ReadonlyMap<string, ToolHandler> {
  const logMealHandler = createLogMealHandler({
    catalog,
    proposalStore,
    userId: sessionUserId,
  });

  const queryCatalogHandler = createQueryCatalogHandler({
    queryCatalog,
    runner: queryRunner,
    userId: sessionUserId,
  });

  return new Map([
    ["log_meal", logMealHandler],
    ["query_catalog", queryCatalogHandler],
  ]);
}

function getRequestHistory(
  body: ChatRequestBody,
  turnInput: TurnInput,
): readonly ChatMessage[] | undefined {
  if (turnInput.tag !== "utterance" || body.tag === "proposal_confirm") {
    return undefined;
  }

  return body.history;
}

// ─── User context loading ──────────────────────────────────────────────

async function loadUserContext(
  client: SupabaseClient,
  userId: string,
): Promise<
  { userContext: UserContext; interactionStore: InteractionStore } | undefined
> {
  try {
    const gateway = createSupabaseProfileGateway(client);
    const store = createMemoryStore({ gateway });
    const profile = await store.getProfile(userId);
    if (
      !profile ||
      (profile.allergies.length === 0 && profile.medications.length === 0)
    ) {
      return undefined;
    }
    return {
      userContext: {
        allergies: profile.allergies,
        medications: profile.medications,
      },
      interactionStore: supabaseInteractionStore(client),
    };
  } catch {
    return undefined;
  }
}

/** Fail-soft meal loading: a ledger read failure degrades queries to empty
 *  observations instead of failing the turn. */
async function loadUserMeals(
  client: Parameters<typeof listUserMealRecords>[0],
  userId: string,
): Promise<readonly MealRecord[]> {
  try {
    return await listUserMealRecords(client, userId);
  } catch {
    return [];
  }
}

// ─── Route handler ─────────────────────────────────────────────────────

/**
 * POST /api/chat — drive one turn through the Turn Seam.
 *
 * Accepts tagged inputs: either an utterance (model turn with full gate
 * pipeline) or a proposal_confirm (short-circuited confirmation turn).
 *
 * Streams typed AnyTurnEvents as NDJSON (one JSON object per line).
 *
 * Identity derives from the authenticated Supabase session (Authorization
 * header), not from a client-asserted header. The session user identity is
 * verified server-side and never enters model-fillable input.
 */
export async function POST(request: NextRequest): Promise<Response> {
  // ── Parse body ────────────────────────────────────────────────────
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let turnInput: TurnInput;
  try {
    turnInput = parseChatBody(body);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Invalid request body",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // ── Extract session user identity from Supabase auth session ─────
  const session = await getSessionFromHeader(createUserSupabase, request);
  // RFC 0001: JWT sub must match session.userId before turn assembly.
  if (session) {
    try {
      assertSessionSubject(session);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: err instanceof Error ? err.message : "session subject mismatch",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }
  const sessionUserId = session?.userId;

  // ── Build ports ───────────────────────────────────────────────────
  const adapter = new DeepSeekAdapter();
  const tracer = new Tracer();
  const sessionId = sessionUserId ?? "anonymous";
  const eventLog = new EventLog(sessionId);

  let ports = buildChatTurnPorts({
    adapter,
    tracer,
    eventLog,
    sessionUserId,
    history: getRequestHistory(body, turnInput),
    catalog,
    queryCatalog,
    catalogVersion: catalog.snapshot.version,
  });

  // ── Wire Supabase-backed stores and tools for authenticated users ─
  if (session) {
    // Session-scoped client: the turn path runs under the user's JWT so
    // RLS binds beneath the executor's userId scoping (issue #62 /
    // ADD §Multi-User — the unrestricted role exists in migrations only).
    const userClient = createUserSupabase(session.accessToken);
    const proposalStore = createSupabaseProposalStore({
      client: userClient,
    });
    // mealLogStore remains available for non-confirm reads if needed;
    // confirm writes go only through proposalStore RPCs (RFC 0001).
    const mealLogStore = createSupabaseMealLogStore(userClient);

    ports = {
      ...ports,
      proposalStore,
      mealLogStore,
    };

    if (turnInput.tag === "utterance") {
      // SQL runner when configured (issue #64): reviewed SQL under the
      // SELECT-only role, identity bound via the session JWT. Otherwise
      // the in-memory runner fed with the user's ledger rows (issue #55) —
      // scripted CI stays here with zero network.
      const queryRunner =
        process.env.NUTRIBUDDY_QUERY_RUNNER === "sql"
          ? createSupabaseQueryRunner(userClient, catalog)
          : createInMemoryQueryRunner(
              catalog,
              await loadUserMeals(userClient, session.userId),
            );

      ports = {
        ...ports,
        tools: buildToolMap(session.userId, proposalStore, queryRunner),
        toolSchemas,
      };
    }

    // ── Load user safety context (fail-soft) ────────────────────────
    const ctx = await loadUserContext(userClient, session.userId);
    if (ctx) {
      ports = {
        ...ports,
        userContext: ctx.userContext,
        interactionStore: ctx.interactionStore,
      };
    }
  }

  // ── Stream ────────────────────────────────────────────────────────
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        const gen = turn(turnInput, ports);

        let result = await gen.next();
        while (!result.done) {
          enqueue(result.value);
          result = await gen.next();
        }

        // The generator return value is the TurnResult — emit as terminal
        enqueue({ type: "terminal", ...result.value });
        controller.close();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        const safeMessage = errorMessage.includes("DEEPSEEK_API_KEY")
          ? "AI model is not configured yet. Please add DEEPSEEK_API_KEY to your environment."
          : errorMessage;
        enqueue({ type: "error", error: safeMessage });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
