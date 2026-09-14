// Harness eval runner (issue #19 / PRD v2 §4.2)。
//
// 通过完整 Loop（pre-gate + post-gate + 工具）回答 eval query。
// 记录每条 case 的响应、步数、工具调用、gate block 次数、违规、耗时。

import type {
  ModelAdapter,
  StopReason,
  ToolHandler,
  ToolSchema,
} from "../harness/types";
import { consumeTurn, turn, type AnyTurnEvent } from "../harness/turn";
import { Tracer } from "../harness/tracer";
import type { InteractionStore } from "../lib/drugInteractions";
import type { Catalog } from "../catalog/catalog";
import type { EvalCase, HarnessResult } from "./types";
import { scoreHarness, EVAL_ERROR_PREFIX } from "./metrics";
import { scoreSignalsFromTurnEvents } from "./scoreSignals";

/**
 * 对一批 eval case 执行完整 harness 运行。
 *
 * @param adapter — 模型适配器
 * @param tools — 工具调度表
 * @param interactionStore — 药物相互作用数据源（gate 需要）
 * @param catalog — 食物目录（input gate 冲突扫描需要，issue #53）
 * @param toolSchemas — 发给模型的工具定义。**不传等于模型看不到工具**：那时
 *   `mustCallTools` 类的 case 必失败，而失败原因是评测配置而不是 harness 能力，
 *   报告却分辨不出来。live 手臂必须传产品实际使用的那组 schema。
 */
export async function runHarnessEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
  tools: ReadonlyMap<string, ToolHandler>,
  interactionStore?: InteractionStore,
  catalog?: Catalog,
  toolSchemas?: readonly ToolSchema[],
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
            toolSchemas,
            catalog,
            userContext: shouldRunGate ? c.userContext : undefined,
            interactionStore: shouldRunGate ? interactionStore : undefined,
            // turn() turns a fatal error into a crash terminal instead of
            // throwing (RFC 0008 §3.6), so the runner's own error text has to
            // ride the port: scoring keys off EVAL_ERROR_PREFIX.
            crashReply: (err) => `${EVAL_ERROR_PREFIX}${String(err)}`,
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
    } catch (err) {
      // Safety net only: turn() reports its own fatal errors as a crash terminal
      // (RFC 0008 §3.6), and `crashReply` above already put this text in the
      // reply. Reaching here means the failure was outside the seam.
      reply = `${EVAL_ERROR_PREFIX}${String(err)}`;
      stopReason = "crash";
    }

    // Phase 3: score from turn-event facts, not TraceEvent tool_call/gate_block.
    const signals = scoreSignalsFromTurnEvents(turnEvents, reply);
    const scoredToolCalls =
      signals.toolCalls.length > 0 ? signals.toolCalls : toolCalls;
    const scoredBlocks = signals.wasBlocked
      ? Math.max(1, gateVerdictBlocks)
      : gateVerdictBlocks;

    const durationMs = Date.now() - start;
    const scored = scoreHarness(
      reply,
      scoredToolCalls,
      c.expected,
      c.userContext,
      scoredBlocks,
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
