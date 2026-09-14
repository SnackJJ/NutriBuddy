import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { SCHEMA_VERSION, turn, type TurnInput } from "@/harness/turn";
import { DeepSeekAdapter } from "@/harness/modelAdapter";
import { Tracer } from "@/harness/tracer";
import { createServerSupabase, createUserSupabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseTraceStore } from "@/harness/supabaseTraceStore";
import { createTurnStream } from "@/lib/turnStream";
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
import { loadPinnedEvidence, type LoadedEvidence } from "@/evidence/registry";
import {
  checkQuota,
  parseQuotaLimits,
  quotaRejectionBody,
  type QuotaLogLine,
  type QuotaFailureLog,
  type QuotaRejection,
} from "@/lib/quota";
import { createSupabaseDailyUsageReader } from "@/lib/dailyUsage";
import {
  buildTurnCostBounds,
  estimateWorstCaseTurnCostUsd,
} from "@/lib/turnCostEstimate";
import {
  assemblePinnedRegion,
  buildTemplatePromptSection,
  DEFAULT_SYSTEM_PROMPT,
} from "@/harness/contextAssembler";
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

// Worst-case single-turn cost bound (RFC 0010 §3.3 T4 / #100).
//
// Measured once, not per request: the pinned region is AOT-stable by design
// (ADD §ContextAssembler), so measuring it again on every request would be work
// whose result cannot change. The bound therefore covers the largest prompt this
// route can assemble — every tool, the whole template catalog — and the
// per-request part added at the gate is only the request's own text.
const turnCostBounds = buildTurnCostBounds({
  pinnedText: assemblePinnedRegion({
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    sqlTemplates: buildTemplatePromptSection(queryCatalog),
    toolDefs: toolSchemas.map((schema) => ({
      name: schema.function.name,
      description: `Callable tool: ${schema.function.name}`,
    })),
  }),
  toolSchemaText: JSON.stringify(toolSchemas),
  catalogSignature: catalog.snapshot.version,
});

const quotaLimits = parseQuotaLimits();

/**
 * The pinned evidence set, loaded once per instance (RFC 0011 §3.7).
 *
 * Once, not per request: the set is byte-stable by design, and the whole point of
 * putting it in the pinned region is that it does not change between turns. A
 * database that cannot be read at cold start leaves the product answering without
 * citable evidence — the pre-S4 behaviour — because "no evidence" is a smaller
 * failure than "evidence nothing checked", and the citation gate fails closed on
 * the same principle.
 */
let evidencePromise: Promise<LoadedEvidence | null> | null = null;

function evidence(): Promise<LoadedEvidence | null> {
  if (!evidencePromise) {
    evidencePromise = (async () => {
      try {
        return await loadPinnedEvidence(createServerSupabase());
      } catch (err) {
        console.error(
          "[chat] evidence registry unavailable; answers will carry no citations",
          err,
        );
        return null;
      }
    })();
  }
  return evidencePromise;
}

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

/**
 * Characters this request adds to the prompt — the only part of the worst-case
 * cost bound the caller controls (the pinned region and the loop's ceilings are
 * fixed). History is the one unbounded field a client can grow, so it is
 * measured here rather than assumed.
 */
function requestChars(body: ChatRequestBody, turnInput: TurnInput): number {
  switch (turnInput.tag) {
    case "utterance": {
      const history = getRequestHistory(body, turnInput) ?? [];
      return (
        turnInput.content.length +
        history.reduce((sum, message) => sum + message.content.length, 0)
      );
    }
    case "proposal_confirm":
      return turnInput.proposalId.length + (turnInput.feedback?.length ?? 0);
    case "candidate_log":
      return turnInput.foodId.length + turnInput.foodName.length;
  }
}

// ─── Turn trace ────────────────────────────────────────────────────────

/**
 * Keeps the invocation alive while the turn drains (RFC 0008 §3.5).
 *
 * `waitUntil` is a no-op outside the Vercel runtime (it calls the request
 * context's hook if there is one), so there is nothing to guard against here:
 * off Vercel the process simply stays alive for the pending work.
 */
function keepAlive(work: Promise<void>): void {
  waitUntil(work);
}

/**
 * Build the trace store for one turn (RFC 0008 §3.2/§3.3).
 *
 * Writes go through the service role because the append RPC's EXECUTE is
 * granted to it alone. A missing service configuration does not take the turn
 * down — the answer is still worth giving — but it is *not* silent: the caller
 * passes `tracePersistFailed: () => true` when this returns undefined, so the
 * client and the report learn that nothing was recorded.
 */
function createTraceStore(userId: string, turnId: string) {
  try {
    return createSupabaseTraceStore({
      client: createServerSupabase(),
      userId,
      turnId,
      log: (message, detail) => console.error(`[trace] ${message}`, detail),
    });
  } catch (err) {
    console.error(
      "[chat] trace store unavailable; this turn will not be persisted",
      err,
    );
    return undefined;
  }
}

/**
 * Crash replies (RFC 0008 §3.6): the cause stays in the server log, and the
 * client gets the harness's generic sentence for it. There is deliberately no
 * per-cause wording here — a missing model key fails in the adapter's
 * constructor, which is before the seam exists, so it never reaches a terminal
 * event to be worded.
 */
function crashReply(error: unknown): string | undefined {
  console.error("[chat] turn crashed", error);
  return undefined;
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

  // Session-scoped client, built once and reused by the quota preflight below
  // (issue #62: identity and every user-data read run under least privilege).
  const userClient = createUserSupabase(session.accessToken);

  // ── Quota preflight (RFC 0010 §3.3) ───────────────────────────────
  //
  // Before any port is assembled, on purpose: a refused request must make no
  // model call and leave no turn row, and the seam must not learn about quota at
  // all — refusal is runtime control, not agent behaviour (§3.3). This is also
  // why the counting read is the trace table the turn itself writes: a refusal
  // happens before that row exists, so it cannot feed the counter that produced
  // it (§5).
  const quotaNow = new Date();
  const usageReader = createSupabaseDailyUsageReader(userClient);
  const quota = await checkQuota({
    userId: sessionUserId,
    path: new URL(request.url).pathname,
    limits: quotaLimits,
    now: quotaNow,
    worstCaseTurnCostUsd: estimateWorstCaseTurnCostUsd({
      bounds: turnCostBounds,
      requestChars: requestChars(body, turnInput),
    }),
    readDailyUsage: (userId, dayStart) =>
      usageReader.readDailyUsage(userId, dayStart),
    // One line per refusal, as JSON so it is greppable and countable without a
    // log parser (§3.4 / #103). The route owns transport vocabulary: the gate
    // takes a log port and never reaches for a console itself.
    logRejection: (line: QuotaLogLine) =>
      console.warn(`[quota] ${JSON.stringify(line)}`),
    logUnavailable: (line: QuotaFailureLog) =>
      console.error(`[quota] ${JSON.stringify(line)}`),
  });

  if (quota.kind === "reject") {
    return new Response(JSON.stringify(quotaRejectionBody(quota.rejection)), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (quota.kind === "unavailable") {
    // Fail closed: a cap that opens when its counting source is down is not a
    // cap. The turn would lose its trace row in this state anyway.
    return new Response(JSON.stringify({ error: "quota_check_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Build ports ───────────────────────────────────────────────────
  const adapter = new DeepSeekAdapter();
  const tracer = new Tracer();
  // Generated here (assembly layer) and bound to the store: the turn itself
  // never holds an id, because seq is allocated inside its generator (§3.2).
  const turnId = randomUUID();
  const trace = createTraceStore(sessionUserId, turnId);

  // ── Wire Supabase-backed stores and tools ─────────────────────────
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

  // Evidence is loaded (once per instance) before assembly: a turn that cites
  // needs both halves — the text the model reads and the set the gate checks.
  const loaded = await evidence();

  // Phase 6: fail-closed assembly (ConfirmPorts spirit for confirm path)
  const assembly = assembleChatTurnPorts({
    kind: turnInput.tag,
    adapter,
    tracer,
    trace,
    crashReply,
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
    evidenceText: loaded?.evidence.text,
    evidenceSet: loaded?.evidence.evidenceSet,
    citationRegistry: loaded?.registry,
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
  // The pump owns the disconnect rule (§3.5): losing the client stops the
  // framing, never the turn — every event still reaches `turn_events`.
  return new Response(
    createTurnStream(turn(turnInput, ports), {
      // Sent before the first event so the page can remember which turn it is
      // watching: that is what makes a refresh mid-turn resumable (RFC 0008 §5).
      meta: { type: "turn_meta", turnId, schema: SCHEMA_VERSION },
      // No store at all is also a lost trace: reporting "false" here would tell
      // the client an unrecorded turn was recorded (RFC 0008 §3.6).
      tracePersistFailed: () => trace?.persistFailed ?? true,
      keepAlive,
      onError: (err) => console.error("[chat] stream failed", err),
      // turn() reports its own failures as a crash terminal, so reaching the
      // error frame means something outside it broke (assembly, or the pump).
      // The missing-key wording lives in `crashReply`, not here.
      errorFrame: (err) => (err instanceof Error ? err.message : "Unknown error"),
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
      },
    },
  );
}
