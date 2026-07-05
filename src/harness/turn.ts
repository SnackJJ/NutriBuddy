// Turn Seam: the single harness entry point (issue #29 / PRD v2 §4).
//
// Tagged turn input (utterance | proposal_confirm) + injected ports
// yields a schema-versioned typed event stream with exactly one
// terminal event. All external dependencies — model adapter, stores,
// tool registry, clock — enter through the ports interface.
//
// Schema version is bumped on breaking changes to the event shape.
// Consumers (eval, API, UI) inspect schema to decide compatibility.

import { run } from "./loop";
import type { Tracer } from "./tracer";
import type { EventLog } from "./eventLog";
import type { InteractionStore } from "../lib/drugInteractions";
import type {
  AgentEvent,
  ModelAdapter,
  StopReason,
  ToolHandler,
} from "./types";

// ─── Schema Version ─────────────────────────────────────────────────────

/** Bump on breaking changes to event shape (add/remove/rename fields). */
export const SCHEMA_VERSION = "1.0.0";

// ─── Tagged Turn Input ────────────────────────────────────────────────

/** Discriminated union: every turn starts with exactly one of these. */
export type TurnInput = UtteranceInput | ProposalConfirmInput;

export interface UtteranceInput {
  readonly tag: "utterance";
  /** Free-text user message (the common case). */
  readonly content: string;
}

export interface ProposalConfirmInput {
  readonly tag: "proposal_confirm";
  /** Which proposal the user is responding to. */
  readonly proposalId: string;
  /** true = confirm, false = reject. */
  readonly confirmed: boolean;
  /** Optional free-text feedback from the user. */
  readonly feedback?: string;
}

// ─── Injected Ports ───────────────────────────────────────────────────

/**
 * All external dependencies enter through injected ports.
 * Every field is injectable for deterministic scripted testing.
 */
export interface TurnPorts {
  /** Model adapter — stub in tests for zero network. */
  readonly adapter: ModelAdapter;
  /** In-memory tracer for CLI render + eval scoring. */
  readonly tracer: Tracer;
  /** Optional persistent event log (JSONL). */
  readonly eventLog?: EventLog;
  /** Drug-nutrient interaction store for pre/post gate. */
  readonly interactionStore?: InteractionStore;
  /** Tool dispatch table — tool name → handler. */
  readonly tools?: ReadonlyMap<string, ToolHandler>;
  /** Clock — inject fixed clock for deterministic timestamps. */
  readonly clock?: () => Date;
}

// ─── Typed Turn Events ────────────────────────────────────────────────

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

/** Emitted once at the start of every turn. Carries the tagged input. */
export interface TurnStartEvent extends TurnEvent {
  readonly type: "turn_start";
  readonly input: TurnInput;
}

/**
 * Emitted for each observable step within the turn.
 * Wraps the loop's AgentEvent (thought / act / observe).
 */
export interface TurnStepEvent extends TurnEvent {
  readonly type: "step";
  readonly agentEvent: AgentEvent;
}

/**
 * ALWAYS the last event in the stream — exactly one per turn.
 * Carries the terminal result: reply, steps, stop reason.
 */
export interface TurnEndEvent extends TurnEvent {
  readonly type: "turn_end";
  readonly result: TurnResult;
}

/** Union of all events the turn stream can emit. */
export type AnyTurnEvent = TurnStartEvent | TurnStepEvent | TurnEndEvent;

// ─── Turn Result ──────────────────────────────────────────────────────

/** Terminal result produced at the end of every turn. */
export interface TurnResult {
  readonly reply: string;
  readonly steps: number;
  readonly stopReason: StopReason;
}

// ─── Turn Seam ────────────────────────────────────────────────────────

/**
 * The single harness entry point for running one turn.
 *
 * Takes tagged input (utterance or proposal confirmation) and injected
 * ports, and yields a schema-versioned typed event stream that ALWAYS
 * ends with exactly one {@link TurnEndEvent}.
 *
 * The returned async generator also returns a {@link TurnResult} as its
 * final value — consumers can use either the terminal event or the
 * generator return value.
 *
 * @example
 * // Utterance turn
 * const gen = turn(
 *   { tag: "utterance", content: "How much protein in an egg?" },
 *   { adapter, tracer },
 * );
 * for await (const event of gen) { ... }
 *
 * @example
 * // Proposal confirmation turn
 * const gen = turn(
 *   { tag: "proposal_confirm", proposalId: "meal-1", confirmed: true },
 *   { adapter, tracer },
 * );
 * for await (const event of gen) { ... }
 */
export async function* turn(
  input: TurnInput,
  ports: TurnPorts,
): AsyncGenerator<AnyTurnEvent, TurnResult, undefined> {
  const clock = ports.clock ?? (() => new Date());
  let seq = 0;

  /** Stamp common fields onto a partial event. */
  function stamped<T extends AnyTurnEvent>(
    partial: Omit<T, "schema" | "seq" | "timestamp">,
  ): T {
    return {
      schema: SCHEMA_VERSION,
      seq: seq++,
      timestamp: clock().toISOString(),
      ...partial,
    } as unknown as T;
  }

  // ── turn_start ─────────────────────────────────────────────────────
  yield stamped<TurnStartEvent>({ type: "turn_start", input });

  let result: TurnResult;

  if (input.tag === "utterance") {
    // ── Utterance: delegate to the ReAct loop ───────────────────────
    const gen = run({
      userInput: input.content,
      adapter: ports.adapter,
      tracer: ports.tracer,
      eventLog: ports.eventLog,
      interactionStore: ports.interactionStore,
      tools: ports.tools,
    });

    let next = await gen.next();
    while (!next.done) {
      yield stamped<TurnStepEvent>({
        type: "step",
        agentEvent: next.value,
      });
      next = await gen.next();
    }

    result = {
      reply: next.value.reply,
      steps: next.value.steps,
      stopReason: next.value.stopReason,
    };
  } else {
    // ── Proposal confirmation: process directly ─────────────────────
    const reply = input.confirmed
      ? `Proposal ${input.proposalId} confirmed.${
          input.feedback ? ` ${input.feedback}` : ""
        }`
      : `Proposal ${input.proposalId} rejected.`;

    result = { reply, steps: 0, stopReason: "end_turn" };
  }

  // ── turn_end (terminal — always the last event) ───────────────────
  yield stamped<TurnEndEvent>({ type: "turn_end", result });

  return result;
}
