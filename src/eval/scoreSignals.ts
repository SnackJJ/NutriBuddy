// Phase 3 — eval score signals from the schema-versioned turn event stream.
// Turn events are the source of truth for tool/gate facts; TraceEvent is demoted.

import type { AnyTurnEvent } from "../harness/turn";
import type { TraceEvent } from "../harness/tracer";

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

/** Demoted TraceEvent adapter — only for legacy producers/tests. */
export function scoreSignalsFromTrace(
  trace: readonly TraceEvent[],
): ScoreSignals {
  const toolCalls = trace
    .filter((e) => e.type === "tool_call")
    .map((e) => extractToolNameFromTracePayload(e.payload));

  let reply: string | undefined;
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i].type === "model_return") {
      reply = trace[i].payload;
      break;
    }
  }

  return {
    toolCalls,
    reply,
    wasBlocked: trace.some((e) => e.type === "gate_block"),
  };
}

function extractToolNameFromTracePayload(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      const name = (parsed as { name: unknown }).name;
      if (typeof name === "string") return name.trim();
    }
  } catch {
    // bare tool name
  }
  return payload.trim();
}
