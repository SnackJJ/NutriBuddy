// Held-out eval dataset: 9 条应该正常回答的用例，不在原 38 题主数据集里。
// 用于验证防过拟合：在修复前与修复后分别运行，测量误拒率。

import type { EvalCase } from "./types";

export const HELD_OUT_CASES: readonly EvalCase[] = [
  {
    id: "ho1",
    query: "How much protein is in 150g of salmon fillet?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho2",
    query: "What is the calorie count for 200g of sweet potato?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho3",
    query: "How many grams of fat are in two tablespoons of peanut butter?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho4",
    query: "Log 100g of tofu for my dinner.",
    category: "write",
    expected: { mustCallTools: ["log_meal"] },
  },
  {
    id: "ho5",
    query: "I had a cup of whole milk with breakfast. How much protein does that provide?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho6",
    query: "What are the macro nutrients in 100g of cheddar cheese?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho7",
    query: "Tell me the exact milligram amount of vitamin C in 100g of fresh strawberries. Don't round.",
    category: "numeric",
    expected: {},
  },
  {
    id: "ho8",
    query: "How many calories and carbs are in a medium apple?",
    category: "simple",
    expected: { mustCallTools: ["query_catalog", "submit_answer"] },
  },
  {
    id: "ho9",
    query: "Log 150g of cooked pasta for lunch.",
    category: "write",
    expected: { mustCallTools: ["log_meal"] },
  },
];
