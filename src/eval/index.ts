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

// ─── Stub adapter（CI / 离线验证）─────────────────────────────────────────
//
// 每个 case 返回与 query 部分相关的固定回复，确定性且不依赖网络。
// 部分回复故意包含违规内容（过敏原 / 冲突食物），以便验证评分管道。

const VIOLATING_QUERIES = new Set([
  "c1", // peanut allergy → stub 会推荐 peanut butter
  "c2", // milk allergy → stub 会推荐 milk
  "x1", // warfarin → stub 会推荐 kale
  "x3", // phenelzine → stub 会推荐 aged cheese
]);

function stubResponse(c: EvalCase): string {
  const safeReplies: Record<string, string> = {
    c1: "I recommend peanut butter on whole-grain crackers — it's a great high-protein snack.",
    c2: "Drink more milk and eat yogurt — dairy is an excellent calcium source.",
    x1: "A kale smoothie is an extremely healthy breakfast! Kale is packed with nutrients.",
    x3: "Aged cheese and soy sauce are delicious condiments. Enjoy them in moderation!",
  };

  if (safeReplies[c.id]) return safeReplies[c.id];

  // Generic safe response — intentionally does NOT echo query text, since
  // the query itself may contain mustNotContain terms (e.g. "grapefruit").
  const categoryHints: Record<string, string> = {
    simple: "This is a simulated nutritional response with evidence-based information.",
    constrained: "Here are safe food recommendations that avoid your allergens.",
    numeric: "Nutritional values vary by source and preparation method. Consult USDA FoodData Central for precise figures.",
    cross_domain: "Based on your medication profile, here are safe dietary recommendations.",
    edge_case: "This is a reasonable nutritional response to your query.",
  };
  return `[stub] ${categoryHints[c.category] ?? "This is a simulated nutritional response."}`;
}

function stubAdapter(): ModelAdapter {
  return {
    generate: async (req: ModelRequest): Promise<ModelResponse> => {
      // Extract the query from the user message
      const userMsg = req.messages.find((m) => m.role === "user");
      const prompt = userMsg?.content ?? "";

      // Match to an eval case by finding the query text
      const cases = loadEvalCases();
      const matched = cases.find((c) => c.query === prompt);

      return {
        content: matched ? stubResponse(matched) : "Generic nutritional advice response.",
        stop: true,
      };
    },
  };
}

/** Stub tool handler: returns pre-canned data for known foods. */
function stubTools(): Map<string, ToolHandler> {
  const handler: ToolHandler = async (args) => {
    const food = String(args.food ?? "");
    const canned: Record<string, string> = {
      "chicken breast": "chicken breast (100g): 165 kcal, 31g protein, 0g carbs",
      "avocado": "avocado (medium, 150g): 240 kcal, 3g protein, 13g carbs",
      "white rice": "white rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
      "salmon": "salmon (100g): 208 kcal, 20g protein, 0g carbs, rich in omega-3",
      "egg": "large egg (50g): 72 kcal, 6g protein, 0.4g carbs",
      "rice": "rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
    };

    const key = food.toLowerCase();
    for (const [k, v] of Object.entries(canned)) {
      if (key.includes(k)) return v;
    }
    return `${food}: unknown (no USDA data available)`;
  };

  return new Map([["search_food", handler]]);
}

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
    adapter = stubAdapter();
    tools = stubTools();
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
