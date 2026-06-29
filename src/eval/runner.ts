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
        caseId: evalCase.id,
        passed: false,
        failures: [
          { check: "trace_producer", detail: `trace 生产失败: ${detail}` },
        ],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    comparison: [],
    summary: {
      total: results.length,
      barePassRate: 0,
      harnessPassRate: 0,
      constraintViolationRate: { bare: 0, harness: 0 },
      toolCallRate: 0,
      sourceComplianceRate: { bare: 0, harness: 0 },
      gateTurnRate: 0,
    },
    total: results.length,
    passed,
    failed: results.length - passed,
    renderText() {
      // 降级渲染：仅代码评分结果，不含 baseline 对比。
      const lines = results.map(
        (r) => `${r.passed ? "PASS" : "FAIL"} ${r.caseId}` +
          r.failures.map((f) => `\n  - [${f.check}] ${f.detail}`).join(""),
      );
      lines.push(`\n总计 ${passed}/${results.length} 通过。`);
      return lines.join("\n");
    },
  };
}
