#!/usr/bin/env npx tsx
// Eval 入口：Bare LLM vs Harness baseline 对比 (issue #19 / PRD v2 §4.2)。
//
// 用法：
//   npm run eval                    # 使用 stub adapter（CI / 框架验证）
//   npm run eval -- --live          # 使用真实 DeepSeek API（需 DEEPSEEK_API_KEY）
//   npm run eval -- --stub          # 显式使用 stub adapter（默认行为）
//
// Stub 模式：每条 case 返回预置的简单回复，验证 eval 框架的评分/报告管道。
// Live 模式：通过 DeepSeekAdapter 真实调用 LLM，产出有意义的 baseline 数据。

import { loadEvalCases } from "./dataset";
import { runBareEval } from "./bare-runner";
import { runHarnessEval } from "./harness-runner";
import { generateReport } from "./reporter";
import { DeepSeekAdapter } from "../harness/modelAdapter";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolHandler } from "../harness/types";
import type { InteractionStore } from "../lib/drugInteractions";
import type { EvalCase } from "./types";
import { createCatalog, SEED_FOODS } from "../catalog/catalog";
import { createStubAdapter, createStubTools } from "./stubAdapter";

// ─── Stub adapter（CI / 离线验证）─────────────────────────────────────────
//
// 与 `npm run eval:report` 共用同一份 stub（src/eval/stubAdapter.ts）：脚本模式
// 的两次运行要可比较，前提是两处入口的离线行为逐字一致。
/** Stub interaction store: returns empty (no real DB access). */
function stubInteractionStore(): InteractionStore {
  return { all: async () => [] };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");

  console.log(
    live
      ? "Running eval in LIVE mode (DeepSeek API)...\n"
      : "Running eval in STUB mode (offline framework validation)...\n",
  );

  const cases = loadEvalCases();
  console.log(`Loaded ${cases.length} eval cases.\n`);

  let adapter: ModelAdapter;
  let tools: Map<string, ToolHandler>;
  let interactionStore: InteractionStore;

  if (live) {
    adapter = new DeepSeekAdapter();
    tools = new Map(); // No real tools yet — harness run tests gate + loop structure
    interactionStore = stubInteractionStore(); // No Supabase in CLI eval
  } else {
    adapter = createStubAdapter(cases);
    tools = createStubTools();
    interactionStore = stubInteractionStore();
  }

  // ── Bare LLM baseline ──────────────────────────────────────────────
  console.log("Running bare LLM baseline...");
  const bareStart = Date.now();
  const bareResults = await runBareEval(cases, adapter);
  const bareDuration = Date.now() - bareStart;
  console.log(`  Done in ${bareDuration}ms. ${bareResults.filter((r) => r.passed).length}/${bareResults.length} passed.\n`);

  // ── Harness run ────────────────────────────────────────────────────
  console.log("Running harness eval...");
  const harnessStart = Date.now();
  const harnessResults = await runHarnessEval(
    cases,
    adapter,
    tools,
    interactionStore,
    createCatalog(SEED_FOODS),
  );
  const harnessDuration = Date.now() - harnessStart;
  console.log(`  Done in ${harnessDuration}ms. ${harnessResults.filter((r) => r.passed).length}/${harnessResults.length} passed.\n`);

  // ── Report ─────────────────────────────────────────────────────────
  const report = generateReport(cases, bareResults, harnessResults);
  console.log(report.renderText());
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
