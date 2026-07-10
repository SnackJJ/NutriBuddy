import { type NextRequest } from "next/server";
import { turn, type TurnInput } from "@/harness/turn";
import { DeepSeekAdapter } from "@/harness/modelAdapter";
import { Tracer } from "@/harness/tracer";
import { EventLog } from "@/harness/eventLog";
import { createServerSupabase, createUserSupabase } from "@/lib/supabase";
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
import { createCatalog, SEED_FOODS } from "@/catalog/catalog";
import {
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "@/catalog/queryCatalog";
import { createSupabaseProposalStore } from "@/lib/proposalStore";
import { createSupabaseMealLogStore } from "@/lib/mealLogStore";
import { getUserIdFromHeader } from "@/lib/auth";
import type { ChatMessage, ToolHandler } from "@/harness/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-level catalog (built once at cold start from seed data)
const catalog = createCatalog(SEED_FOODS);
const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
const queryRunner = createInMemoryQueryRunner(catalog);
const toolSchemas = [
  LOG_MEAL_SCHEMA,
  QUERY_CATALOG_SCHEMA,
  SUBMIT_ANSWER_SCHEMA,
] as const;

// ─── Tool wiring ───────────────────────────────────────────────────────

function buildToolMap(
  sessionUserId: string,
  proposalStore: ProposalStore,
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
  userId: string,
): Promise<
  { userContext: UserContext; interactionStore: InteractionStore } | undefined
> {
  try {
    const client = createServerSupabase();
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
  const sessionUserId = await getUserIdFromHeader(createUserSupabase, request);

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
  });

  // ── Wire Supabase-backed stores and tools for authenticated users ─
  if (sessionUserId) {
    const serverClient = createServerSupabase();
    const proposalStore = createSupabaseProposalStore({
      client: serverClient,
    });
    const mealLogStore = createSupabaseMealLogStore(serverClient);

    ports = {
      ...ports,
      proposalStore,
      mealLogStore,
    };

    if (turnInput.tag === "utterance") {
      ports = {
        ...ports,
        tools: buildToolMap(sessionUserId, proposalStore),
        toolSchemas,
      };
    }
  }

  // ── Load user safety context (fail-soft) ──────────────────────────
  if (sessionUserId) {
    const ctx = await loadUserContext(sessionUserId);
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
