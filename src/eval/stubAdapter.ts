// The scripted adapter and tools (S2 / #94).
//
// Both entry points need the same offline behaviour — `npm run eval` prints it,
// `npm run eval:report` writes it into a report — and a report is only
// comparable with another report if the scripted arm behaves identically. So the
// stubs live here and not in either entry point.
//
// Some replies deliberately violate the constrained/cross-domain cases (peanut
// for a peanut allergy, kale for warfarin, …). That is the point: the scoring
// pipeline is only exercised end to end if the scripted arm actually fails
// something, and a stub that passes everything would make every metric a
// constant.

import type { ModelAdapter, ModelRequest, ModelResponse, ToolHandler } from "../harness/types";
import type { EvalCase } from "./types";

function violatingReplies(): Record<string, string> {
  return {
    c1: "I recommend peanut butter on whole-grain crackers — it's a great high-protein snack.",
    c2: "Drink more milk and eat yogurt — dairy is an excellent calcium source.",
    x1: "A kale smoothie is an extremely healthy breakfast! Kale is packed with nutrients.",
    x3: "Aged cheese and soy sauce are delicious condiments. Enjoy them in moderation!",
  };
}

const CATEGORY_HINTS: Record<string, string> = {
  simple: "This is a simulated nutritional response with evidence-based information.",
  constrained: "Here are safe food recommendations that avoid your allergens.",
  numeric:
    "Nutritional values vary by source and preparation method. Consult USDA FoodData Central for precise figures.",
  cross_domain: "Based on your medication profile, here are safe dietary recommendations.",
  edge_case: "This is a reasonable nutritional response to your query.",
};

function stubResponse(evalCase: EvalCase): string {
  const violations = violatingReplies();
  const violating = violations[evalCase.id];
  if (violating) return violating;
  // The generic reply deliberately does NOT echo the query: the query itself can
  // contain a mustNotContain term (x2's "grapefruit"), and echoing it would turn
  // every constrained case into a failure for the wrong reason.
  return `[stub] ${CATEGORY_HINTS[evalCase.category] ?? "This is a simulated nutritional response."}`;
}

export function createStubAdapter(cases: readonly EvalCase[]): ModelAdapter {
  return {
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      const userMessage = request.messages.find((m) => m.role === "user");
      const prompt = userMessage?.content ?? "";
      const matched = cases.find((c) => c.query === prompt);
      return {
        content: matched ? stubResponse(matched) : "Generic nutritional advice response.",
        stop: true,
      };
    },
  };
}

/** Scripted tool handler: canned data for the foods the dataset asks about. */
export function createStubTools(): Map<string, ToolHandler> {
  const handler: ToolHandler = async (args) => {
    const food = String(args.food ?? "");
    const canned: Record<string, string> = {
      "chicken breast": "chicken breast (100g): 165 kcal, 31g protein, 0g carbs",
      avocado: "avocado (medium, 150g): 240 kcal, 3g protein, 13g carbs",
      "white rice": "white rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
      salmon: "salmon (100g): 208 kcal, 20g protein, 0g carbs, rich in omega-3",
      egg: "large egg (50g): 72 kcal, 6g protein, 0.4g carbs",
      rice: "rice, cooked (1 cup, 158g): 205 kcal, 4g protein, 45g carbs",
    };

    const key = food.toLowerCase();
    for (const [name, value] of Object.entries(canned)) {
      if (key.includes(name)) return value;
    }
    return `${food}: unknown (no USDA data available)`;
  };

  return new Map([["query_catalog", handler]]);
}
