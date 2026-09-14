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
import { projectProposalSafetyNotices } from "../lib/proposalSafety";
import {
  projectResolverMiss,
  type ResolverMissProjection,
} from "../lib/resolverMiss";
import type { Observation } from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";
import {
  storeProposalFromParsed,
  type MealLogStore,
  type ProposalStore,
} from "./logMeal";
import {
  handleProposalConfirm,
  type ProposalConfirmOutcome,
} from "./proposalConfirm";
import {
  toolGateFromOutcome,
  type ToolOutcome,
} from "./toolOutcome";
import type { TraceStore } from "./traceStore";
import {
  checkCitations,
  citationEvidence,
  stripInvalidCitations,
  type CitationRegistry,
} from "./citationGate";
import { checkCitationAssertions } from "./citationAssertion";

export type { FoodRef, RuleRef, TypedOutput } from "./types";

/**
 * Bump minor for compatible additions, major for breaking event-shape changes.
 *
 * 1.10.0 adds two optional fields (RFC 0011 §3.3/§3.4): `TypedOutput.citations`
 * and `TurnStartEvent.evidenceSet`. Both are additive, so a reader of 1.9.0
 * events stays correct — which is the point of the minor bump and the reason the
 * new fields land *before* the assertions that use them.
 */
export const SCHEMA_VERSION = "1.10.0";
const QUERY_CATALOG_TOOL = "query_catalog";
const CONFIRM_PORTS_INCOMPLETE = "confirm_ports_incomplete";

export type TurnInput =
  | UtteranceInput
  | ProposalConfirmInput
  | CandidateLogInput;

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

/** Deterministic log from a resolver candidate pick (RFC 0004 §6.1). No model. */
export interface CandidateLogInput {
  readonly tag: "candidate_log";
  readonly foodId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
}

type Clock = () => Date;

/**
 * Confirm/reject short-circuit ports (RFC 0001 §3 / issue #73).
 * Required: proposalStore + sessionUserId only.
 * mealLogStore is NOT on this port — writes go only through proposalStore RPCs.
 */
export interface ConfirmPorts {
  readonly kind: "confirm";
  readonly proposalStore: ProposalStore;
  readonly sessionUserId: string;
  readonly clock?: Clock;
}

/**
 * All external dependencies enter through injected ports.
 * Every field is injectable for deterministic scripted testing.
 *
 * Confirm short-circuit requires a resolved {@link ConfirmPorts}
 * (`kind: "confirm"` + required fields). Incomplete confirm assemblies
 * fail closed on the seam with a terminal event — never silent pass,
 * never mid-stream throw (issue #73 / F1).
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
  /**
   * Evidence the turn may cite (RFC 0011 §3.4). Absent means "no corpus is
   * wired", which the citation gate reads as fail-closed: no citation is legal
   * in a turn whose evidence set nobody recorded.
   */
  readonly evidenceSet?: TurnEvidenceSet;
  /**
   * The evidence text that goes into the pinned region (RFC 0011 §3.7). Kept
   * next to `evidenceSet` because they are two views of one thing: what the model
   * sees, and what the gate will allow it to cite. Wiring one without the other
   * produces either unciteable evidence or citable text the model never read.
   */
  readonly evidenceText?: string;
  /**
   * Registry lookup for the citation check (RFC 0011 §3.5). Absent means the
   * registry is unavailable, which the gate reads as fail-closed: no citation
   * survives a turn that could not check it.
   */
  readonly citationRegistry?: CitationRegistry;
  /**
   * Trace port (RFC 0008 §3.2). turn() appends every event before yielding it,
   * which is the only place the stream can be persisted in seq order: seq is
   * allocated inside the generator and the terminal event must carry a legal
   * one. Absent for CLI/tests.
   */
  readonly trace?: TraceStore;
  /**
   * Fatal-error policy (RFC 0008 §3.6): the reply a crash terminal shows, and
   * — because the assembly layer owns this callback — the place the cause gets
   * reported. The harness itself stays free of logging and of transport
   * vocabulary; returning undefined falls back to a generic sentence, since a
   * crash reply is never the place to leak adapter or database internals.
   */
  readonly crashReply?: (error: unknown) => string | undefined;
}

/**
 * Build a typed ConfirmPorts from a TurnPorts bag when both required
 * confirm fields are present. Returns undefined when incomplete (issue #73).
 */
export function resolveConfirmPorts(
  ports: TurnPorts,
): ConfirmPorts | undefined {
  if (!ports.proposalStore || !ports.sessionUserId) {
    return undefined;
  }
  return {
    kind: "confirm",
    proposalStore: ports.proposalStore,
    sessionUserId: ports.sessionUserId,
    clock: ports.clock,
  };
}

/** Fail-closed terminal for incomplete confirm assembly (issue #73 / F1). */
function incompleteConfirmOutcome(
  input: ProposalConfirmInput,
): ProposalConfirmOutcome {
  return {
    result: {
      reply: `Proposal ${input.proposalId} cannot be processed: ConfirmPorts incomplete.`,
      steps: 0,
      stopReason: "crash",
    },
    commitVerdict: {
      verdict: "error",
      checkName: CONFIRM_PORTS_INCOMPLETE,
      evidence:
        "ConfirmPorts incomplete: proposalStore and sessionUserId are required",
    },
  };
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
  /** Stable tool-gate reason code (RFC 0002); required for checkpoint "tool". */
  readonly reasonCode?: string;
  /**
   * Whether this block ends the turn's attempt budget (RFC 0011 §3.5).
   *
   * A citation that failed provenance is stripped and earns a `block` verdict —
   * but it must **not** consume the shared regenerate budget: the answer's numbers
   * and allergens are unaffected by a bad citation, and refusing it entirely would
   * be the failure mode the RFC's severity split exists to avoid. Recording that
   * distinction as data (instead of "checkName happens to be citation_provenance")
   * is what keeps a future implementer from wiring the wrong tier into the budget.
   */
  readonly terminal?: boolean;
}

/**
 * The evidence a turn was allowed to cite (RFC 0011 §3.4).
 *
 * Recorded on the turn rather than kept in memory because two things depend on it
 * being replayable: the citation gate checks membership against it, and a replay
 * of an old turn has to be able to recompute that verdict offline. It is also the
 * field V1.1's retrieval results fold into, without the gate's meaning changing.
 */
export interface TurnEvidenceSet {
  /** Corpus snapshot version, so a trace names the corpus it was judged against. */
  readonly sourceVersion: string;
  /** Section ids available this turn: V1.0's pinned set, later retrieval hits too. */
  readonly sectionIds: readonly string[];
}

export interface TurnStartEvent extends TurnEvent {
  readonly type: "turn_start";
  readonly input: TurnInput;
  /** Snapshot version of the query catalog used in this turn (issue #51). */
  readonly catalogVersion?: string;
  /** Version of the user profile constraints used in this turn (issue #51). */
  readonly profileVersion?: string;
  /** Evidence available to this turn; absent when no corpus is wired. */
  readonly evidenceSet?: TurnEvidenceSet;
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
  "checkpoint" | "verdict" | "checkName" | "evidence" | "reasonCode" | "terminal"
>;
type CommitGateVerdict = Omit<GateVerdictEventDetails, "checkpoint">;

const PRE_GATE_INPUT_CHECK = "pre_gate_input_check";
const COMMIT_GATE_CHECK = "commit_gate_check";

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
    // Omitted rather than defaulted to an empty set: "no evidence was assembled"
    // and "evidence was assembled and it was empty" are different, and only the
    // second one is a configured turn.
    ...(ports.evidenceSet ? { evidenceSet: ports.evidenceSet } : {}),
  };
}

function createTurnStepEvent(
  agentEvent: AgentEvent,
  nextMetadata: NextEventMetadata,
): TurnStepEvent {
  return { ...nextMetadata(), type: "step", agentEvent };
}

/**
 * Deterministic sentences for the terminals that have nothing to say.
 *
 * Live baselines produced `turn_end` events with `reply: ""` for `max_steps` and
 * for a `write_proposal` that never carried a proposal. The trace was correct and
 * the user saw nothing at all — a terminal that exists for the audit and says
 * nothing to the person waiting on it (issue #126).
 *
 * These are the harness's own words, not the model's: they say what happened and
 * what to do next, and they claim nothing about the food. Wording rules follow
 * the rest of the file — no internals, no numbers, no advice.
 */
const EMPTY_REPLY_FALLBACK: Record<TurnResult["stopReason"], string> = {
  end_turn:
    "I could not put an answer together for that. Try rephrasing it, or ask about one thing at a time.",
  max_steps:
    "I ran out of steps before I could answer that. Nothing was written. Try a narrower question — one food or one meal at a time.",
  aborted: "That request was interrupted, so I did not finish. Nothing was written.",
  gate_blocked:
    "I cannot answer that one safely, so I have not. Nothing was written.",
  write_proposal:
    "I could not prepare a logging proposal for that, so nothing was written. Try telling me the food and the portion.",
  crash:
    "Something went wrong while I was working on that. Nothing was written; please try again.",
};

/**
 * Every terminal carries a reply a user can read.
 *
 * Applied at the single place the terminal result is constructed, so it holds for
 * the loop's own terminals and for the crash path alike — and only when the
 * existing reply is empty, because a model that said something keeps its words.
 */
function withReadableReply(result: TurnResult): TurnResult {
  if (result.reply.trim().length > 0) return result;
  return { ...result, reply: EMPTY_REPLY_FALLBACK[result.stopReason] };
}

function createTurnEndEvent(
  result: TurnResult,
  nextMetadata: NextEventMetadata,
): TurnEndEvent {
  return { ...nextMetadata(), type: "turn_end", result: withReadableReply(result) };
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

function createToolGateVerdict(outcome: ToolOutcome): GateVerdictEventDetails {
  return toolGateFromOutcome(outcome);
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
/**
 * Tier-1 verdict name (RFC 0011 §3.5). It carries `terminal: false`, which is how
 * the regenerate budget knows to ignore it.
 */
const OUTPUT_CITATION_PROVENANCE_CHECK = "citation_provenance";
/**
 * Tier-2 verdict name: a block that **does** feed the regenerate budget, because
 * an answer that claims authority without naming a source has to be rewritten
 * rather than trimmed (RFC 0011 §3.5/§3.6).
 */
const OUTPUT_CITATION_ASSERTION_CHECK = "citation_assertion";
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

/**
 * Cues that decide whether a mention sits in a recommendation or in a warning.
 *
 * This is the difference between an answer that says "shrimp is fine for you"
 * and one that says "shrimp is off the table — you are allergic to shellfish".
 * Both name the allergen; only one of them is the failure the path exists to
 * prevent (issue #127, found by the live baseline's d2). A blanket exemption let
 * both through; a blanket block would refuse every correct refusal, which costs
 * two regenerations and hands the user a worse answer for doing the right thing.
 *
 * Deterministic and lexical, like the backstop it feeds — the same family as the
 * rest of the output checks, not a second judge. #128 (assertion phrases) is the
 * general form of this check; this is the narrow version the allergen path needs
 * now.
 */
/**
 * A recommendation that is being refused: "I can't recommend shrimp".
 *
 * Checked before the recommendation cues, because the word "recommend" appears
 * in the most common correct refusal, and reading it as a recommendation would
 * block exactly the answers the refuse-and-cite path is trying to produce.
 */
const NEGATED_RECOMMENDATION =
  /\b(can't|cannot|won't|will not|don't|do not|wouldn't|shouldn't|not able to)\s+(\w+\s+){0,2}recommend\b/;

const RECOMMENDATION_CUES: readonly RegExp[] = [
  /\bis (fine|ok|okay|safe|healthy|good)\b/,
  /\byou (can|may|should) (eat|have|try|enjoy|include)\b/,
  /\brecommend\b/,
  /\bgo ahead\b/,
  /\benjoy\b/,
  /\bsafe (for you|to eat|to have)\b/,
  /\bgood (choice|option|idea)\b/,
  /\bfine to eat\b/,
];

const REFUSAL_CUES: readonly RegExp[] = [
  /\bavoid\b/,
  /\bdo not\b|\bdon't\b/,
  /\bcannot\b|\bcan't\b|\bwon't\b|\bwill not\b/,
  /\bnot (safe|recommended|advisable|a good)\b/,
  /\boff the table\b/,
  /\ballerg/,
  /\brisk\b/,
  /\bstay away\b/,
  /\brefrain\b/,
];

function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function mentionsTerm(sentence: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(sentence);
}

type MentionFrame = "recommendation" | "warning" | "unknown";

/**
 * What one sentence is doing with the food it names.
 *
 * Order matters: a negated recommendation is a warning, and an unrecognised
 * sentence is `unknown` rather than a pass — the permissive direction is the one
 * this check exists to close.
 */
function classifySentence(sentence: string): MentionFrame {
  if (NEGATED_RECOMMENDATION.test(sentence)) return "warning";
  if (RECOMMENDATION_CUES.some((cue) => cue.test(sentence))) return "recommendation";
  if (REFUSAL_CUES.some((cue) => cue.test(sentence))) return "warning";
  return "unknown";
}

/**
 * True when every sentence that names the food or the allergen is a warning.
 *
 * "Every" is the strict reading on purpose: one recommendation sentence is enough
 * to keep the mention unexempted, and an answer that both warns and recommends
 * has recommended.
 */
function mentionIsWarning(prose: string, conflict: Conflict): boolean {
  const terms = [conflict.id, ...(conflict.foods ?? [])].filter(
    (term) => term.length > 0,
  );
  const mentioning = sentenceSplit(prose).filter((sentence) =>
    terms.some((term) => mentionsTerm(sentence, term)),
  );
  if (mentioning.length === 0) return false;
  return mentioning.every((sentence) => classifySentence(sentence) === "warning");
}

/** The conflicts whose mentions this answer is allowed to keep. */
function exemptibleConflicts(
  prose: string,
  knownConflicts: readonly Conflict[],
): readonly string[] {
  return knownConflicts
    .filter((conflict) => {
      if (conflict.intent === "descriptive") return true;
      if (conflict.intent === "prescriptive") return mentionIsWarning(prose, conflict);
      return false;
    })
    .map((conflict) => conflict.id);
}

/**
 * Drop the reasons that name a conflict the output checks are allowed to ignore.
 *
 * Allowed means the mention is legitimate: a logging turn saying what the user
 * ate, or a prescriptive turn whose answer warns instead of recommends. Anything
 * else keeps its reason and blocks — including a prescriptive answer that
 * recommends the allergen, which is the case that motivated the rule.
 */
function postGateReasonsAfterKnownConflictExemptions(
  reasons: readonly string[],
  knownConflicts: readonly Conflict[],
  prose: string,
): readonly string[] {
  const exemptIds = new Set(
    exemptibleConflicts(prose, knownConflicts).map((id) => id.toLowerCase()),
  );

  return reasons.filter((reason) => {
    const lowerReason = reason.toLowerCase();
    for (const id of exemptIds) {
      if (lowerReason.includes(id)) return false;
    }
    return true;
  });
}

function knownConflictExemptionEvidence(exemptIds: readonly string[]): string {
  return `Known conflict(s) exempted as warnings or logs: ${exemptIds.join(", ")}`;
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
    const exemptIds = exemptibleConflicts(prose, knownConflicts);
    const blockReasons = postGateReasonsAfterKnownConflictExemptions(
      check.reasons,
      knownConflicts,
      prose,
    );

    if (blockReasons.length === 0) {
      return createOutputGateCheck(
        OUTPUT_LEXICAL_BACKSTOP_CHECK,
        true,
        [],
        knownConflictExemptionEvidence(exemptIds),
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

/**
 * Run the four citation conditions and strip what fails them.
 *
 * Returns a verdict only when there was something to judge: a turn with no
 * citations gets no event, because "nothing to check" is not a result worth
 * putting in the trace — a turn whose citations were all stripped does get one,
 * since the stripping is exactly what a reader needs to see.
 */
async function runCitationCheck(
  result: TurnResult,
  ports: TurnPorts,
): Promise<{ output: TypedOutput | undefined; verdict?: GateVerdictEventDetails }> {
  const citations = result.output?.citations ?? [];
  if (citations.length === 0) return { output: result.output };

  let entries: Awaited<ReturnType<CitationRegistry["entries"]>> | undefined;
  let unavailableReason: string | undefined;
  if (!ports.citationRegistry) {
    unavailableReason = "no registry port is wired";
  } else {
    try {
      entries = await ports.citationRegistry.entries(
        citations.map((citation) => citation.sectionId),
      );
    } catch (err) {
      // A registry that cannot be read is not a reason to keep the citations:
      // the answer still stands, its evidence claim does not.
      unavailableReason = err instanceof Error ? err.message : String(err);
    }
  }

  const check = checkCitations({
    output: result.output,
    evidenceSet: ports.evidenceSet,
    entries,
    unavailableReason,
  });

  return {
    output: stripInvalidCitations(result.output, check),
    verdict: {
      checkpoint: "output",
      // `pass` when every citation survived. The first live run reported a
      // verified citation as a block — a verdict that says "something is wrong"
      // while its own evidence says nothing is, which is how a reader learns to
      // ignore verdicts.
      verdict: check.passed ? "pass" : "block",
      // Never terminal either way: an answer's other checks keep their own
      // verdicts and the regenerate budget is untouched.
      checkName: OUTPUT_CITATION_PROVENANCE_CHECK,
      evidence: citationEvidence(check),
      terminal: false,
    },
  };
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
    // Strictly descriptive: a FoodRef is a structured pointer at a catalog food,
    // not prose that can warn, so a prescriptive turn may not point at the
    // allergen even while its text says "do not eat this".
    knownConflicts
      .filter((conflict) => conflict.intent === "descriptive")
      .map((conflict) => conflict.id.toLowerCase()),
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

/**
 * Structural validator for log_meal proposal payloads (RFC 0002).
 * Accepts only the structured proposalResponse object (ok.data) — no result-string parse.
 */
export function parseWriteProposalData(
  data: unknown,
): WriteProposalData | undefined {
  if (!isRecord(data) || !isRecord(data.proposal)) {
    return undefined;
  }

  const topProposalId = readString(data, "proposal_id");
  const proposal = data.proposal;
  const nestedId = readString(proposal, "id");
  const foodName = readString(proposal, "food_name");
  const portionG = readNumber(proposal, "portion_g");
  const mealType = readString(proposal, "meal_type");
  const createdAt = readString(proposal, "created_at");
  const nutritionSource = readString(proposal, "nutrition_source");
  if (
    !topProposalId ||
    !nestedId ||
    topProposalId !== nestedId ||
    !foodName ||
    portionG === undefined ||
    !mealType ||
    createdAt === undefined ||
    nutritionSource === undefined
  ) {
    return undefined;
  }

  const nutrition = isRecord(proposal.nutrition) ? proposal.nutrition : {};
  return {
    proposalId: nestedId,
    foodId: readString(proposal, "food_id"),
    foodName,
    canonicalName: readString(proposal, "canonical_name"),
    portionG,
    mealType,
    kcal: readNumber(nutrition, "kcal"),
    proteinG: readNumber(nutrition, "protein_g"),
    fatG: readNumber(nutrition, "fat_g"),
    carbsG: readNumber(nutrition, "carbs_g"),
    nutritionSource,
    matchType: readString(proposal, "match_type"),
    allergenTags: readStringArray(proposal, "allergen_tags"),
    allergenCoverage: readAllergenCoverage(proposal, "allergen_coverage"),
    createdAt,
  };
}

function readAllergenCoverage(
  record: Record<string, unknown>,
  key: string,
): "reviewed" | "unreviewed" | undefined {
  const value = record[key];
  if (value === "reviewed" || value === "unreviewed") return value;
  return undefined;
}

interface UtteranceTurnOutput {
  readonly result: TurnResult;
  readonly writeProposal?: WriteProposalData;
  readonly resolverMiss?: ResolverMissProjection;
}

/** Candidate short-circuit: return result only — outer turn emits the sole terminal. */
async function runCandidateLogTurn(
  input: CandidateLogInput,
  ports: TurnPorts,
): Promise<TurnResult> {
  if (!ports.catalog || !ports.proposalStore || !ports.sessionUserId) {
    return {
      reply: "Candidate log requires catalog and proposal store.",
      steps: 0,
      stopReason: "crash",
    };
  }

  let outcome;
  try {
    outcome = await storeProposalFromParsed(
      ports.catalog,
      ports.proposalStore,
      ports.sessionUserId,
      {
        foodId: input.foodId,
        foodName: input.foodName,
        portionG: input.portionG,
        mealType: input.mealType,
      },
    );
  } catch (err) {
    return {
      reply: "Something went wrong while storing the selected food.",
      steps: 0,
      stopReason: "crash",
    };
  }

  if (outcome.kind !== "ok") {
    return {
      reply:
        outcome.kind === "typed_error" || outcome.kind === "typed_miss"
          ? outcome.message
          : "Could not log selected food.",
      steps: 0,
      stopReason: "end_turn",
    };
  }

  const proposal = parseWriteProposalData(outcome.data);
  if (!proposal) {
    return {
      reply: "Could not build proposal from selected food.",
      steps: 0,
      stopReason: "crash",
    };
  }

  // Use pre-gate interactions when loaded (fail-closed path on chat route).
  const interactions = ports.interactionStore
    ? await ports.interactionStore.all().catch(() => [])
    : [];
  const safetyNotices = projectProposalSafetyNotices(proposal, interactions);
  return {
    reply: `Log ${proposal.portionG}g ${proposal.foodName} for ${proposal.mealType}?`,
    steps: 0,
    stopReason: "write_proposal",
    proposal,
    safetyNotices,
    interactions,
  };
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
  let lastResolverMiss: ResolverMissProjection | undefined;
  let lastLogMealActArgs: Readonly<Record<string, unknown>> | undefined;
  let outputGateFailReasons: readonly string[] = [];

  for (let attempt = 0; attempt <= MAX_OUTPUT_GATE_RETRIES; attempt++) {
    // RFC 0004: do not leak resolver miss from a blocked attempt into a later retry.
    lastResolverMiss = undefined;
    lastWriteProposalData = undefined;
    lastLogMealActArgs = undefined;

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
      //
      // The dedup check comes first on purpose: building the event allocates a
      // seq, and an allocated seq that is never yielded leaves a hole in the
      // stream — which the trace's D3 assertion (`min(seq)=0`,
      // `max(seq)+1=count(*)`) rejects outright (#88).
      if (!emittedModelCallSteps.has(next.value.step)) {
        const mcEvent = createTurnModelCallEvent(
          next.value.step,
          ports.tracer,
          nextMetadata,
        );
        if (mcEvent) {
          emittedModelCallSteps.add(mcEvent.step);
          yield mcEvent;
        }
      }

      // Capture log_meal act args so typed_miss can reattach portion/mealType
      if (
        next.value.type === "act" &&
        next.value.toolCall?.name === "log_meal" &&
        next.value.toolCall.args
      ) {
        lastLogMealActArgs = next.value.toolCall.args;
      }

      // Emit tool gate verdict after each tool observation (RFC 0002)
      if (next.value.type === "observe" && next.value.toolOutcome) {
        const outcome = next.value.toolOutcome;
        yield createGateVerdictEvent(
          createToolGateVerdict(outcome),
          nextMetadata,
        );

        if (
          outcome.kind === "ok" &&
          outcome.name === QUERY_CATALOG_TOOL &&
          outcome.observation
        ) {
          observations.push(outcome.observation);
        }

        if (outcome.kind === "ok" && outcome.name === "log_meal") {
          lastWriteProposalData = parseWriteProposalData(outcome.data);
          lastResolverMiss = undefined;
        }

        if (outcome.kind === "typed_miss" && outcome.name === "log_meal") {
          lastResolverMiss = projectResolverMiss(
            outcome.data,
            lastLogMealActArgs,
          );
          lastWriteProposalData = undefined;
        }

        // infra_error: stop consuming further loop events; crash terminal
        if (outcome.kind === "infra_error") {
          result = {
            reply:
              "Something went wrong while running a tool. Please try again.",
            steps: next.value.step,
            stopReason: "crash",
            interactions: undefined,
          };
          // Drain remaining generator events without processing
          let drain = await gen.next();
          while (!drain.done) {
            drain = await gen.next();
          }
          return {
            result,
            writeProposal: lastWriteProposalData,
            resolverMiss: lastResolverMiss,
          };
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

    // ── Tier-1: citation provenance (RFC 0011 §3.5) ──────────────────
    //
    // Stripped before the other checks run, on purpose: the lexical backstop
    // (tier-2) has to see the answer as it will actually be delivered, and a
    // citation that is about to be removed must not be able to satisfy it.
    const citationCheck = await runCitationCheck(result, ports);
    if (citationCheck.verdict) {
      yield createGateVerdictEvent(citationCheck.verdict, nextMetadata);
    }
    if (citationCheck.output !== result.output) {
      result = { ...result, output: citationCheck.output };
    }

    const outputGateChecks = collectOutputGateChecks(
      result,
      ports.userContext,
      observations,
      conflicts,
      ports.catalog,
    );

    // ── Tier-2: authority claimed, evidence absent (RFC 0011 §3.6) ────
    //
    // Added after the provenance strip, so it sees the citations that will
    // actually be delivered. This one is terminal, unlike the strip above: an
    // answer whose only authority is "the guidelines say so" has to be rewritten,
    // not trimmed.
    // Checked on the prose the user will actually read — the same text the
    // lexical backstop uses. An answer delivered through `submit_answer` and one
    // delivered as plain prose make the same claim, and a check that only read
    // `result.output` would wave the second one through.
    const assertionCheck = checkCitationAssertions({
      prose: outputTextForGate(result),
      citations: result.output?.citations,
    });
    outputGateChecks.push(
      createOutputGateCheck(
        OUTPUT_CITATION_ASSERTION_CHECK,
        assertionCheck.passed,
        assertionCheck.reasons,
        assertionCheck.matched.length === 0
          ? "No authority claim without a source"
          : `Authority claim(s) carried ${result.output?.citations?.length ?? 0} citation(s)`,
      ),
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

  return {
    result: result!,
    writeProposal: lastWriteProposalData,
    resolverMiss: lastResolverMiss,
  };
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
    evidenceText: ports.evidenceText,
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
 * The turn body: allocates seq, runs the input gate, the loop, the output and
 * commit gates, and decides the terminal result. It persists nothing and guards
 * nothing — {@link turn} owns both, because only the caller of this generator
 * sees every event exactly once and survives its exceptions.
 */
async function* runTurn(
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
      if (utteranceOutput.resolverMiss) {
        result = {
          ...result,
          resolverMiss: utteranceOutput.resolverMiss,
        };
      }
      break;
    }
    case "proposal_confirm": {
      // Issue #73: resolve typed ConfirmPorts; incomplete → fail-closed
      // terminal on the seam (never mid-stream throw / silent pass).
      const confirmPorts = resolveConfirmPorts(ports);
      const outcome = confirmPorts
        ? await handleProposalConfirm(input, confirmPorts)
        : incompleteConfirmOutcome(input);
      result = outcome.result;
      confirmCommitVerdict = outcome.commitVerdict;
      break;
    }
    case "candidate_log": {
      // RFC 0004 §6.1: bind pick to catalog food_id — no free-text model path.
      result = await runCandidateLogTurn(input, ports);
      writeProposal = result.proposal;
      break;
    }
  }

  // RFC 0002: crash must not be overridden by a captured write proposal
  if (
    writeProposal &&
    result.stopReason !== "gate_blocked" &&
    result.stopReason !== "crash" &&
    // candidate_log already set write_proposal + safetyNotices
    result.stopReason !== "write_proposal"
  ) {
    // RFC 0004 §6.4: project confirm-card safety at the turn seam
    const safetyNotices = projectProposalSafetyNotices(
      writeProposal,
      result.interactions ?? [],
    );
    result = {
      ...result,
      stopReason: "write_proposal",
      proposal: writeProposal,
      safetyNotices,
      resolverMiss: undefined,
    };
  }

  // RFC 0002 §2.5: tool-path infra_error → crash terminal without output/commit
  // "pass". Confirm-path fail-closed (RFC 0001 F1) also uses stopReason crash
  // but still emits its commit error verdict via confirmCommitVerdict.
  if (result.stopReason === "crash") {
    if (confirmCommitVerdict) {
      yield createGateVerdictEvent(
        { checkpoint: "commit", ...confirmCommitVerdict },
        nextMetadata,
      );
    }
    yield createTurnEndEvent(result, nextMetadata);
    // The returned result is what callers read (`consumeTurn`, the route's
    // terminal frame), so the fallback has to reach it too — a fix applied only
    // to the event would leave the user-facing reply empty, which is the bug.
    return withReadableReply(result);
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

  return withReadableReply(result);
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
 *
 * This wrapper is the trace port's host (RFC 0008 §3.2/§3.6). It sits outside
 * the body so that it sees every event exactly once — including the ones the
 * nested generators yield — which is what lets it append to the store before
 * handing the event to the client, and what lets it turn any exception into a
 * terminal event instead of a half-finished stream.
 */
export async function* turn(
  input: TurnInput,
  ports: TurnPorts,
): AsyncGenerator<AnyTurnEvent, TurnResult, undefined> {
  const trace = ports.trace;
  const clock = ports.clock ?? (() => new Date());
  const body = runTurn(input, ports);
  /** The seq the next event must carry — and the one a crash terminal takes. */
  let nextSeq = 0;
  /**
   * Highest step the body reached. A crash terminal reports it the way the loop
   * reports its own crashes (`steps: step`), so an eval can still tell "died at
   * step 2" from "never started" (#21).
   */
  let lastStep = 0;
  /**
   * Nothing is persisted before a turn_start lands, and the RPC refuses a
   * non-start event for an unknown turn (23503). A body that throws before its
   * first event therefore has no row to finalize: there is nothing to write, so
   * a lone turn_end is not attempted.
   */
  let turnRowExists = false;

  try {
    let next = await body.next();
    while (!next.done) {
      const event = next.value;
      // The contract suite and D3 both require gapless seq, and the body
      // guarantees it structurally: every `nextMetadata()` call in this file is
      // followed directly by the `yield` of the event it built (the model_call
      // dedup used to allocate before deciding, which is what made this
      // assertion fire). A gap therefore means an event was allocated and
      // dropped — never something a store should have to guess about.
      if (event.seq !== nextSeq) {
        throw new Error(
          `turn event seq out of order: expected ${nextSeq}, got ${event.seq}`,
        );
      }

      if (event.type === "step") {
        lastStep = Math.max(lastStep, event.agentEvent.step);
      }

      if (trace) {
        await trace.append(event);
        if (event.type === "turn_start") turnRowExists = true;
      }
      // Advanced only once the event is on its way out: an event whose write
      // failed never happened, so the terminal takes its seq rather than
      // leaving a hole in the trace.
      nextSeq = event.seq + 1;

      yield event;
      next = await body.next();
    }

    return withReadableReply(next.value);
  } catch (err) {
    const result: TurnResult = {
      reply: crashReplyFor(ports, err),
      steps: lastStep,
      stopReason: "crash",
    };
    const terminal: TurnEndEvent = {
      ...createEventMetadataFor(clock, nextSeq),
      type: "turn_end",
      result,
    };

    if (trace && turnRowExists) {
      try {
        await trace.append(terminal);
      } catch {
        // Swallowed on purpose: throwing from inside this catch would recurse,
        // and a terminal that cannot be stored still has to reach the client.
        // The store records the loss itself (`persistFailed`, §3.6).
      }
    }

    yield terminal;
    return result;
  }
}

/** Metadata for an event built outside the body's own seq counter. */
function createEventMetadataFor(
  clock: Clock,
  seq: number,
): Pick<TurnEvent, "schema" | "seq" | "timestamp"> {
  // The clock is an injected port, and this runs while handling a failure: a
  // broken clock must not be able to leave the turn without a terminal event.
  let timestamp: string;
  try {
    timestamp = clock().toISOString();
  } catch {
    timestamp = new Date().toISOString();
  }
  return { schema: SCHEMA_VERSION, seq, timestamp };
}

/**
 * The reply policy is an injected port too, so it gets the same treatment: the
 * invariant is "every exception still produces a terminal event", and a mapping
 * that throws is still an exception.
 */
function crashReplyFor(ports: TurnPorts, error: unknown): string {
  try {
    return ports.crashReply?.(error) ?? DEFAULT_CRASH_REPLY;
  } catch {
    return DEFAULT_CRASH_REPLY;
  }
}

/** Shown when the assembly layer offers no reply for a fatal error (§3.6). */
const DEFAULT_CRASH_REPLY = "Something went wrong while answering. Please try again.";

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
