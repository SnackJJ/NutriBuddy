// ⑦ Tracer：记录 turn 内每一步（模型看到什么 / 决定什么 / 返回什么）。
// 早做可观测，debug 快十倍（PRD §10）。本切片记录三类事件：用户输入、
// 发给模型的最终 prompt、模型返回；外加 loop 撞上限的标记。

export type TraceEventType =
  | "user_input"
  | "model_prompt"
  | "model_return"
  | "max_steps_reached"
  // 下列两类由后续 ToolRegistry / Verifier 切片产出；先在共享词表里登记，
  // 让 eval 代码评分器（issue #6）能按真实 trace 形状读「调了哪个工具 / 是否被 post-gate 硬拦」。
  // tool_call 的 payload 约定为工具名（或 JSON {name,args}）；post_gate_blocked 出现即代表被拦。
  | "tool_call"
  | "post_gate_blocked";

export interface TraceInput {
  readonly step: number;
  readonly type: TraceEventType;
  readonly payload: string;
}

export interface TraceEvent extends TraceInput {
  /** 进入 tracer 的顺序，从 0 起；保证渲染顺序稳定、可测。 */
  readonly seq: number;
}

export class Tracer {
  private readonly log: TraceEvent[] = [];

  record(event: TraceInput): void {
    this.log.push({ ...event, seq: this.log.length });
  }

  events(): TraceEvent[] {
    return [...this.log];
  }

  render(): string {
    return this.log
      .map((e) => `#${e.seq} [step ${e.step}] ${e.type}: ${e.payload}`)
      .join("\n");
  }
}
