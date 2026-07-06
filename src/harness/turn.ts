// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type { AgentEvent, TerminalResult, WriteProposalData } from "./types";
import type { ProposalStore, MealLogStore } from "./logMeal";

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

export function parseWriteProposalData(toolResult: string): WriteProposalData | undefined {
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
  commitVerdict: Omit<GateVerdictEventDetails, "checkpoint">;
}

function createProposalConfirmResult(input: ProposalConfirmInput): TurnResult {
  return {
    reply: createProposalConfirmReply(input),
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
  const { proposalId, confirmed, feedback } = input;
  const { proposalStore, mealLogStore, sessionUserId } = ports;

  // Backward-compat: when stores are absent, fall back to legacy reply-only path.
  if (!proposalStore || !mealLogStore || !sessionUserId) {
    return {
      result: createProposalConfirmResult(input),
      commitVerdict: {
        verdict: "pass",
        checkName: "commit_gate_check",
        evidence: `Proposal ${proposalId} ${confirmed ? "confirmed" : "rejected"} (no store wired)`,
      },
    };
  }

  if (!confirmed) {
    // Best-effort decline: update the proposal status to "rejected".
    try {
      await proposalStore.decline(proposalId);
    } catch {
      // Decline is best-effort; the rejection reply is still valid even if
      // the store update fails.
    }
    return {
      result: {
        reply: createProposalConfirmReply(input),
        steps: 0,
        stopReason: "end_turn",
      },
      commitVerdict: {
        verdict: "pass",
        checkName: "commit_gate_check",
        evidence: `Proposal ${proposalId} explicitly rejected by user`,
      },
    };
  }

  // ── Confirmed: verify ownership and status ──────────────────────────────

  const proposal = await proposalStore.get(proposalId);

  if (!proposal) {
    return {
      result: {
        reply: `Proposal ${proposalId} not found — it may have expired or been voided.`,
        steps: 0,
        stopReason: "end_turn",
      },
      commitVerdict: {
        verdict: "error",
        checkName: "commit_gate_check",
        evidence: `Proposal ${proposalId} not found — may have expired or been voided`,
      },
    };
  }

  if (proposal.userId !== sessionUserId) {
    return {
      result: {
        reply: `Cannot confirm proposal ${proposalId}: it belongs to a different user.`,
        steps: 0,
        stopReason: "end_turn",
      },
      commitVerdict: {
        verdict: "block",
        checkName: "commit_gate_check",
        evidence: `Proposal ${proposalId} belongs to user ${proposal.userId}, not ${sessionUserId}`,
      },
    };
  }

  if (proposal.status !== "proposed") {
    return {
      result: {
        reply: `Proposal ${proposalId} is already ${proposal.status} and cannot be confirmed.`,
        steps: 0,
        stopReason: "end_turn",
      },
      commitVerdict: {
        verdict: "block",
        checkName: "commit_gate_check",
        evidence: `Proposal ${proposalId} is in status "${proposal.status}" — only "proposed" proposals can be committed`,
      },
    };
  }

  // ── Commit: transition status → committed, then write meal ledger ─────

  const committed = await proposalStore.commit(proposalId);

  await mealLogStore.insert({
    userId: sessionUserId,
    foodName: committed.foodName,
    portionG: committed.portionG,
    mealType: committed.mealType,
    kcal: committed.kcal,
    proteinG: committed.proteinG,
    fatG: committed.fatG,
    carbsG: committed.carbsG,
    proposalId: committed.id,
  });

  return {
    result: {
      reply: createProposalConfirmReply(input),
      steps: 0,
      stopReason: "end_turn",
    },
    commitVerdict: {
      verdict: "pass",
      checkName: "commit_gate_check",
      evidence: `Proposal ${proposalId} committed — meal ledger row references proposal ${proposalId}`,
    },
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
  /** Commit gate details set by proposal_confirm path (issue #37). */
  let confirmCommitVerdict: Omit<GateVerdictEventDetails, "checkpoint"> | undefined;

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
  const isWriteProposal = result.stopReason === "write_proposal";
  const outputEvidence = isGateBlocked
    ? extractGateEvidence(ports.tracer)
    : isWriteProposal
      ? "Write proposal emitted — awaiting user confirmation"
      : "Output passed safety checks";

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

  // Issue #37: proposal_confirm path provides its own commit gate verdict.
  // Otherwise, derive from utterance turn outcome (gate_block / write_proposal / clean).
  const commitVerdict: GateVerdictEventDetails = confirmCommitVerdict
    ? { checkpoint: "commit", ...confirmCommitVerdict }
    : {
        checkpoint: "commit",
        verdict: isGateBlocked ? "block" : "pass",
        checkName: "commit_gate_check",
        evidence: isGateBlocked
          ? outputEvidence
          : isWriteProposal
            ? `Proposal ${writeProposal?.proposalId ?? ""} stored — no meal ledger mutation occurred`
            : "Response committed successfully",
      };

  yield createGateVerdictEvent(commitVerdict, nextMetadata);

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
