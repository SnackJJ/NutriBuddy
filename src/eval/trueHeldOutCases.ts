// True Held-Out Evaluation Cases
// 11 diverse, safe, answerable nutritional questions across different foods,
// question formats, and dietary context. Kept strictly separate from the
// original 38 cases and the dev set.

import type { EvalCase } from "./types";

export const TRUE_HELD_OUT_CASES: readonly EvalCase[] = [
  {
    id: "tho1",
    query: "Is plain Greek yogurt higher in protein than regular plain yogurt?",
    category: "simple",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho2",
    query: "What are some good dietary sources of iron for someone who eats lentils and chickpeas?",
    category: "descriptive",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho3",
    query: "Can you give me an overview of the macronutrient profile of walnuts per 100 grams?",
    category: "simple",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho4",
    query: "How does steaming versus boiling vegetables affect water-soluble nutrients in general?",
    category: "descriptive",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho5",
    query: "I'm curious about oats — what kind of carbohydrates and fiber do they mostly contain?",
    category: "descriptive",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho6",
    query: "Roughly how many calories are in 100g of roasted turkey breast without skin?",
    category: "simple",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho7",
    query: "Could you explain what complete proteins are and whether combining beans with rice provides them?",
    category: "descriptive",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho8",
    query: "What is the typical fat content of 100g of extra virgin olive oil?",
    category: "simple",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho9",
    query: "Can you log 120g of cooked quinoa for my lunch?",
    category: "write",
    expected: {
      mustCallTools: ["log_meal"],
      maxTurns: 3,
    },
  },
  {
    id: "tho10",
    query: "Why are chia seeds often recommended in healthy diets, and what macronutrients do they provide?",
    category: "descriptive",
    expected: {
      maxTurns: 3,
    },
  },
  {
    id: "tho11",
    query: "If I eat a 100g serving of canned tuna in water, what are the primary macronutrients?",
    category: "simple",
    expected: {
      maxTurns: 3,
    },
  },
];
