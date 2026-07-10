// ⑦ Tracer：记录 turn 内每一步（模型看到什么 / 决定什么 / 返回什么）。
// 早做可观测，debug 快十倍（PRD §10）。
//
// Issue #50：Tracer 降级为 turn 事件流的渲染 sink。`tool_call` 和
// `gate_block` 不再由 loop/turn 直接录制，而是从 turn 事件流中提取。
// 内部事件（user_input / model_prompt / model_return / max_steps_reached）
// 仍由 loop 录制，保持 CLI trace 渲染等效。

export const TRACE_EVENT_TYPES = [
  "user_input",
  "model_prompt",
  "model_return",
  "max_steps_reached",
  "gate_block",
  "tool_call",
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

/**
 * Turn event sink payload：从 turn 事件流提取的可渲染信息。
 * 调用方（CLI / eval runner）从 AnyTurnEvent[] 中提取后喂入 tracer，
 * tracer 将其转换为等效的 TraceEvent 供 render() 消费。
 */
export interface TurnEventSink {
  /** 从 step (act) 事件提取的工具调用。 */
  readonly toolCalls: readonly {
    step: number;
    name: string;
    args: Readonly<Record<string, unknown>>;
  }[];
  /** 从 gate_verdict (verdict="block") 事件提取的拦截记录。 */
  readonly gateBlocks: readonly { step: number; evidence: string }[];
}

export class Tracer {
  private readonly log: TraceEvent[] = [];
  private sinkSnapshot: TurnEventSink | null = null;

  record(event: TraceInput): void {
    this.log.push({ ...event, seq: this.log.length });
  }

  /**
   * 喂入 turn 事件流提取的渲染信息。
   * 调用方在 turn 完成后调用一次；重复调用以最后一次为准。
   */
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
