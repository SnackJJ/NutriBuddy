// ⑦ Tracer：记录 turn 内每一步（模型看到什么 / 决定什么 / 返回什么）。
// 早做可观测，debug 快十倍（PRD §10）。
//
// Loop 仍直接记录内部事件；工具调用和 gate block 从 turn 事件流派生，
// 再作为 render()/events() 可消费的 trace 事件暴露。

import type { AnyTurnEvent } from "./turn";

export const TRACE_EVENT_TYPES = [
  "user_input",
  "model_prompt",
  "model_return",
  "max_steps_reached",
  "gate_block",
  "tool_call",
  "observation",
  "model_call_usage",
] as const;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export interface TraceInput {
  readonly step: number;
  readonly type: TraceEventType;
  readonly payload: string;
}

export interface TraceEvent extends TraceInput {
  /** 进入 tracer 的顺序，从 0 起；保证渲染顺序稳定、可测。 */
  readonly seq: number;
}

export interface TurnEventSink {
  readonly toolCalls: readonly {
    readonly step: number;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  }[];
  readonly gateBlocks: readonly {
    readonly step: number;
    readonly evidence: string;
  }[];
}

type TurnEventSinkToolCall = TurnEventSink["toolCalls"][number];
type TurnEventSinkGateBlock = TurnEventSink["gateBlocks"][number];

export function buildTurnEventSink(
  events: readonly AnyTurnEvent[],
  terminalStep: number,
): TurnEventSink {
  const toolCalls: TurnEventSinkToolCall[] = [];
  const gateBlocks: TurnEventSinkGateBlock[] = [];

  for (const event of events) {
    if (
      event.type === "step" &&
      event.agentEvent.type === "act" &&
      event.agentEvent.toolCall
    ) {
      toolCalls.push({
        step: event.agentEvent.step,
        name: event.agentEvent.toolCall.name,
        args: event.agentEvent.toolCall.args,
      });
    }

    if (event.type === "gate_verdict" && event.verdict === "block") {
      gateBlocks.push({
        step: terminalStep,
        evidence: event.evidence,
      });
    }
  }

  return { toolCalls, gateBlocks };
}

export class Tracer {
  private readonly log: TraceEvent[] = [];
  private sinkSnapshot: TurnEventSink | null = null;

  record(event: TraceInput): void {
    this.log.push({ ...event, seq: this.log.length });
  }

  /** Replace the derived turn-event snapshot used by render()/events(). */
  sink(entries: TurnEventSink): void {
    this.sinkSnapshot = entries;
  }

  events(): TraceEvent[] {
    return [...this.log, ...this.deriveSinkEvents()];
  }

  render(): string {
    return [...this.log, ...this.deriveSinkEvents()]
      .map((e) => `#${e.seq} [step ${e.step}] ${e.type}: ${e.payload}`)
      .join("\n");
  }

  private deriveSinkEvents(): TraceEvent[] {
    if (!this.sinkSnapshot) return [];

    const derived: TraceEvent[] = [];
    let seq = this.log.length;

    for (const tc of this.sinkSnapshot.toolCalls) {
      derived.push({
        seq: seq++,
        step: tc.step,
        type: "tool_call",
        payload: JSON.stringify({ name: tc.name, args: tc.args }),
      });
    }

    for (const gb of this.sinkSnapshot.gateBlocks) {
      derived.push({
        seq: seq++,
        step: gb.step,
        type: "gate_block",
        payload: gb.evidence,
      });
    }

    return derived;
  }
}
