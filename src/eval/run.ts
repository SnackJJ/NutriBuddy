// `npm run eval`（issue #6 / PRD §4.1）：跑全量 eval 集、过代码评分器、打印报告。
//
//   npm run eval            # pending 模式：打印 toolless baseline，框架自检，恒返回 0
//   npm run eval -- --strict  # 任一 case 失败即非零退出（接真实 producer 后做 CI 回归闸）
//
// Offline fixtures use TraceProducer; harness truth uses turn() (Phase 3/4). 本切片用
// pendingProducer（空 trace）占位——此时凡需工具/拦截/追问的 case 都「失败」，是诚实的
// 无 harness 基线，而非框架 bug，故默认（非 strict）不让它把 CI 染红。

import { loadEvalCases } from "./dataset";
import { runEval } from "./runner";
import type { EvalCategory, EvalReport, TraceProducer } from "./types";

/** 占位 producer：无 live agent，返回空 trace。接真实 harness 后替换。 */
export const pendingProducer: TraceProducer = async () => [];

const CATEGORIES: readonly EvalCategory[] = [
  "simple",
  "constrained",
  "numeric",
  "cross_domain",
  "edge_case",
];

function formatReport(report: EvalReport, strict: boolean): string {
  const lines: string[] = [];
  const cases = loadEvalCases();
  const byId = new Map(cases.map((c) => [c.id, c.category] as const));

  lines.push("=== NutriBuddy 代码评 (CodeScorer) ===");
  if (!strict) {
    lines.push(
      "[pending] 无 live agent，使用空 trace；以下为无 harness baseline，非框架故障。",
    );
  }

  for (const cat of CATEGORIES) {
    const inCat = report.results.filter((r) => byId.get(r.caseId) === cat);
    const pass = inCat.filter((r) => r.passed).length;
    lines.push(`\n${cat}  (${pass}/${inCat.length})`);
    for (const r of inCat) {
      lines.push(`  ${r.passed ? "PASS" : "FAIL"}  ${r.caseId}`);
      for (const f of r.failures) {
        lines.push(`        - [${f.check}] ${f.detail}`);
      }
    }
  }

  lines.push(
    `\n总计 ${report.passed}/${report.total} 通过、${report.failed} 失败。`,
  );
  return lines.join("\n") + "\n";
}

export interface RunDeps {
  readonly produceTrace?: TraceProducer;
  readonly stdout?: (s: string) => void;
}

export async function main(
  argv: readonly string[] = [],
  deps: RunDeps = {},
): Promise<number> {
  const strict = argv.includes("--strict");
  const produceTrace = deps.produceTrace ?? pendingProducer;
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));

  const cases = loadEvalCases();
  const report = await runEval(cases, produceTrace);
  stdout(formatReport(report, strict));

  // strict：有失败即非零（CI 回归闸）。非 strict（pending baseline）：恒 0，框架本身绿即可。
  return strict && report.failed > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1]?.endsWith("run.ts") ?? false;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `错误: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
