import { type NextRequest } from "next/server";
import { turn, type TurnInput } from "@/harness/turn";
import { DeepSeekAdapter } from "@/harness/modelAdapter";
import { Tracer } from "@/harness/tracer";
import { EventLog } from "@/harness/eventLog";
import { createServerSupabase } from "@/lib/supabase";
import {
  createMemoryStore,
  createSupabaseProfileGateway,
} from "@/lib/memoryStore";
import { supabaseInteractionStore } from "@/lib/drugInteractions";
import type { UserContext } from "@/harness/gate";
import type { InteractionStore } from "@/lib/drugInteractions";
import {
  SESSION_USER_ID_HEADER,
  parseChatBody,
  buildChatTurnPorts,
  type ChatRequestBody,
} from "@/lib/chatApi";
import { createLogMealHandler, LOG_MEAL_SCHEMA } from "@/harness/logMeal";
import { SUBMIT_ANSWER_SCHEMA } from "@/harness/submitAnswer";
import {
  createQueryCatalogHandler,
  createInMemoryQueryRunner,
  QUERY_CATALOG_SCHEMA,
} from "@/harness/queryCatalog";
import { createCatalog, SEED_FOODS } from "@/catalog/catalog";
import {
  createQueryCatalog,
  FOOD_LOOKUP_TEMPLATE,
} from "@/catalog/queryCatalog";
import type { ChatMessage, ToolHandler } from "@/harness/types";
import type {
  ProposalStore,
  Proposal,
  ProposalInput,
  MealLogStore,
  MealLogEntry,
  MealLogInsert,
} from "@/harness/logMeal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── In-memory proposal store (M1 — replaces with Supabase in M2) ───────

interface MemStoreState {
  proposals: Proposal[];
  ledger: MealLogEntry[];
}

function transitionProposal(
  state: MemStoreState,
  id: string,
  status: "committed" | "rejected",
): Proposal {
  const index = state.proposals.findIndex((proposal) => proposal.id === id);
  if (index === -1) {
    throw new Error(`Proposal ${id} not found`);
  }

  const proposal = state.proposals[index];
  if (proposal.status !== "proposed") {
    throw new Error(`Proposal ${id} is ${proposal.status}`);
  }

  const nextProposal: Proposal = { ...proposal, status };
  state.proposals[index] = nextProposal;
  return nextProposal;
}

function createMemProposalStore(state: MemStoreState): ProposalStore {
  let nextId = 1000;

  return {
    async store(params: ProposalInput): Promise<Proposal> {
      const id = `proposal-${(nextId++).toString().padStart(4, "0")}`;
      const proposal: Proposal = {
        id,
        userId: params.userId,
        foodId: params.foodId,
        foodName: params.foodName,
        canonicalName: params.canonicalName,
        portionG: params.portionG,
        mealType: params.mealType,
        kcal: params.kcal,
        proteinG: params.proteinG,
        fatG: params.fatG,
        carbsG: params.carbsG,
        nutritionSource: params.nutritionSource,
        matchType: params.matchType,
        allergenTags: params.allergenTags,
        status: "proposed",
        createdAt: new Date().toISOString(),
      };
      state.proposals.push(proposal);
      return proposal;
    },
    async get(id: string): Promise<Proposal | undefined> {
      return state.proposals.find((p) => p.id === id);
    },
    async commit(id: string): Promise<Proposal> {
      return transitionProposal(state, id, "committed");
    },
    async decline(id: string): Promise<Proposal> {
      return transitionProposal(state, id, "rejected");
    },
  };
}

function createMemMealLogStore(state: MemStoreState): MealLogStore {
  return {
    async insert(params: MealLogInsert): Promise<MealLogEntry> {
      const entry: MealLogEntry = {
        id: state.ledger.length + 1,
        userId: params.userId,
        foodName: params.foodName,
        portionG: params.portionG,
        mealType: params.mealType,
        loggedAt: new Date().toISOString(),
        kcal: params.kcal,
        proteinG: params.proteinG,
        fatG: params.fatG,
        carbsG: params.carbsG,
        proposalId: params.proposalId,
      };
      state.ledger.push(entry);
      return entry;
    },
  };
}

// Module-level state (resets on cold start; M2 replaces with Supabase)
const memState: MemStoreState = { proposals: [], ledger: [] };
const memProposalStore = createMemProposalStore(memState);
const memMealLogStore = createMemMealLogStore(memState);

// Module-level catalogs (built once at cold start from seed data)
const catalog = createCatalog(SEED_FOODS);
const queryCatalog = createQueryCatalog([FOOD_LOOKUP_TEMPLATE]);

// ─── Tool wiring ───────────────────────────────────────────────────────

function buildToolMap(sessionUserId: string): ReadonlyMap<string, ToolHandler> {
  const logMealHandler = createLogMealHandler({
    catalog,
    proposalStore: memProposalStore,
    userId: sessionUserId,
  });

  const queryCatalogHandler = createQueryCatalogHandler({
    queryCatalog,
    runner: createInMemoryQueryRunner(catalog),
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
 * The session user identity is read from the X-User-Id header — never
 * from the model-fillable request body.
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

  // ── Extract session user identity from header ─────────────────────
  const sessionUserId =
    request.headers.get(SESSION_USER_ID_HEADER)?.trim() || undefined;

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

  if (sessionUserId) {
    ports = {
      ...ports,
      proposalStore: memProposalStore,
      mealLogStore: memMealLogStore,
    };
  }

  // ── Wire tools for authenticated utterance turns ─────────────────
  if (turnInput.tag === "utterance" && sessionUserId) {
    ports = {
      ...ports,
      tools: buildToolMap(sessionUserId),
      toolSchemas: [LOG_MEAL_SCHEMA, QUERY_CATALOG_SCHEMA, SUBMIT_ANSWER_SCHEMA],
      queryCatalog,
    };
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
