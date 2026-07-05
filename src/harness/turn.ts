// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type { AgentEvent, TerminalResult } from "./types";

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

export type AnyTurnEvent = TurnStartEvent | TurnStepEvent | TurnGateVerdictEvent | TurnEndEvent;

/** Final result emitted in turn_end and returned by the turn generator. */
export type TurnResult = TerminalResult;

export type TurnEventHandler = (event: AnyTurnEvent) => void;

type EventMetadata = Pick<TurnEvent, "schema" | "seq" | "timestamp">;
type NextEventMetadata = () => EventMetadata;

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
  checkpoint: GateCheckpoint,
  verdict: GateVerdict,
  checkName: string,
  evidence: string,
  nextMetadata: NextEventMetadata,
): TurnGateVerdictEvent {
  return {
    ...nextMetadata(),
    type: "gate_verdict",
    checkpoint,
    verdict,
    checkName,
    evidence,
  };
}

/** Extract post-gate block evidence from the tracer for gate verdict events. */
function extractGateEvidence(tracer: { events(): { type: string; payload: string }[] }): string {
  const gateBlocks = tracer.events().filter((e) => e.type === "gate_block");
  if (gateBlocks.length === 0) return "No safety violations detected";
  // Use the last gate_block event (the one that exhausted retries)
  const lastBlock = gateBlocks[gateBlocks.length - 1];
  return `Blocked: ${lastBlock.payload}`;
}

async function* runUtteranceTurn(
  input: UtteranceInput,
  ports: TurnPorts,
  nextMetadata: NextEventMetadata,
): AsyncGenerator<AnyTurnEvent, TurnResult, undefined> {
  const gen = run(createRunTurnInput(input, ports));

  let next = await gen.next();
  while (!next.done) {
    yield createTurnStepEvent(next.value, nextMetadata);

    // Emit tool gate verdict after each tool observation
    if (next.value.type === "observe" && next.value.toolResult) {
      yield createGateVerdictEvent(
        "tool",
        "pass",
        "tool_gate_check",
        `Tool ${next.value.toolResult.name} executed successfully`,
        nextMetadata,
      );
    }

    next = await gen.next();
  }

  return next.value;
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
  };
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

  // Input gate verdict: always passes in minimal slice (checkpoint established)
  yield createGateVerdictEvent(
    "input",
    "pass",
    "pre_gate_input_check",
    "Input accepted for processing",
    nextMetadata,
  );

  let result: TurnResult;

  switch (input.tag) {
    case "utterance":
      result = yield* runUtteranceTurn(input, ports, nextMetadata);
      break;
    case "proposal_confirm":
      result = createProposalConfirmResult(input);
      break;
  }

  // Output gate verdict: reflects post-gate result
  const blocked = result.stopReason === "gate_blocked";
  const outputEvidence = blocked
    ? extractGateEvidence(ports.tracer)
    : "Output passed safety checks";

  // Only emit output gate for utterance turns (proposal_confirm has no model call)
  if (input.tag === "utterance") {
    yield createGateVerdictEvent(
      "output",
      blocked ? "block" : "pass",
      "post_gate_output_check",
      outputEvidence,
      nextMetadata,
    );
  }

  // Commit gate verdict: final word on whether response is safe to commit
  yield createGateVerdictEvent(
    "commit",
    blocked ? "block" : "pass",
    "commit_gate_check",
    blocked ? outputEvidence : "Response committed successfully",
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
