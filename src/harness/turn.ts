// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type {
  AgentEvent,
  ChatMessage,
  TerminalResult,
  ToolResult,
  TypedOutput,
  WriteProposalData,
} from "./types";
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
import type { MealLogStore, Proposal, ProposalStore } from "./logMeal";

export type { FoodRef, RuleRef, TypedOutput } from "./types";

/** Bump minor for compatible additions, major for breaking event-shape changes. */
export const SCHEMA_VERSION = "1.3.0";
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
 * All external dependencies enter through injected ports.
 * Every field is injectable for deterministic scripted testing.
 */
export interface TurnPorts extends Omit<RunTurnInput, "userInput"> {
  readonly clock?: Clock;
  /** Observations from query catalog executions, collected during the turn. */
  readonly observations?: readonly Observation[];
  /** Conflicts detected at the input gate for advisory structure checking. */
  readonly conflicts?: readonly Conflict[];
  /** Proposal store for the confirmation commit path (issue #37). */
  readonly proposalStore?: ProposalStore;
  /** Meal ledger store — only writeable through confirmed proposals (issue #37). */
  readonly mealLogStore?: MealLogStore;
  /** Authenticated user identity — not model-fillable (issue #37). */
  readonly sessionUserId?: string;
  /** Food catalog for input-gate utterance conflict scanning (issue #49). */
  readonly catalog?: Catalog;
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
}

export interface TurnStepEvent extends TurnEvent {
  readonly type: "step";
  readonly agentEvent: AgentEvent;
}

export interface TurnEndEvent extends TurnEvent {
  readonly type: "turn_end";
  readonly result: TurnResult;
}

export type AnyTurnEvent =
  | TurnStartEvent
  | TurnStepEvent
  | TurnGateVerdictEvent
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
  nextMetadata: NextEventMetadata,
): TurnStartEvent {
  return { ...nextMetadata(), type: "turn_start", input };
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

  return {
    checkpoint: "tool",
    verdict: "pass",
    checkName: TOOL_GATE_CHECK,
    evidence: `Tool ${toolResult.name} executed successfully`,
  };
}

function extractGateEvidence(tracer: TurnPorts["tracer"]): string {
  const gateBlocks = tracer
    .events()
    .filter((event) => event.type === "gate_block");
  if (gateBlocks.length === 0) {
    return "No safety violations detected";
  }

  const lastBlock = gateBlocks[gateBlocks.length - 1];
  return `Blocked: ${lastBlock.payload}`;
}

/** Max retry attempts for the consolidated output gate (issue #47).
 *  All checks — lexical backstop, numeric provenance, advisory structure —
 *  share one regenerate budget. */
const MAX_OUTPUT_GATE_RETRIES = 2;
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
  tracer: TurnPorts["tracer"],
): TurnResult {
  tracer.record({
    step: result.steps,
    type: "gate_block",
    payload: reasons.join("; "),
  });

  return {
    reply: consolidatedGateRefusalReply(reasons),
    steps: result.steps,
    stopReason: "gate_blocked",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
      ...createRunTurnInput(input, ports),
      history,
    });

    let next = await gen.next();
    while (!next.done) {
      yield createTurnStepEvent(next.value, nextMetadata);

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

    // ── Issue #47: Consolidated output gate ──────────────────────────
    // All checks (lexical backstop, numeric provenance, advisory structure)
    // run together at the turn boundary with one retry budget and one
    // combined feedback message. The inner loop no longer re-gates.

    const outputGateChecks = collectOutputGateChecks(
      result,
      ports.userContext,
      observations,
      conflicts,
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
      ports.tracer,
    );
    break;
  }

  return { result: result!, writeProposal: lastWriteProposalData };
}

function createRunTurnInput(
  input: UtteranceInput,
  ports: TurnPorts,
): RunTurnInput {
  return {
    userInput: input.content,
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
  };
}

/** Return value of handleProposalConfirm — carries the turn result plus commit gate details. */
interface ProposalConfirmOutcome {
  result: TurnResult;
  commitVerdict: CommitGateVerdict;
}

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
): ProposalConfirmOutcome {
  return {
    result,
    commitVerdict: {
      verdict,
      checkName: COMMIT_GATE_CHECK,
      evidence,
    },
  };
}

async function declineProposalBestEffort(
  proposalStore: ProposalStore,
  proposalId: string,
): Promise<void> {
  try {
    await proposalStore.decline(proposalId);
  } catch {
    // The rejection reply remains valid even if the store transition fails.
  }
}

async function insertMealLogFromProposal(
  mealLogStore: MealLogStore,
  userId: string,
  proposal: Proposal,
): Promise<void> {
  await mealLogStore.insert({
    userId,
    foodName: proposal.foodName,
    portionG: proposal.portionG,
    mealType: proposal.mealType,
    kcal: proposal.kcal,
    proteinG: proposal.proteinG,
    fatG: proposal.fatG,
    carbsG: proposal.carbsG,
    proposalId: proposal.id,
  });
}

/**
 * Handle a proposal confirmation turn input (issue #37 / PRD v2 §3.4 / ADD Phase 3).
 *
 * Short-circuits the model: verifies the proposal belongs to the current
 * authenticated user and session scope, checks the proposal is in "proposed"
 * status, commits the proposal, and writes the meal ledger row referencing
 * the proposal id.
 *
 * When proposalStore / mealLogStore / sessionUserId are absent, falls back
 * to the legacy reply-only path (backward compatible with scripted tests).
 */
async function handleProposalConfirm(
  input: ProposalConfirmInput,
  ports: TurnPorts,
): Promise<ProposalConfirmOutcome> {
  const { proposalId, confirmed } = input;
  const { proposalStore, mealLogStore, sessionUserId } = ports;

  // Backward-compat: when stores are absent, fall back to legacy reply-only path.
  if (!proposalStore || !mealLogStore || !sessionUserId) {
    return createProposalConfirmOutcome(
      createProposalConfirmResult(input),
      "pass",
      `Proposal ${proposalId} ${confirmed ? "confirmed" : "rejected"} (no store wired)`,
    );
  }

  if (!confirmed) {
    await declineProposalBestEffort(proposalStore, proposalId);
    return createProposalConfirmOutcome(
      createProposalConfirmResult(input),
      "pass",
      `Proposal ${proposalId} explicitly rejected by user`,
    );
  }

  // ── Confirmed: verify ownership and status ──────────────────────────────

  const proposal = await proposalStore.get(proposalId);

  if (!proposal) {
    return createProposalConfirmOutcome(
      createEndTurnResult(
        `Proposal ${proposalId} not found — it may have expired or been voided.`,
      ),
      "error",
      `Proposal ${proposalId} not found — may have expired or been voided`,
    );
  }

  if (proposal.userId !== sessionUserId) {
    return createProposalConfirmOutcome(
      createEndTurnResult(
        `Cannot confirm proposal ${proposalId}: it belongs to a different user.`,
      ),
      "block",
      `Proposal ${proposalId} belongs to user ${proposal.userId}, not ${sessionUserId}`,
    );
  }

  if (proposal.status !== "proposed") {
    return createProposalConfirmOutcome(
      createEndTurnResult(
        `Proposal ${proposalId} is already ${proposal.status} and cannot be confirmed.`,
      ),
      "block",
      `Proposal ${proposalId} is in status "${proposal.status}" — only "proposed" proposals can be committed`,
    );
  }

  // ── Commit: transition status → committed, then write meal ledger ─────

  const committed = await proposalStore.commit(proposalId);

  await insertMealLogFromProposal(mealLogStore, sessionUserId, committed);

  return createProposalConfirmOutcome(
    createProposalConfirmResult(input),
    "pass",
    `Proposal ${proposalId} committed — meal ledger row references proposal ${proposalId}`,
  );
}

function createOutputEvidence(
  result: TurnResult,
  tracer: TurnPorts["tracer"],
): string {
  if (result.stopReason === "gate_blocked") {
    return extractGateEvidence(tracer);
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

interface InputGateDecision {
  readonly blocked: boolean;
  readonly blockEvidence: string;
  readonly conflicts: readonly Conflict[];
  readonly verdict: GateVerdictEventDetails;
}

function createAcceptedInputGateDecision(): InputGateDecision {
  return {
    blocked: false,
    blockEvidence: "",
    conflicts: [],
    verdict: {
      checkpoint: "input",
      verdict: "pass",
      checkName: PRE_GATE_INPUT_CHECK,
      evidence: "Input accepted for processing",
    },
  };
}

function createInputConflictBlockEvidence(
  conflicts: readonly Conflict[],
  hitFoods: readonly string[],
): string {
  return (
    `Blocked: prescriptive request mentions foods conflicting with user allergies — ` +
    conflicts.map((conflict) => conflict.id).join(", ") +
    `. Foods: ${hitFoods.join(", ")}.`
  );
}

function createInputConflictPassEvidence(
  conflicts: readonly Conflict[],
): string {
  return (
    `Pass (descriptive): detected ${conflicts.length} conflict(s) — ` +
    conflicts.map((conflict) => conflict.id).join(", ") +
    `. Advisory gate will enforce ruleRefs.`
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
    const evidence = createInputConflictBlockEvidence(
      scan.conflicts,
      scan.hitFoods,
    );

    return {
      blocked: true,
      blockEvidence: evidence,
      conflicts: [],
      verdict: {
        checkpoint: "input",
        verdict: "block",
        checkName: PRE_GATE_INPUT_CHECK,
        evidence,
      },
    };
  }

  return {
    blocked: false,
    blockEvidence: "",
    conflicts: scan.conflicts,
    verdict: {
      checkpoint: "input",
      verdict: "pass",
      checkName: PRE_GATE_INPUT_CHECK,
      evidence: createInputConflictPassEvidence(scan.conflicts),
    },
  };
}

function createInputBlockedResult(): TurnResult {
  return {
    reply:
      `I cannot help with that request. Your allergies conflict with ` +
      `foods mentioned in your question. Please consult a doctor or ` +
      `registered dietitian for personalized dietary advice.`,
    steps: 0,
    stopReason: "end_turn",
  };
}

function isTurnGateBlocked(result: TurnResult, inputBlocked: boolean): boolean {
  return result.stopReason === "gate_blocked" || inputBlocked;
}

function createOutputGateSummaryDetails(
  result: TurnResult,
  inputBlocked: boolean,
  outputEvidence: string,
): GateVerdictEventDetails {
  const evidence = inputBlocked
    ? "Input gate blocked — no model output to check"
    : outputEvidence;

  return {
    checkpoint: "output",
    verdict: isTurnGateBlocked(result, inputBlocked) ? "block" : "pass",
    checkName: OUTPUT_GATE_SUMMARY_CHECK,
    evidence,
  };
}

function createInputBlockedCommitGateDetails(
  inputBlockEvidence: string,
): GateVerdictEventDetails {
  return {
    checkpoint: "commit",
    verdict: "block",
    checkName: COMMIT_GATE_CHECK,
    evidence: `Blocked: input gate refused prescriptive request — ${inputBlockEvidence}`,
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

  yield createTurnStartEvent(input, nextMetadata);

  const inputGate = createInputGateDecision(input, ports);
  yield createGateVerdictEvent(inputGate.verdict, nextMetadata);

  let result: TurnResult;
  let writeProposal: WriteProposalData | undefined;
  let confirmCommitVerdict: CommitGateVerdict | undefined;

  if (inputGate.blocked) {
    result = createInputBlockedResult();
  } else {
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
  }

  if (writeProposal && result.stopReason !== "gate_blocked") {
    result = {
      ...result,
      stopReason: "write_proposal",
      proposal: writeProposal,
    };
  }

  const outputEvidence = createOutputEvidence(result, ports.tracer);

  if (input.tag === "utterance") {
    yield createGateVerdictEvent(
      createOutputGateSummaryDetails(result, inputGate.blocked, outputEvidence),
      nextMetadata,
    );
  }

  const commitGateDetails = inputGate.blocked
    ? createInputBlockedCommitGateDetails(inputGate.blockEvidence)
    : createCommitGateDetails(
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
