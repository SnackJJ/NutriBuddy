// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type { AgentEvent, TerminalResult, WriteProposalData } from "./types";
import type { MealLogStore, Proposal, ProposalStore } from "./logMeal";

export type { FoodRef, RuleRef, TypedOutput } from "./types";

/** Bump minor for compatible additions, major for breaking event-shape changes. */
export const SCHEMA_VERSION = "1.2.0";

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
  /** Proposal store for the confirmation commit path (issue #37). */
  readonly proposalStore?: ProposalStore;
  /** Meal ledger store — only writeable through confirmed proposals (issue #37). */
  readonly mealLogStore?: MealLogStore;
  /** Authenticated user identity — not model-fillable (issue #37). */
  readonly sessionUserId?: string;
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

export function parseWriteProposalData(
  toolResult: string,
): WriteProposalData | undefined {
  try {
    const parsed = JSON.parse(toolResult);
    const p = parsed.proposal;
    if (!p || !p.id || !p.food_name) return undefined;
    return {
      proposalId: p.id,
      foodName: p.food_name,
      portionG: p.portion_g,
      mealType: p.meal_type,
      kcal: p.nutrition?.kcal,
      proteinG: p.nutrition?.protein_g,
      fatG: p.nutrition?.fat_g,
      carbsG: p.nutrition?.carbs_g,
      nutritionSource: p.nutrition_source ?? "",
      createdAt: p.created_at ?? "",
    };
  } catch {
    return undefined;
  }
}

/** Return type of runUtteranceTurn — carries the terminal result plus any detected write proposal. */
interface UtteranceTurnOutput {
  readonly result: TurnResult;
  readonly writeProposal?: WriteProposalData;
}

async function* runUtteranceTurn(
  input: UtteranceInput,
  ports: TurnPorts,
  nextMetadata: NextEventMetadata,
): AsyncGenerator<AnyTurnEvent, UtteranceTurnOutput, undefined> {
  const gen = run(createRunTurnInput(input, ports));

  let lastWriteProposalData: WriteProposalData | undefined;

  let next = await gen.next();
  while (!next.done) {
    yield createTurnStepEvent(next.value, nextMetadata);

    // Emit tool gate verdict after each tool observation
    if (next.value.type === "observe" && next.value.toolResult) {
      yield createGateVerdictEvent(
        {
          checkpoint: "tool",
          verdict: "pass",
          checkName: "tool_gate_check",
          evidence: `Tool ${next.value.toolResult.name} executed successfully`,
        },
        nextMetadata,
      );

      // Issue #36: detect log_meal tool calls and extract proposal data
      if (next.value.toolResult.name === "log_meal") {
        lastWriteProposalData = parseWriteProposalData(
          next.value.toolResult.result,
        );
      }
    }

    next = await gen.next();
  }

  return { result: next.value, writeProposal: lastWriteProposalData };
}

function createRunTurnInput(
  input: UtteranceInput,
  ports: TurnPorts,
): RunTurnInput {
  return {
    userInput: input.content,
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

  yield createGateVerdictEvent(
    {
      checkpoint: "input",
      verdict: "pass",
      checkName: "pre_gate_input_check",
      evidence: "Input accepted for processing",
    },
    nextMetadata,
  );

  let result: TurnResult;
  let writeProposal: WriteProposalData | undefined;
  let confirmCommitVerdict: CommitGateVerdict | undefined;

  switch (input.tag) {
    case "utterance": {
      const utteranceOutput = yield* runUtteranceTurn(
        input,
        ports,
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

  // Issue #36: when log_meal was called, override stopReason to write_proposal
  // and attach the resolved proposal data to the terminal result.
  if (writeProposal) {
    result = {
      ...result,
      stopReason: "write_proposal",
      proposal: writeProposal,
    };
  }

  const isGateBlocked = result.stopReason === "gate_blocked";
  const outputEvidence = createOutputEvidence(result, ports.tracer);

  if (input.tag === "utterance") {
    yield createGateVerdictEvent(
      {
        checkpoint: "output",
        verdict: isGateBlocked ? "block" : "pass",
        checkName: "post_gate_output_check",
        evidence: outputEvidence,
      },
      nextMetadata,
    );
  }

  yield createGateVerdictEvent(
    createCommitGateDetails(
      result,
      writeProposal,
      outputEvidence,
      confirmCommitVerdict,
    ),
    nextMetadata,
  );

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
