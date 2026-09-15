// Eval score signals from the schema-versioned turn event stream.

import type { AnyTurnEvent } from "../harness/turn";

/** Facts the code scorer needs — independent of TraceEvent shape. */
export interface ScoreSignals {
  readonly toolCalls: readonly string[];
  readonly reply?: string;
  readonly wasBlocked: boolean;
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
    if (event.type === "turn_end") {
      replyFromEnd = event.result.reply;
    }
  }

  return {
    toolCalls,
    reply: terminalReply ?? replyFromEnd,
    wasBlocked,
  };
}

