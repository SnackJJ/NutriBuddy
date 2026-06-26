// Eval runner（issue #6）：把全量 eval case 各跑成一条 trace（注入的 producer 负责）、
// 逐条过 CodeScorer、聚合成报告。producer 抛错 = 该 case 判失败（不让单条把整轮跑崩）。

import type { EvalCase, EvalReport, ScoreResult, TraceProducer } from "./types";
import { scoreCase } from "./scorer";

export async function runEval(
  cases: readonly EvalCase[],
  produceTrace: TraceProducer,
): Promise<EvalReport> {
  const results: ScoreResult[] = [];

  for (const evalCase of cases) {
    try {
      const trace = await produceTrace(evalCase);
      results.push(scoreCase(evalCase, trace));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({
        name: evalCase.name,
        passed: false,
        failures: [
          { check: "must_call_tools", detail: `trace 生产失败: ${detail}` },
        ],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    total: results.length,
    passed,
    failed: results.length - passed,
  };
}
