// Harness eval runner (issue #19 / PRD v2 §4.2)。
//
// 通过完整 Loop（pre-gate + post-gate + 工具）回答 eval query。
// 记录每条 case 的响应、步数、工具调用、gate block 次数、违规、耗时。

import type { ModelAdapter, StopReason, ToolHandler } from "../harness/types";
import { consumeTurn, turn } from "../harness/turn";
import { Tracer } from "../harness/tracer";
import type { InteractionStore } from "../lib/drugInteractions";
import type { EvalCase, HarnessResult } from "./types";
import { scoreHarness, EVAL_ERROR_PREFIX } from "./metrics";

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
    let stopReason: StopReason = "end_turn";
    const toolCalls: string[] = [];
    let gateBlocks = 0;

    const shouldRunGate =
      c.userContext !== undefined && interactionStore !== undefined;

    try {
      const result = await consumeTurn(
        turn(
          { tag: "utterance", content: c.query },
          {
            adapter,
            tracer,
            tools,
            userContext: shouldRunGate ? c.userContext : undefined,
            interactionStore: shouldRunGate ? interactionStore : undefined,
          },
        ),
        (event) => {
          // Detect blocked turns by reading gate verdict events directly (issue #34)
          if (event.type === "gate_verdict" && event.verdict === "block") {
            gateBlocks++;
          }

          if (event.type !== "step") {
            return;
          }

          const { agentEvent } = event;
          steps = agentEvent.step; // track last-seen step before potential crash (issue #21)
          if (agentEvent.type === "act" && agentEvent.toolCall) {
            toolCalls.push(agentEvent.toolCall.name);
          }
        },
      );

      reply = result.reply;
      steps = result.steps;
      stopReason = result.stopReason;

      gateBlocks = countGateBlocks(tracer);
    } catch (err) {
      reply = `${EVAL_ERROR_PREFIX}${String(err)}`;
      stopReason = "crash";
      gateBlocks = countGateBlocks(tracer);
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

function countGateBlocks(tracer: Tracer): number {
  return tracer.events().filter((event) => event.type === "gate_block").length;
}
