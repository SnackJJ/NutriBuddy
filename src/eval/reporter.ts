// Eval 报告生成器 (issue #19 / PRD v2 §4.2)。
//
// 生成两样输出：
//   1. 对比表 — 每条 eval case | bare LLM passed? | harness passed? | delta
//   2. 关键指标汇总 — 约束违反率、工具调用率、来源合规率、越界转向率

import type {
  BareResult,
  ComparisonRow,
  EvalCase,
  EvalReport,
  EvalSummary,
  HarnessResult,
} from "./types";
import { computeMetrics } from "./metrics";

/** 从结果集生成完整 eval 报告。 */
export function generateReport(
  cases: readonly EvalCase[],
  bareResults: readonly BareResult[],
  harnessResults: readonly HarnessResult[],
): EvalReport {
  const bareMap = new Map(bareResults.map((r) => [r.caseId, r]));
  const harnessMap = new Map(harnessResults.map((r) => [r.caseId, r]));

  const comparison: ComparisonRow[] = cases.map((c) => {
    const bare = bareMap.get(c.id);
    const harness = harnessMap.get(c.id);
    const barePassed = bare?.passed ?? false;
    const harnessPassed = harness?.passed ?? false;

    let delta: string;
    if (barePassed && harnessPassed) {
      delta = "same (both passed)";
    } else if (!barePassed && !harnessPassed) {
      delta = "same (both failed)";
    } else if (!barePassed && harnessPassed) {
      delta = "+harness (harness passed, bare failed)";
    } else {
      delta = "−harness (bare passed, harness failed)";
    }

    return {
      caseId: c.id,
      query: c.query,
      category: c.category,
      barePassed,
      harnessPassed,
      delta,
    };
  });

  const summary = computeMetrics(bareResults, harnessResults);

  const total = cases.length;
  const passed = comparison.filter((r) => r.harnessPassed).length;

  return {
    results: [],
    comparison,
    summary,
    total,
    passed,
    failed: total - passed,
    renderText() {
      return renderTextReport(comparison, summary);
    },
  };
}

/** 渲染人类可读的纯文本报告。 */
function renderTextReport(
  comparison: readonly ComparisonRow[],
  summary: EvalSummary,
): string {
  const lines: string[] = [];

  lines.push("=".repeat(72));
  lines.push("  NutriBuddy Eval Report — Bare LLM vs Harness Baseline");
  lines.push("=".repeat(72));
  lines.push("");

  // ─── Comparison table ─────────────────────────────────────────────────
  lines.push("─ Comparison Table ─");
  lines.push("");
  lines.push(
    "  ID   Category       Bare    Harness  Delta",
  );
  lines.push(
    "  ──── ────────────── ─────── ──────── ──────────────────────────────────",
  );

  for (const row of comparison) {
    const bare = row.barePassed ? "✓ pass" : "✗ FAIL";
    const harness = row.harnessPassed ? "✓ pass" : "✗ FAIL";
    lines.push(
      `  ${row.caseId.padEnd(4)} ${row.category.padEnd(14)} ${bare.padEnd(7)} ${harness.padEnd(8)} ${row.delta}`,
    );
  }

  lines.push("");

  // ─── Summary ──────────────────────────────────────────────────────────
  lines.push("─ Key Metrics Summary ─");
  lines.push("");
  lines.push(`  Total cases:               ${summary.total}`);
  lines.push(`  Bare LLM pass rate:        ${(summary.barePassRate * 100).toFixed(1)}%`);
  lines.push(`  Harness pass rate:         ${(summary.harnessPassRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push(
    `  Constraint violation rate:  bare ${(summary.constraintViolationRate.bare * 100).toFixed(1)}% / harness ${(summary.constraintViolationRate.harness * 100).toFixed(1)}%`,
  );
  lines.push(
    `  Tool call rate (harness):   ${(summary.toolCallRate * 100).toFixed(1)}%`,
  );
  lines.push(
    `  Source compliance rate:     bare ${(summary.sourceComplianceRate.bare * 100).toFixed(1)}% / harness ${(summary.sourceComplianceRate.harness * 100).toFixed(1)}%`,
  );
  lines.push(
    `  Gate turn rate (harness):   ${(summary.gateTurnRate * 100).toFixed(1)}%`,
  );
  lines.push("");
  lines.push("=".repeat(72));

  return lines.join("\n");
}
