// Harness eval runner (issue #19 / PRD v2 §4.2)。
//
// 通过完整 Loop（pre-gate + post-gate + 工具）回答 eval query。
// 记录每条 case 的响应、步数、工具调用、gate block 次数、违规、耗时。

import type { ModelAdapter, AgentEvent, TerminalResult, ToolHandler } from "../harness/types";
import { run } from "../harness/loop";
import { Tracer } from "../harness/tracer";
import type { InteractionStore } from "../lib/drugInteractions";
import type { EvalCase, HarnessResult } from "./types";
import { scoreHarness } from "./metrics";

/**
 * 对一批 eval case 执行完整 harness 运行。
 *
 * @param adapter — 模型适配器
 * @param tools — 工具调度表
 * @param interactionStore — 药物相互作用数据源（gate 需要）
 */
export async function runHarnessEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
  tools: ReadonlyMap<string, ToolHandler>,
  interactionStore?: InteractionStore,
): Promise<HarnessResult[]> {
  const results: HarnessResult[] = [];

  for (const c of cases) {
    const tracer = new Tracer();
    const start = Date.now();

    let reply = "";
    let steps = 0;
    let stopReason: TerminalResult["stopReason"] = "end_turn";
    const toolCalls: string[] = [];
    let gateBlocks = 0;

    // 仅 constrained / cross_domain 类别的 case 启用 gate
    const hasGate = c.userContext && interactionStore;

    try {
      const gen = run({
        userInput: c.query,
        adapter,
        tracer,
        tools,
        userContext: hasGate ? c.userContext : undefined,
        interactionStore: hasGate ? interactionStore : undefined,
      });

      let next = await gen.next();
      while (!next.done) {
        const event = next.value;
        steps = event.step; // track last-seen step before potential crash
        if (event.type === "act" && event.toolCall) {
          toolCalls.push(event.toolCall.name);
        }
        // Track gate blocks via tracer
        next = await gen.next();
      }

      reply = next.value.reply;
      steps = next.value.steps;
      stopReason = next.value.stopReason;

      // Count gate blocks from tracer
      gateBlocks = tracer
        .events()
        .filter((e) => e.type === "gate_block")
        .length;
    } catch (err) {
      reply = `[ERROR] ${String(err)}`;
      stopReason = "crash";
    }

    const durationMs = Date.now() - start;
    const scored = scoreHarness(
      reply,
      toolCalls,
      c.expected,
      c.userContext,
      gateBlocks,
    );

    results.push({
      caseId: c.id,
      response: reply,
      steps,
      stopReason,
      passed: scored.passed,
      violations: scored.violations,
      toolCalls: scored.toolCalls,
      gateBlocks: scored.gateBlocks,
      durationMs,
    });
  }

  return results;
}
