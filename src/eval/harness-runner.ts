// Harness eval runner (issue #19 / PRD v2 §4.2)。
//
// 通过完整 Loop（pre-gate + post-gate + 工具）回答 eval query。
// 记录每条 case 的响应、步数、工具调用、gate block 次数、违规、耗时。

import type { ModelAdapter, StopReason, ToolHandler } from "../harness/types";
import { consumeTurn, turn, type AnyTurnEvent } from "../harness/turn";
import { Tracer, type TurnEventSink } from "../harness/tracer";
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
    let gateVerdictBlocks = 0;

    // Issue #50: 收集 turn 事件流用于 gate block 计数和 tracer sink。
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

      // Issue #50: gate blocks 仅从 turn 事件流（gate_verdict verdict="block"）计数，
      // 不再从 tracer 的 gate_block 事件计数，消除 Math.max 双重计数 workaround。
      tracer.sink(buildSinkFromTurnEvents(turnEvents, result.steps));
    } catch (err) {
      reply = `${EVAL_ERROR_PREFIX}${String(err)}`;
      stopReason = "crash";
      tracer.sink(buildSinkFromTurnEvents(turnEvents, steps));
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

/**
 * Issue #50: 从 turn 事件流提取工具调用和 gate 拦截信息，构建 tracer 渲染 sink。
 * 替换原先的 Math.max 双重计数 workaround——gate block 现在仅从 gate_verdict
 * 事件（verdict="block"）计数。
 */
function buildSinkFromTurnEvents(
  events: readonly AnyTurnEvent[],
  steps: number,
): TurnEventSink {
  const toolCalls: { step: number; name: string; args: Readonly<Record<string, unknown>> }[] = [];
  const gateBlocks: { step: number; evidence: string }[] = [];

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
        step: steps,
        evidence: event.evidence,
      });
    }
  }

  return { toolCalls, gateBlocks };
}
