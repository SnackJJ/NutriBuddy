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
import { loadUserSafetyContext } from "@/lib/userSafetyContext";
import {
  parseChatBody,
  assembleChatTurnPorts,
  type ChatRequestBody,
} from "@/lib/chatApi";
import { incompleteAssemblyResult } from "@/harness/turnAssembly";
import {
  createLogMealHandler,
  LOG_MEAL_SCHEMA,
  type ProposalStore,
} from "@/harness/logMeal";
import { SUBMIT_ANSWER_SCHEMA } from "@/harness/submitAnswer";
import {
  createQueryCatalogHandler,
  QUERY_CATALOG_SCHEMA,
} from "@/harness/queryCatalog";
import {
  loadConfiguredCatalog,
  createInMemoryQueryRunner,
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "@/catalog";
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
  if (turnInput.tag !== "utterance") {
    return undefined;
  }
  return body.tag === "utterance" || body.tag === undefined
    ? body.history
    : undefined;
}

// ─── User context loading ──────────────────────────────────────────────

/** Fail closed: profile/interaction load errors propagate (RFC 0004 §6.4). */
async function loadUserContext(
  client: SupabaseClient,
  userId: string,
): Promise<
  { userContext: UserContext; interactionStore: InteractionStore } | undefined
> {
  return loadUserSafetyContext({
    userId,
    createMemoryStore: () =>
      createMemoryStore({ gateway: createSupabaseProfileGateway(client) }),
    createInteractionStore: () => supabaseInteractionStore(client),
  });
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
 * header), not from a client-asserted header. Missing or invalid sessions
 * return 401 before any model call (issue #82 / ADR 0002). The session user
 * identity is verified server-side and never enters model-fillable input.
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
  // ADR 0002 / issue #82: unauthenticated callers must not reach the
  // model path (public endpoint would otherwise burn API credits).
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // RFC 0001: JWT sub must match session.userId before turn assembly.
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

  const sessionUserId = session.userId;

  // ── Build ports ───────────────────────────────────────────────────
  const adapter = new DeepSeekAdapter();
  const tracer = new Tracer();
  const eventLog = new EventLog(sessionUserId);

  // ── Wire Supabase-backed stores and tools ─────────────────────────
  const userClient = createUserSupabase(session.accessToken);
  const proposalStore = createSupabaseProposalStore({
    client: userClient,
  });
  const mealLogStore = createSupabaseMealLogStore(userClient);

  let tools: ReadonlyMap<string, ToolHandler> | undefined;
  if (turnInput.tag === "utterance") {
    const queryRunner =
      process.env.NUTRIBUDDY_QUERY_RUNNER === "sql"
        ? createSupabaseQueryRunner(userClient, catalog)
        : createInMemoryQueryRunner(
            catalog,
            await loadUserMeals(userClient, session.userId),
          );

    tools = buildToolMap(session.userId, proposalStore, queryRunner);
  }

  let userContext: UserContext | undefined;
  let interactionStore: InteractionStore | undefined;
  // Utterance + candidate_log need safety context for proposal-relevant notices.
  // Confirm path only needs proposalStore + session user.
  if (turnInput.tag === "utterance" || turnInput.tag === "candidate_log") {
    try {
      const ctx = await loadUserContext(userClient, session.userId);
      if (ctx) {
        userContext = ctx.userContext;
        interactionStore = ctx.interactionStore;
      }
    } catch (err) {
      // Keep Supabase/DB detail server-side; stable client code only.
      console.error("[chat] safety context load failed", err);
      return new Response(
        JSON.stringify({ error: "safety_context_unavailable" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Phase 6: fail-closed assembly (ConfirmPorts spirit for confirm path)
  const assembly = assembleChatTurnPorts({
    kind: turnInput.tag,
    adapter,
    tracer,
    eventLog,
    sessionUserId,
    history: getRequestHistory(body, turnInput),
    catalog,
    queryCatalog,
    catalogVersion: catalog.snapshot.version,
    proposalStore,
    mealLogStore,
    tools,
    toolSchemas: tools ? toolSchemas : undefined,
    userContext,
    interactionStore,
    requireTools: turnInput.tag === "utterance",
  });

  if (!assembly.ok) {
    const fail = incompleteAssemblyResult(
      assembly.reason,
      turnInput.tag === "proposal_confirm" ? turnInput.proposalId : undefined,
    );
    const encoder = new TextEncoder();
    return new Response(
      encoder.encode(
        JSON.stringify({ type: "terminal", ...fail }) + "\n",
      ),
      {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache, no-store",
        },
      },
    );
  }

  const ports = assembly.ports;

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
