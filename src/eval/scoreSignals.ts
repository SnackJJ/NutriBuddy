// Eval score signals from the schema-versioned turn event stream.

import type { AnyTurnEvent } from "../harness/turn";

/**
 * Check names the citation gate emits (RFC 0011 §3.5).
 *
 * Duplicated from `turn.ts`'s module-private constants, and deliberately: the
 * strings are part of the event contract a reader of a trace relies on, and a
 * scorer that imported the emitter's constant would silently follow a rename
 * that broke every stored trace. A test asserts the two still agree.
 */
export const CITATION_PROVENANCE_CHECK = "citation_provenance";
export const CITATION_ASSERTION_CHECK = "citation_assertion";

/** Facts the code scorer needs — independent of TraceEvent shape. */
export interface ScoreSignals {
  readonly toolCalls: readonly string[];
  readonly reply?: string;
  readonly wasBlocked: boolean;
  /** Tier-1: at least one citation was stripped for failing the provenance check. */
  readonly citationStripped: boolean;
  /** Tier-2: the answer claimed authority without citing — the regenerate path. */
  readonly citationClaimedWithoutSource: boolean;
}

/**
 * Extract score signals from a real turn() event stream (+ terminal reply).
 * Tool names come from act steps; blocks from gate_verdict.verdict === "block".
 */
export function scoreSignalsFromTurnEvents(
  events: readonly AnyTurnEvent[],
  terminalReply?: string,
): ScoreSignals {
  const toolCalls: string[] = [];
  let wasBlocked = false;
  let citationStripped = false;
  let citationClaimedWithoutSource = false;
  let replyFromEnd: string | undefined;

  for (const event of events) {
    if (
      event.type === "step" &&
      event.agentEvent.type === "act" &&
      event.agentEvent.toolCall
    ) {
      toolCalls.push(event.agentEvent.toolCall.name);
    }
    if (event.type === "gate_verdict" && event.verdict === "block") {
      wasBlocked = true;
    }
    if (event.type === "gate_verdict" && event.verdict !== "pass") {
      // The two citation verdicts are told apart by their check name, which is
      // stable contract rather than coincidence: `terminal` carries the same
      // distinction as data, and the RFC forbids reading the severity off the
      // name alone.
      if (event.checkName === CITATION_PROVENANCE_CHECK) citationStripped = true;
      if (event.checkName === CITATION_ASSERTION_CHECK) {
        citationClaimedWithoutSource = true;
      }
    }
    if (event.type === "turn_end") {
      replyFromEnd = event.result.reply;
    }
  }

  return {
    toolCalls,
    reply: terminalReply ?? replyFromEnd,
    wasBlocked,
    citationStripped,
    citationClaimedWithoutSource,
  };
}

