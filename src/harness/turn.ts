// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type {
  AgentEvent,
  ChatMessage,
  ModelCallUsageTracePayload,
  ModelTier,
  ModelUsage,
  TerminalResult,
  ToolResult,
  TypedOutput,
  WriteProposalData,
} from "./types";
import type { TraceEvent } from "./tracer";
import { checkNumericProvenance } from "./numericProvenanceGate";
import { checkAdvisoryStructure, type Conflict } from "./advisoryGate";
import {
  checkPostGate,
  scanUtteranceForConflicts,
  type UserContext,
} from "./gate";
import type { DrugNutrientInteraction } from "../lib/drugInteractions";
import type { Observation } from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";
import type { MealLogStore, ProposalStore } from "./logMeal";

export type { FoodRef, RuleRef, TypedOutput } from "./types";

/** Bump minor for compatible additions, major for breaking event-shape changes. */
export const SCHEMA_VERSION = "1.5.0";
const QUERY_CATALOG_TOOL = "query_catalog";

export type TurnInput = UtteranceInput | ProposalConfirmInput;

export interface UtteranceInput {
  readonly tag: "utterance";
  readonly content: string;
}

export interface ProposalConfirmInput {
  readonly tag: "proposal_confirm";
  readonly proposalId: string;
  readonly confirmed: boolean;
  readonly feedback?: string;
}

type Clock = () => Date;

/**
 * Confirm/reject short-circuit ports (RFC 0001 Phase 1).
 * Required: proposalStore + sessionUserId only.
 * mealLogStore is NOT on this port — writes go only through proposalStore RPCs.
 */
export interface ConfirmPorts {
  readonly proposalStore: ProposalStore;
  readonly sessionUserId: string;
  readonly clock?: Clock;
}

/**
 * All external dependencies enter through injected ports.
 * Every field is injectable for deterministic scripted testing.
 *
 * Confirm path requires proposalStore + sessionUserId (see ConfirmPorts).
 * Incomplete confirm assemblies throw — no "no store wired" silent pass.
 */
export interface TurnPorts extends Omit<RunTurnInput, "userInput"> {
  readonly clock?: Clock;
  /** Observations from query catalog executions, collected during the turn. */
  readonly observations?: readonly Observation[];
  /** Conflicts detected at the input gate for advisory structure checking. */
  readonly conflicts?: readonly Conflict[];
  /** Proposal store for the confirmation commit path (issue #37 / RFC 0001). */
  readonly proposalStore?: ProposalStore;
  /**
   * Meal ledger store for non-confirm paths. Confirm writes go only through
   * proposalStore.commitProposalAndInsertMeal (RFC 0001 Phase 1).
   */
  readonly mealLogStore?: MealLogStore;
  /** Authenticated user identity — not model-fillable (issue #37). */
  readonly sessionUserId?: string;
  /** Food catalog for input-gate utterance conflict scanning (issue #49). */
  readonly catalog?: Catalog;
  /** Snapshot version of the query catalog used in this turn (issue #51). */
  readonly catalogVersion?: string;
  /** Version of the user profile constraints used in this turn (issue #51). */
  readonly profileVersion?: string;
}

/**
 * Base fields shared by all turn events in the stream.
 * Every event carries the schema version, a monotonic sequence number,
 * and an ISO 8601 timestamp from the injected clock.
 */
export interface TurnEvent {
  readonly schema: string;
  readonly type: string;
  readonly seq: number;
  readonly timestamp: string;
}

/** Gate checkpoints along the turn lifecycle (issue #34). */
export type GateCheckpoint = "input" | "tool" | "output" | "commit";

/** Verdict state for a single gate checkpoint (issue #34). */
export type GateVerdict = "pass" | "block" | "error";

/**
 * Gate verdict event emitted at each turn checkpoint (issue #34 / PRD v2 §2.1).
 *
 * Carries the checkpoint identity, pass/block/error verdict, a stable
 * check name for scorer detection, and a human-readable evidence summary.
 */
export interface TurnGateVerdictEvent extends TurnEvent {
  readonly type: "gate_verdict";
  readonly checkpoint: GateCheckpoint;
  readonly verdict: GateVerdict;
  readonly checkName: string;
  readonly evidence: string;
}

export interface TurnStartEvent extends TurnEvent {
  readonly type: "turn_start";
  readonly input: TurnInput;
  /** Snapshot version of the query catalog used in this turn (issue #51). */
  readonly catalogVersion?: string;
  /** Version of the user profile constraints used in this turn (issue #51). */
  readonly profileVersion?: string;
}

export interface TurnStepEvent extends TurnEvent {
  readonly type: "step";
  readonly agentEvent: AgentEvent;
}

export interface TurnModelCallEvent extends TurnEvent {
  readonly type: "model_call";
  readonly step: number;
  readonly model: ModelTier;
  readonly thinking: boolean;
  /** Token usage from the provider response (issue #51). */
  readonly usage?: ModelUsage;
  /** Round-trip latency in milliseconds (issue #51). */
  readonly latencyMs?: number;
  /** Call cost in USD from usage and the tier pricing table (issue #58). */
  readonly costUsd?: number;
}

export interface TurnEndEvent extends TurnEvent {
  readonly type: "turn_end";
  readonly result: TurnResult;
}

export type AnyTurnEvent =
  | TurnStartEvent
  | TurnStepEvent
  | TurnGateVerdictEvent
  | TurnModelCallEvent
  | TurnEndEvent;

/** Final result emitted in turn_end and returned by the turn generator. */
export type TurnResult = TerminalResult;

export type TurnEventHandler = (event: AnyTurnEvent) => void;

type EventMetadata = Pick<TurnEvent, "schema" | "seq" | "timestamp">;
type NextEventMetadata = () => EventMetadata;
type GateVerdictEventDetails = Pick<
  TurnGateVerdictEvent,
  "checkpoint" | "verdict" | "checkName" | "evidence"
>;
type CommitGateVerdict = Omit<GateVerdictEventDetails, "checkpoint">;

const PRE_GATE_INPUT_CHECK = "pre_gate_input_check";
const COMMIT_GATE_CHECK = "commit_gate_check";
const TOOL_GATE_CHECK = "tool_gate_check";

function createEventMetadata(clock: Clock): NextEventMetadata {
  let seq = 0;

  return () => ({
    schema: SCHEMA_VERSION,
    seq: seq++,
    timestamp: clock().toISOString(),
  });
}

function createTurnStartEvent(
  input: TurnInput,
  ports: TurnPorts,
  nextMetadata: NextEventMetadata,
): TurnStartEvent {
  return {
    ...nextMetadata(),
    type: "turn_start",
    input,
    catalogVersion: ports.catalogVersion,
    profileVersion: ports.profileVersion,
  };
}

function createTurnStepEvent(
  agentEvent: AgentEvent,
  nextMetadata: NextEventMetadata,
): TurnStepEvent {
  return { ...nextMetadata(), type: "step", agentEvent };
}

function createTurnEndEvent(
  result: TurnResult,
  nextMetadata: NextEventMetadata,
): TurnEndEvent {
  return { ...nextMetadata(), type: "turn_end", result };
}

function createGateVerdictEvent(
  details: GateVerdictEventDetails,
  nextMetadata: NextEventMetadata,
): TurnGateVerdictEvent {
  return {
    ...nextMetadata(),
    type: "gate_verdict",
    ...details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isModelTier(value: unknown): value is ModelTier {
  return value === "flash" || value === "pro";
}

function readNumberAlias(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function parseModelUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    promptTokens: readNumberAlias(value, "promptTokens", "prompt_tokens") ?? 0,
    completionTokens:
      readNumberAlias(value, "completionTokens", "completion_tokens") ?? 0,
    totalTokens: readNumberAlias(value, "totalTokens", "total_tokens") ?? 0,
    cacheHitTokens: readNumberAlias(
      value,
      "cacheHitTokens",
      "prompt_cache_hit_tokens",
    ),
    cacheMissTokens: readNumberAlias(
      value,
      "cacheMissTokens",
      "prompt_cache_miss_tokens",
    ),
  };
}

function parseModelCallPayload(
  payload: string,
): ModelCallUsageTracePayload | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.model !== "string" ||
      typeof obj.thinking !== "boolean" ||
      typeof obj.latencyMs !== "number"
    ) {
      return null;
    }

    if (!isModelTier(obj.model)) {
      return null;
    }

    return {
      model: obj.model,
      thinking: obj.thinking,
      latencyMs: obj.latencyMs,
      usage: parseModelUsage(obj.usage) ?? null,
      costUsd: typeof obj.costUsd === "number" ? obj.costUsd : null,
    };
  } catch {
    return null;
  }
}

function findModelCallUsageTrace(
  step: number,
  tracer: TurnPorts["tracer"],
): TraceEvent | undefined {
  const traceEvents = tracer.events();

  for (let index = traceEvents.length - 1; index >= 0; index--) {
    const event = traceEvents[index];
    if (event.type === "model_call_usage" && event.step === step) {
      return event;
    }
  }

  return undefined;
}

function createTurnModelCallEvent(
  step: number,
  tracer: TurnPorts["tracer"],
  nextMetadata: NextEventMetadata,
): TurnModelCallEvent | undefined {
  const usageEvent = findModelCallUsageTrace(step, tracer);
  if (!usageEvent) {
    return undefined;
  }

  const payload = parseModelCallPayload(usageEvent.payload);
  if (!payload) {
    return undefined;
  }

  return {
    ...nextMetadata(),
    type: "model_call",
    step,
    model: payload.model,
    thinking: payload.thinking,
    usage: payload.usage ?? undefined,
    latencyMs: payload.latencyMs,
    costUsd: payload.costUsd ?? undefined,
  };
}

/**
 * Typed handler results the tool gate distinguishes (issue #56):
 * - typed_error: the handler returned a structured error (query_catalog
 *   `{type:"error"}`, log_meal `{error:...}`) — verdict "error".
 * - typed_miss: a resolver miss carrying `match_type: miss_*` — the designed
 *   clarification flow (#44), verdict "pass" with distinguishing evidence.
 */
interface ParsedHandlerResult {
  readonly kind: "typed_error" | "typed_miss";
  readonly message: string;
}

function parseHandlerResult(result: string): ParsedHandlerResult | null {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return null;
    }

    if (parsed.type === "error") {
      const message = readString(parsed, "message");
      return { kind: "typed_error", message: message ?? "typed error result" };
    }

    const error = readString(parsed, "error");
    if (error === undefined) {
      return null;
    }

    const matchType = readString(parsed, "match_type");
    if (matchType?.startsWith("miss_")) {
      return { kind: "typed_miss", message: error };
    }

    return { kind: "typed_error", message: error };
  } catch {
    return null;
  }
}

function createToolGateVerdict(
  toolResult: ToolResult,
): GateVerdictEventDetails {
  if (toolResult.dispatchError) {
    return {
      checkpoint: "tool",
      verdict: "error",
      checkName: TOOL_GATE_CHECK,
      evidence: `Tool ${toolResult.name} dispatch error: ${toolResult.result}`,
    };
  }

  const handlerResult = parseHandlerResult(toolResult.result);

  if (handlerResult?.kind === "typed_error") {
    return {
      checkpoint: "tool",
      verdict: "error",
      checkName: TOOL_GATE_CHECK,
      evidence: `Tool ${toolResult.name} returned a typed error: ${handlerResult.message}`,
    };
  }

  if (handlerResult?.kind === "typed_miss") {
    return {
      checkpoint: "tool",
      verdict: "pass",
      checkName: TOOL_GATE_CHECK,
      evidence: `Tool ${toolResult.name} returned a typed miss (clarification): ${handlerResult.message}`,
    };
  }

  return {
    checkpoint: "tool",
    verdict: "pass",
    checkName: TOOL_GATE_CHECK,
    evidence: `Tool ${toolResult.name} executed successfully`,
  };
}

/** Max retry attempts for the consolidated output gate (issue #47).
 *  All checks — lexical backstop, numeric provenance, advisory structure —
 *  share one regenerate budget. */
const MAX_OUTPUT_GATE_RETRIES = 2;
const OUTPUT_ENTITY_CHECK = "output_entity_check";
const OUTPUT_LEXICAL_BACKSTOP_CHECK = "output_lexical_backstop";
const OUTPUT_NUMERIC_PROVENANCE_CHECK = "output_numeric_provenance";
const OUTPUT_ADVISORY_STRUCTURE_CHECK = "output_advisory_structure";
const OUTPUT_GATE_SUMMARY_CHECK = "post_gate_output_check";
const NO_SAFETY_VIOLATIONS_EVIDENCE = "No safety violations detected";

function buildConsolidatedGateFeedback(reasons: readonly string[]): string {
  return (
    `Your response was BLOCKED by safety checks:\n${reasons.map((r) => `  - ${r}`).join("\n")}\n\n` +
    `Please regenerate your response. Make absolutely sure you do NOT mention ` +
    `or recommend any blocked foods or allergens, all numeric facts come from ` +
    `tool results, and all safety advisories are cited. This is a hard requirement.`
  );
}

function consolidatedGateRefusalReply(reasons: readonly string[]): string {
  const list = reasons.map((r) => `  - ${r}`).join("\n");
  return (
    `I cannot safely answer your question. My responses were blocked ` +
    `after ${MAX_OUTPUT_GATE_RETRIES} retries due to safety constraints:\n${list}\n\n` +
    `Please consult a doctor or registered dietitian for personalized advice.`
  );
}

interface OutputGateCheck {
  readonly verdict: GateVerdictEventDetails;
  readonly reasons: readonly string[];
}

function createOutputGateCheck(
  checkName: string,
  passed: boolean,
  reasons: readonly string[],
  passEvidence: string,
): OutputGateCheck {
  return {
    verdict: {
      checkpoint: "output",
      verdict: passed ? "pass" : "block",
      checkName,
      evidence: reasons.join("; ") || passEvidence,
    },
    reasons: passed ? [] : reasons,
  };
}

function postGateReasonsAfterKnownConflictExemptions(
  reasons: readonly string[],
  knownConflicts: readonly Conflict[],
): readonly string[] {
  const exemptIds = new Set(
    knownConflicts.map((conflict) => conflict.id.toLowerCase()),
  );

  return reasons.filter((reason) => {
    const lowerReason = reason.toLowerCase();
    for (const id of exemptIds) {
      if (lowerReason.includes(id)) {
        return false;
      }
    }
    return true;
  });
}

function knownConflictExemptionEvidence(
  knownConflicts: readonly Conflict[],
): string {
  return `Known descriptive conflict(s) exempted: ${knownConflicts.map((c) => c.id).join(", ")}`;
}

function createLexicalBackstopCheck(
  prose: string,
  userContext: UserContext | undefined,
  interactions: readonly DrugNutrientInteraction[],
  knownConflicts?: readonly Conflict[],
): OutputGateCheck | undefined {
  if (!userContext) {
    return undefined;
  }

  const check = checkPostGate(prose, userContext, interactions);

  if (knownConflicts && knownConflicts.length > 0 && !check.passed) {
    const blockReasons = postGateReasonsAfterKnownConflictExemptions(
      check.reasons,
      knownConflicts,
    );

    if (blockReasons.length === 0) {
      return createOutputGateCheck(
        OUTPUT_LEXICAL_BACKSTOP_CHECK,
        true,
        [],
        knownConflictExemptionEvidence(knownConflicts),
      );
    }

    return createOutputGateCheck(
      OUTPUT_LEXICAL_BACKSTOP_CHECK,
      false,
      blockReasons,
      "",
    );
  }

  return createOutputGateCheck(
    OUTPUT_LEXICAL_BACKSTOP_CHECK,
    check.passed,
    check.reasons,
    NO_SAFETY_VIOLATIONS_EVIDENCE,
  );
}

function createNumericProvenanceCheck(
  output: TypedOutput,
  observations: readonly Observation[],
): OutputGateCheck {
  const check = checkNumericProvenance({ output, observations });
  const passEvidence =
    observations.length > 0
      ? "All numeric facts trace to observations"
      : "No observations to check — numeric gate skipped";

  return createOutputGateCheck(
    OUTPUT_NUMERIC_PROVENANCE_CHECK,
    check.passed,
    check.reasons,
    passEvidence,
  );
}

function findCatalogFoodById(
  catalog: Catalog,
  foodId: string,
): Catalog["allFoods"][number] | undefined {
  return catalog.allFoods.find((food) => food.id === foodId);
}

/**
 * Overwrite model-supplied FoodRef allergens with the catalog's reviewed
 * tags (ADD §Safety Thesis: the model cannot self-report allergen tags).
 * Unknown foodIds pass through unchanged — the entity check blocks them.
 */
function normalizeFoodRefAllergens(
  output: TypedOutput,
  catalog: Catalog,
): TypedOutput {
  return {
    ...output,
    foodRefs: output.foodRefs.map((ref) => {
      const food = findCatalogFoodById(catalog, ref.foodId);
      return food ? { ...ref, allergens: food.allergenTags } : ref;
    }),
  };
}

/**
 * Entity check — output gate check (a) per ADD §Gates: every FoodRef's
 * foodId must exist in the catalog (the model cannot mint ids); catalog
 * allergen tags intersecting profile allergies block; a food without a
 * reviewed tag row is not recommendable (missing tags fail closed).
 * Conflicts the input gate already detected are exempt so descriptive/log
 * and refuse-and-cite flows stay releasable (issue #49/#53 framing).
 */
function createEntityCheck(
  output: TypedOutput,
  catalog: Catalog,
  userContext: UserContext | undefined,
  knownConflicts: readonly Conflict[],
): OutputGateCheck {
  const reasons: string[] = [];
  const allergySet = new Set(
    (userContext?.allergies ?? []).map((allergy) => allergy.toLowerCase()),
  );
  const exemptAllergens = new Set(
    knownConflicts.map((conflict) => conflict.id.toLowerCase()),
  );

  for (const ref of output.foodRefs) {
    const food = findCatalogFoodById(catalog, ref.foodId);
    if (!food) {
      reasons.push(
        `Unknown foodId "${ref.foodId}" — not minted by the catalog resolver`,
      );
      continue;
    }

    // Runtime guard: snapshot-loaded foods may lack a reviewed tag row.
    const tags: readonly string[] | undefined = food.allergenTags;
    if (!tags) {
      reasons.push(
        `Food "${food.canonicalName}" (${food.id}) has no reviewed allergen ` +
          `tags — not recommendable (fail closed)`,
      );
      continue;
    }

    for (const tag of tags) {
      const lowerTag = tag.toLowerCase();
      if (allergySet.has(lowerTag) && !exemptAllergens.has(lowerTag)) {
        reasons.push(
          `FoodRef "${food.canonicalName}" (${food.id}) carries allergen ` +
            `"${tag}" matching a profile allergy`,
        );
      }
    }
  }

  return createOutputGateCheck(
    OUTPUT_ENTITY_CHECK,
    reasons.length === 0,
    reasons,
    output.foodRefs.length === 0
      ? "No foodRefs to check"
      : "All foodRefs resolve to catalog entries with reviewed tags",
  );
}

function createAdvisoryStructureCheck(
  output: TypedOutput,
  conflicts: readonly Conflict[],
): OutputGateCheck {
  const check = checkAdvisoryStructure({ output, conflicts });
  return createOutputGateCheck(
    OUTPUT_ADVISORY_STRUCTURE_CHECK,
    check.passed,
    check.reasons,
    "Advisory structure valid",
  );
}

function outputTextForGate(result: TurnResult): string {
  return result.output?.prose ?? result.reply;
}

function collectOutputGateChecks(
  result: TurnResult,
  userContext: UserContext | undefined,
  observations: readonly Observation[],
  conflicts: readonly Conflict[],
  catalog: Catalog | undefined,
): OutputGateCheck[] {
  const checks: OutputGateCheck[] = [];
  const lexicalCheck = createLexicalBackstopCheck(
    outputTextForGate(result),
    userContext,
    result.interactions ?? [],
    conflicts,
  );

  if (lexicalCheck) {
    checks.push(lexicalCheck);
  }

  if (!result.output) {
    return checks;
  }

  if (catalog) {
    checks.push(
      createEntityCheck(result.output, catalog, userContext, conflicts),
    );
  }

  checks.push(
    createNumericProvenanceCheck(result.output, observations),
    createAdvisoryStructureCheck(result.output, conflicts),
  );
  return checks;
}

function failReasonsFromOutputChecks(
  checks: readonly OutputGateCheck[],
): readonly string[] {
  return checks.flatMap((check) => check.reasons);
}

function createOutputGateBlockedResult(
  result: TurnResult,
  reasons: readonly string[],
): TurnResult {
  return {
    reply: consolidatedGateRefusalReply(reasons),
    steps: result.steps,
    stopReason: "gate_blocked",
  };
}

function isObservationQueryResult(value: unknown): value is {
  readonly type: "observation";
  readonly observation: Observation;
} {
  return (
    isRecord(value) && value.type === "observation" && "observation" in value
  );
}

function parseQueryCatalogObservation(result: string): Observation | null {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isObservationQueryResult(parsed)) {
      return null;
    }

    return parsed.observation;
  } catch {
    return null;
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value;
  }
  return undefined;
}

export function parseWriteProposalData(
  toolResult: string,
): WriteProposalData | undefined {
  try {
    const parsed: unknown = JSON.parse(toolResult);
    if (!isRecord(parsed) || !isRecord(parsed.proposal)) {
      return undefined;
    }

    const proposal = parsed.proposal;
    const proposalId = readString(proposal, "id");
    const foodName = readString(proposal, "food_name");
    const portionG = readNumber(proposal, "portion_g");
    const mealType = readString(proposal, "meal_type");
    if (!proposalId || !foodName || portionG === undefined || !mealType) {
      return undefined;
    }

    const nutrition = isRecord(proposal.nutrition) ? proposal.nutrition : {};
    return {
      proposalId,
      foodId: readString(proposal, "food_id"),
      foodName,
      canonicalName: readString(proposal, "canonical_name"),
      portionG,
      mealType,
      kcal: readNumber(nutrition, "kcal"),
      proteinG: readNumber(nutrition, "protein_g"),
      fatG: readNumber(nutrition, "fat_g"),
      carbsG: readNumber(nutrition, "carbs_g"),
      nutritionSource: readString(proposal, "nutrition_source") ?? "",
      matchType: readString(proposal, "match_type"),
      allergenTags: readStringArray(proposal, "allergen_tags"),
      createdAt: readString(proposal, "created_at") ?? "",
    };
  } catch {
    return undefined;
  }
}

interface UtteranceTurnOutput {
  readonly result: TurnResult;
  readonly writeProposal?: WriteProposalData;
}

async function* runUtteranceTurn(
  input: UtteranceInput,
  ports: TurnPorts,
  nextMetadata: NextEventMetadata,
  inputDirective?: string,
): AsyncGenerator<AnyTurnEvent, UtteranceTurnOutput, undefined> {
  const observations = [...(ports.observations ?? [])];
  const conflicts = ports.conflicts ?? [];
  let result: TurnResult | undefined;
  let lastWriteProposalData: WriteProposalData | undefined;
  let outputGateFailReasons: readonly string[] = [];

  for (let attempt = 0; attempt <= MAX_OUTPUT_GATE_RETRIES; attempt++) {
    const history: ChatMessage[] = [...(ports.history ?? [])];

    // On retry, inject the blocked response and combined feedback as history
    if (attempt > 0 && result) {
      history.push(
        { role: "assistant", content: result.reply },
        {
          role: "user",
          content: buildConsolidatedGateFeedback(outputGateFailReasons),
        },
      );
    }

    const gen = run({
      ...createRunTurnInput(input, ports, inputDirective),
      history,
    });

    const emittedModelCallSteps = new Set<number>();

    let next = await gen.next();
    while (!next.done) {
      yield createTurnStepEvent(next.value, nextMetadata);

      // ── Issue #51: Emit model_call event ───────────────────────────
      // The loop records model_call_usage in the tracer after calling the
      // adapter (between thought and act/observe). We emit the event on
      // the NEXT iteration after the thought, when the usage data is
      // available. Deduped by step number so each model call appears once.
      const mcEvent = createTurnModelCallEvent(
        next.value.step,
        ports.tracer,
        nextMetadata,
      );
      if (mcEvent && !emittedModelCallSteps.has(mcEvent.step)) {
        emittedModelCallSteps.add(mcEvent.step);
        yield mcEvent;
      }

      // Emit tool gate verdict after each tool observation
      if (next.value.type === "observe" && next.value.toolResult) {
        yield createGateVerdictEvent(
          createToolGateVerdict(next.value.toolResult),
          nextMetadata,
        );

        if (next.value.toolResult.name === QUERY_CATALOG_TOOL) {
          const observation = parseQueryCatalogObservation(
            next.value.toolResult.result,
          );
          if (observation) {
            observations.push(observation);
          }
        }

        if (next.value.toolResult.name === "log_meal") {
          lastWriteProposalData = parseWriteProposalData(
            next.value.toolResult.result,
          );
        }
      }

      next = await gen.next();
    }

    result = next.value;

    // ── Issue #54: Catalog-sourced allergen tags ─────────────────────
    // FoodRef allergens in the released output come from the catalog,
    // never from model args.
    if (result.output && ports.catalog) {
      result = {
        ...result,
        output: normalizeFoodRefAllergens(result.output, ports.catalog),
      };
    }

    // ── Issue #47: Consolidated output gate ──────────────────────────
    // All checks (entity, lexical backstop, numeric provenance, advisory
    // structure) run together at the turn boundary with one retry budget
    // and one combined feedback message. The inner loop no longer re-gates.

    const outputGateChecks = collectOutputGateChecks(
      result,
      ports.userContext,
      observations,
      conflicts,
      ports.catalog,
    );

    for (const check of outputGateChecks) {
      yield createGateVerdictEvent(check.verdict, nextMetadata);
    }

    outputGateFailReasons = failReasonsFromOutputChecks(outputGateChecks);

    if (outputGateFailReasons.length === 0) {
      break;
    }

    if (attempt < MAX_OUTPUT_GATE_RETRIES) {
      continue;
    }

    result = createOutputGateBlockedResult(
      result,
      outputGateFailReasons,
    );
    break;
  }

  return { result: result!, writeProposal: lastWriteProposalData };
}

function createRunTurnInput(
  input: UtteranceInput,
  ports: TurnPorts,
  inputDirective?: string,
): RunTurnInput {
  return {
    userInput: input.content,
    inputDirective,
    userId: ports.userId,
    adapter: ports.adapter,
    tracer: ports.tracer,
    eventLog: ports.eventLog,
    history: ports.history,
    systemPrompt: ports.systemPrompt,
    tier: ports.tier,
    thinking: ports.thinking,
    maxSteps: ports.maxSteps,
    signal: ports.signal,
    tools: ports.tools,
    toolSchemas: ports.toolSchemas,
    userContext: ports.userContext,
    interactionStore: ports.interactionStore,
    queryCatalog: ports.queryCatalog,
    clock: ports.clock,
  };
}


/** Return value of handleProposalConfirm — carries the turn result plus commit gate details. */
interface ProposalConfirmOutcome {
  result: TurnResult;
  commitVerdict: CommitGateVerdict;
}

const NOT_COMMITTABLE = "not_committable";

function createProposalConfirmResult(input: ProposalConfirmInput): TurnResult {
  return createEndTurnResult(createProposalConfirmReply(input));
}

function createEndTurnResult(reply: string): TurnResult {
  return {
    reply,
    steps: 0,
    stopReason: "end_turn",
  };
}

function createProposalConfirmReply(input: ProposalConfirmInput): string {
  if (!input.confirmed) {
    return `Proposal ${input.proposalId} rejected.`;
  }

  const feedback = input.feedback ? ` ${input.feedback}` : "";
  return `Proposal ${input.proposalId} confirmed.${feedback}`;
}

function createProposalConfirmOutcome(
  result: TurnResult,
  verdict: GateVerdict,
  evidence: string,
  checkName: string = COMMIT_GATE_CHECK,
): ProposalConfirmOutcome {
  return {
    result,
    commitVerdict: {
      verdict,
      checkName,
      evidence,
    },
  };
}

/**
 * Require ConfirmPorts fields. Incomplete assembly is unrepresentable —
 * throw rather than silent "no store wired" pass (RFC 0001 F1 / C1).
 */
function requireConfirmPorts(ports: TurnPorts): ConfirmPorts {
  if (!ports.proposalStore || !ports.sessionUserId) {
    throw new Error(
      "ConfirmPorts incomplete: proposalStore and sessionUserId are required",
    );
  }
  return {
    proposalStore: ports.proposalStore,
    sessionUserId: ports.sessionUserId,
    clock: ports.clock,
  };
}

/**
 * Handle a proposal confirmation turn input (RFC 0001 Phase 1).
 *
 * Short-circuits the model. Ownership and status are decided solely by the
 * store discriminant (kind) — no pre-RPC get-then-branch. mealLogStore is
 * not used; writes go only through commitProposalAndInsertMeal / voidProposal.
 */
async function handleProposalConfirm(
  input: ProposalConfirmInput,
  ports: TurnPorts,
): Promise<ProposalConfirmOutcome> {
  const { proposalId, confirmed } = input;
  const { proposalStore } = requireConfirmPorts(ports);

  if (confirmed) {
    const outcome = await proposalStore.commitProposalAndInsertMeal(proposalId);
    switch (outcome.kind) {
      case "committed":
        return createProposalConfirmOutcome(
          createProposalConfirmResult(input),
          "pass",
          `Proposal ${proposalId} committed — meal ledger row ${outcome.mealLogId}`,
        );
      case "not_committable":
        return createProposalConfirmOutcome(
          createEndTurnResult(`Proposal ${proposalId} cannot be committed.`),
          "block",
          NOT_COMMITTABLE,
          NOT_COMMITTABLE,
        );
      case "error":
        return createProposalConfirmOutcome(
          createEndTurnResult(`Proposal ${proposalId} commit failed.`),
          "error",
          outcome.cause,
        );
    }
  }

  const outcome = await proposalStore.voidProposal(proposalId);
  switch (outcome.kind) {
    case "voided":
      return createProposalConfirmOutcome(
        createProposalConfirmResult(input),
        "pass",
        `Proposal ${proposalId} explicitly rejected by user`,
      );
    case "not_committable":
      return createProposalConfirmOutcome(
        createEndTurnResult(`Proposal ${proposalId} cannot be voided.`),
        "block",
        NOT_COMMITTABLE,
        NOT_COMMITTABLE,
      );
    case "error":
      // Fail closed: do not claim rejected/voided (RFC 0001 F3).
      return createProposalConfirmOutcome(
        createEndTurnResult(`Proposal ${proposalId} void failed.`),
        "error",
        outcome.cause,
      );
  }
}

function createOutputEvidence(result: TurnResult): string {
  if (result.stopReason === "gate_blocked") {
    return "Output blocked by consolidated safety gate";
  }

  if (result.stopReason === "write_proposal") {
    return "Write proposal emitted — awaiting user confirmation";
  }

  return "Output passed safety checks";
}

function createCommitGateDetails(
  result: TurnResult,
  writeProposal: WriteProposalData | undefined,
  outputEvidence: string,
  confirmCommitVerdict: CommitGateVerdict | undefined,
): GateVerdictEventDetails {
  if (confirmCommitVerdict) {
    return { checkpoint: "commit", ...confirmCommitVerdict };
  }

  if (result.stopReason === "gate_blocked") {
    return {
      checkpoint: "commit",
      verdict: "block",
      checkName: COMMIT_GATE_CHECK,
      evidence: outputEvidence,
    };
  }

  if (result.stopReason === "write_proposal") {
    return {
      checkpoint: "commit",
      verdict: "pass",
      checkName: COMMIT_GATE_CHECK,
      evidence: `Proposal ${writeProposal?.proposalId ?? ""} stored — no meal ledger mutation occurred`,
    };
  }

  return {
    checkpoint: "commit",
    verdict: "pass",
    checkName: COMMIT_GATE_CHECK,
    evidence: "Response committed successfully",
  };
}

/**
 * Input gate outcome (issue #53 / ADD §Gates): the gate steers and never
 * blocks alone. On a hit it carries a directive for the model context —
 * refuse-and-cite for prescriptive asks, advise for descriptive mentions —
 * and the conflicts that activate the advisory gate and the lexical
 * backstop's known-conflict exemption. Detection is deterministic;
 * framing and explanation belong to the model.
 */
interface InputGateDecision {
  readonly directive?: string;
  readonly conflicts: readonly Conflict[];
  readonly verdict: GateVerdictEventDetails;
}

function createAcceptedInputGateDecision(): InputGateDecision {
  return {
    conflicts: [],
    verdict: {
      checkpoint: "input",
      verdict: "pass",
      checkName: PRE_GATE_INPUT_CHECK,
      evidence: "Input accepted for processing",
    },
  };
}

function conflictSummary(
  conflicts: readonly Conflict[],
  hitFoods: readonly string[],
): string {
  return (
    `${conflicts.map((conflict) => conflict.id).join(", ")} ` +
    `(foods: ${hitFoods.join(", ")})`
  );
}

function refuseAndCiteDirective(
  conflicts: readonly Conflict[],
  hitFoods: readonly string[],
): string {
  return (
    `[INPUT GATE DIRECTIVE — REFUSE AND CITE]\n` +
    `The user is asking for a recommendation involving foods that conflict ` +
    `with their allergies: ${conflictSummary(conflicts, hitFoods)}. ` +
    `Do NOT recommend these foods. Refuse this part of the request, cite the ` +
    `specific allergy conflict as the reason, and suggest consulting a doctor ` +
    `or registered dietitian. You may name the conflicting food and allergy ` +
    `when explaining the refusal.`
  );
}

function adviseDirective(
  conflicts: readonly Conflict[],
  hitFoods: readonly string[],
): string {
  return (
    `[INPUT GATE DIRECTIVE — ADVISE]\n` +
    `The user is describing or logging foods that conflict with their ` +
    `allergies: ${conflictSummary(conflicts, hitFoods)}. ` +
    `Proceed with the request — the meal ledger records what the user ` +
    `actually ate — but include a clear advisory noting the allergy ` +
    `conflict and cite the applicable safety rule.`
  );
}

function createInputGateDecision(
  input: TurnInput,
  ports: TurnPorts,
): InputGateDecision {
  if (input.tag !== "utterance" || !ports.catalog || !ports.userContext) {
    return createAcceptedInputGateDecision();
  }

  const scan = scanUtteranceForConflicts(
    input.content,
    ports.catalog,
    ports.userContext,
  );

  if (scan.conflicts.length === 0) {
    return createAcceptedInputGateDecision();
  }

  if (scan.intent === "prescriptive") {
    return {
      directive: refuseAndCiteDirective(scan.conflicts, scan.hitFoods),
      conflicts: scan.conflicts,
      verdict: {
        checkpoint: "input",
        verdict: "pass",
        checkName: PRE_GATE_INPUT_CHECK,
        evidence:
          `Hit (prescriptive): request conflicts with user allergies — ` +
          `${conflictSummary(scan.conflicts, scan.hitFoods)}. ` +
          `Refuse-and-cite directive injected.`,
      },
    };
  }

  return {
    directive: adviseDirective(scan.conflicts, scan.hitFoods),
    conflicts: scan.conflicts,
    verdict: {
      checkpoint: "input",
      verdict: "pass",
      checkName: PRE_GATE_INPUT_CHECK,
      evidence:
        `Hit (descriptive): detected ${scan.conflicts.length} conflict(s) — ` +
        `${conflictSummary(scan.conflicts, scan.hitFoods)}. ` +
        `Advise directive injected; advisory gate will enforce ruleRefs.`,
    },
  };
}

function createOutputGateSummaryDetails(
  result: TurnResult,
  outputEvidence: string,
): GateVerdictEventDetails {
  return {
    checkpoint: "output",
    verdict: result.stopReason === "gate_blocked" ? "block" : "pass",
    checkName: OUTPUT_GATE_SUMMARY_CHECK,
    evidence: outputEvidence,
  };
}

/**
 * The single harness entry point for running one turn.
 *
 * Takes tagged input (utterance or proposal confirmation) and injected
 * ports, and yields a schema-versioned typed event stream that ALWAYS
 * ends with exactly one {@link TurnEndEvent}.
 *
 * The returned async generator also returns a {@link TurnResult} as its
 * final value; consumers can use either the terminal event or the
 * generator return value.
 */
export async function* turn(
  input: TurnInput,
  ports: TurnPorts,
): AsyncGenerator<AnyTurnEvent, TurnResult, undefined> {
  if (ports.signal?.aborted) {
    throw new Error("turn aborted before start");
  }

  const nextMetadata = createEventMetadata(ports.clock ?? (() => new Date()));

  yield createTurnStartEvent(input, ports, nextMetadata);

  const inputGate = createInputGateDecision(input, ports);
  yield createGateVerdictEvent(inputGate.verdict, nextMetadata);

  let result: TurnResult;
  let writeProposal: WriteProposalData | undefined;
  let confirmCommitVerdict: CommitGateVerdict | undefined;

  const mergedPorts: TurnPorts = {
    ...ports,
    conflicts: [...inputGate.conflicts, ...(ports.conflicts ?? [])],
  };

  switch (input.tag) {
    case "utterance": {
      const utteranceOutput = yield* runUtteranceTurn(
        input,
        mergedPorts,
        nextMetadata,
        inputGate.directive,
      );
      result = utteranceOutput.result;
      writeProposal = utteranceOutput.writeProposal;
      break;
    }
    case "proposal_confirm": {
      const outcome = await handleProposalConfirm(input, ports);
      result = outcome.result;
      confirmCommitVerdict = outcome.commitVerdict;
      break;
    }
  }

  if (writeProposal && result.stopReason !== "gate_blocked") {
    result = {
      ...result,
      stopReason: "write_proposal",
      proposal: writeProposal,
    };
  }

  const isGateBlocked = result.stopReason === "gate_blocked";
  const outputEvidence = createOutputEvidence(result);

  if (input.tag === "utterance") {
    yield createGateVerdictEvent(
      createOutputGateSummaryDetails(result, outputEvidence),
      nextMetadata,
    );
  }

  const commitGateDetails = createCommitGateDetails(
    result,
    writeProposal,
    outputEvidence,
    confirmCommitVerdict,
  );

  yield createGateVerdictEvent(commitGateDetails, nextMetadata);

  yield createTurnEndEvent(result, nextMetadata);

  return result;
}

export async function consumeTurn(
  stream: AsyncGenerator<AnyTurnEvent, TurnResult, undefined>,
  onEvent?: TurnEventHandler,
): Promise<TurnResult> {
  let next = await stream.next();

  while (!next.done) {
    onEvent?.(next.value);
    next = await stream.next();
  }

  return next.value;
}
