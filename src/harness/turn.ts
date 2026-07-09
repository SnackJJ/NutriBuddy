// Turn Seam: the single harness entry point (issue #29 / PRD v2 section 4).
// Schema version follows SemVer for event-shape changes.

import { run, type RunTurnInput } from "./loop";
import type {
  AgentEvent,
  ChatMessage,
  TerminalResult,
  TypedOutput,
  WriteProposalData,
} from "./types";
import { checkNumericProvenance } from "./numericProvenanceGate";
import { checkAdvisoryStructure, type Conflict } from "./advisoryGate";
import type { Observation } from "../catalog/queryCatalog";

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

/** Max retry attempts for output gate sub-checks (numeric provenance + advisory). */
const MAX_OUTPUT_GATE_RETRIES = 2;

function buildOutputGateFeedback(reasons: readonly string[]): string {
  return (
    `Your response was BLOCKED by safety checks:\n${reasons.map((r) => `  - ${r}`).join("\n")}\n\n` +
    `Please regenerate your response. Make absolutely sure all numeric facts ` +
    `come from tool results and all safety advisories are cited.`
  );
}

function outputGateRefusalReply(reasons: readonly string[]): string {
  const list = reasons.map((r) => `  - ${r}`).join("\n");
  return (
    `I cannot safely answer your question. My responses were blocked ` +
    `after ${MAX_OUTPUT_GATE_RETRIES} retries due to output gate violations:\n${list}\n\n` +
    `Please consult a doctor or registered dietitian for personalized advice.`
  );
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
      foodName,
      portionG,
      mealType,
      kcal: readNumber(nutrition, "kcal"),
      proteinG: readNumber(nutrition, "protein_g"),
      fatG: readNumber(nutrition, "fat_g"),
      carbsG: readNumber(nutrition, "carbs_g"),
      nutritionSource: readString(proposal, "nutrition_source") ?? "",
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
  let outputGateFailReasons: string[] = [];

  for (let attempt = 0; attempt <= MAX_OUTPUT_GATE_RETRIES; attempt++) {
    const history: ChatMessage[] = [...(ports.history ?? [])];

    // On retry, inject the blocked response and feedback as history
    if (attempt > 0 && result) {
      history.push(
        { role: "assistant", content: result.reply },
        {
          role: "user",
          content: buildOutputGateFeedback(outputGateFailReasons),
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
          {
            checkpoint: "tool",
            verdict: "pass",
            checkName: "tool_gate_check",
            evidence: `Tool ${next.value.toolResult.name} executed successfully`,
          },
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

    // If already blocked by lexical backstop, don't bother with numeric/advisory
    if (result.stopReason === "gate_blocked") {
      break;
    }

    // No typed output to check — pass through
    if (!result.output) {
      break;
    }

    const numericResult = checkNumericProvenance({
      output: result.output,
      observations,
    });

    yield createGateVerdictEvent(
      {
        checkpoint: "output",
        verdict: numericResult.passed ? "pass" : "block",
        checkName: "output_numeric_provenance",
        evidence:
          numericResult.reasons.join("; ") ||
          (observations.length > 0
            ? "All numeric facts trace to observations"
            : "No observations to check — numeric gate skipped"),
      },
      nextMetadata,
    );

    // Run advisory structure check
    const advisoryResult = checkAdvisoryStructure({
      output: result.output,
      conflicts,
    });

    yield createGateVerdictEvent(
      {
        checkpoint: "output",
        verdict: advisoryResult.passed ? "pass" : "block",
        checkName: "output_advisory_structure",
        evidence:
          advisoryResult.reasons.join("; ") || "Advisory structure valid",
      },
      nextMetadata,
    );

    // Both passed — release
    if (numericResult.passed && advisoryResult.passed) {
      break;
    }

    // Collect reasons for feedback on retry
    outputGateFailReasons = [
      ...numericResult.reasons,
      ...advisoryResult.reasons,
    ];

    if (attempt >= MAX_OUTPUT_GATE_RETRIES) {
      ports.tracer.record({
        step: result.steps,
        type: "gate_block",
        payload: outputGateFailReasons.join("; "),
      });

      // Retries exhausted — refuse
      result = {
        reply: outputGateRefusalReply(outputGateFailReasons),
        steps: result.steps,
        stopReason: "gate_blocked",
      };
      break;
    }

    // Will retry — feedback injected at top of next iteration
  }

  return { result: result!, writeProposal: lastWriteProposalData };
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
    case "proposal_confirm":
      result = createProposalConfirmResult(input);
      break;
  }

  if (writeProposal && result.stopReason !== "gate_blocked") {
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

  yield createGateVerdictEvent(
    {
      checkpoint: "commit",
      verdict: isGateBlocked ? "block" : "pass",
      checkName: "commit_gate_check",
      evidence: isGateBlocked
        ? outputEvidence
        : isWriteProposal
          ? `Proposal ${writeProposal?.proposalId ?? ""} stored — no meal ledger mutation occurred`
          : "Response committed successfully",
    },
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
