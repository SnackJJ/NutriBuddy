// Harness eval runner (issue #19 / PRD v2 §4.2)。
//
// 通过完整 Loop（pre-gate + post-gate + 工具）回答 eval query。
// 记录每条 case 的响应、步数、工具调用、gate block 次数、违规、耗时。

import type { ModelAdapter, StopReason, ToolHandler } from "../harness/types";
import { consumeTurn, turn, type AnyTurnEvent } from "../harness/turn";
import { buildTurnEventSink, Tracer } from "../harness/tracer";
import type { InteractionStore } from "../lib/drugInteractions";
import type { Catalog } from "../catalog/catalog";
import type { EvalCase, HarnessResult } from "./types";
import { scoreHarness, EVAL_ERROR_PREFIX } from "./metrics";

/**
 * 对一批 eval case 执行完整 harness 运行。
 *
 * @param adapter — 模型适配器
 * @param tools — 工具调度表
 * @param interactionStore — 药物相互作用数据源（gate 需要）
 * @param catalog — 食物目录（input gate 冲突扫描需要，issue #53）
 */
export async function runHarnessEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
  tools: ReadonlyMap<string, ToolHandler>,
  interactionStore?: InteractionStore,
  catalog?: Catalog,
): Promise<HarnessResult[]> {
  const results: HarnessResult[] = [];

  for (const c of cases) {
    const tracer = new Tracer();
    const start = Date.now();

    let reply = "";
    let steps = 0;
    let stopReason: StopReason = "end_turn";
    const toolCalls: string[] = [];
    let gateVerdictBlocks = 0;

    const turnEvents: AnyTurnEvent[] = [];

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
            catalog,
            userContext: shouldRunGate ? c.userContext : undefined,
            interactionStore: shouldRunGate ? interactionStore : undefined,
          },
        ),
        (event) => {
          turnEvents.push(event);

          if (isBlockedGateVerdict(event)) {
            gateVerdictBlocks++;
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

      tracer.sink(buildTurnEventSink(turnEvents, result.steps));
    } catch (err) {
      reply = `${EVAL_ERROR_PREFIX}${String(err)}`;
      stopReason = "crash";
      tracer.sink(buildTurnEventSink(turnEvents, steps));
    }

    const durationMs = Date.now() - start;
    const scored = scoreHarness(
      reply,
      toolCalls,
      c.expected,
      c.userContext,
      gateVerdictBlocks,
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

function isBlockedGateVerdict(event: AnyTurnEvent): boolean {
  return event.type === "gate_verdict" && event.verdict === "block";
}
