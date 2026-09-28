// The live report's d1 (2026-09-17T13-20-57Z-v1.1-live-retrieval) ended in
// gate_blocked, and the refusal's first reason was the numeric provenance gate:
//   Ungrounded numeric fact: "150 g" (value 150 g) does not trace to any observation column.
//
// "150 g" is the user's own words ("about 150g with rice"). Reasons are listed in
// check order — lexical backstop, entity, numeric, advisory — so a numeric reason
// in first place also says the allergen checks passed on the final attempt: the
// input gate classified the ask as descriptive and the shrimp mention was exempt.
// w2 ("Log 250g of grilled salmon", no allergy profile) was blocked the same way,
// which rules the allergen path out as a necessary cause.
//
// This file replays that turn with a scripted adapter: log_meal with the user's
// portion, then submit_answer restating it. No model is called.

import { describe, expect, it } from "vitest";
import { consumeTurn, turn, type AnyTurnEvent } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import { createCatalog, SEED_FOODS } from "../src/catalog/catalog";
import { createLogMealHandler, LOG_MEAL_SCHEMA } from "../src/harness/logMeal";
import type { ModelAdapter, ToolCall } from "../src/harness/types";
import { createInMemoryProposalStore } from "./helpers/inMemoryProposalStore";

const USER = "user-d1";
const catalog = createCatalog(SEED_FOODS);

/** log_meal first, then submit_answer with `prose` — the shape d1's model took. */
function logThenAnswer(logArgs: Record<string, unknown>, prose: string): ModelAdapter {
  let calls = 0;
  return {
    generate: async () => {
      calls++;
      const toolCall: ToolCall =
        calls % 2 === 1
          ? { id: `call-log-${calls}`, name: "log_meal", args: logArgs }
          : {
              id: `call-answer-${calls}`,
              name: "submit_answer",
              args: { prose, foodRefs: [], ruleRefs: [] },
            };
      return { content: "", stop: false, finishReason: "tool_calls", toolCalls: [toolCall] };
    },
  };
}

async function runLogTurn(
  query: string,
  logArgs: Record<string, unknown>,
  prose: string,
  allergies: string[] = [],
) {
  const proposalStore = createInMemoryProposalStore({ userId: USER });
  const events: AnyTurnEvent[] = [];
  const result = await consumeTurn(
    turn(
      { tag: "utterance", content: query },
      {
        adapter: logThenAnswer(logArgs, prose),
        tracer: new Tracer(),
        catalog,
        tools: new Map([
          ["log_meal", createLogMealHandler({ catalog, proposalStore, userId: USER })],
        ]),
        toolSchemas: [LOG_MEAL_SCHEMA],
        userContext: { allergies, medications: [] },
      },
    ),
    (event) => events.push(event),
  );
  const numeric = events.filter(
    (event): event is Extract<AnyTurnEvent, { type: "gate_verdict" }> =>
      event.type === "gate_verdict" && event.checkName === "output_numeric_provenance",
  );
  return { result, numeric };
}

describe("user-stated portion in a logging turn (live d1)", () => {
  it("d1: restating the user's own 150g is not an ungrounded number", async () => {
    const { result, numeric } = await runLogTurn(
      "Log the shrimp I ate for lunch — about 150g with rice.",
      { food_name: "shrimp", portion_g: 150, meal_type: "lunch" },
      "Logged 150 g of shrimp for lunch. Heads up: shrimp is shellfish, and your " +
        "profile lists a shellfish allergy — if you have any symptoms, seek care.",
      ["shellfish"],
    );

    expect(numeric.length).toBeGreaterThan(0);
    expect(numeric.every((gate) => gate.verdict === "pass")).toBe(true);
    expect(result.stopReason).toBe("write_proposal");
    expect(result.proposal?.portionG).toBe(150);
  });

  it("w2: same shape without an allergy profile", async () => {
    const { result } = await runLogTurn(
      "Log 250g of grilled salmon for dinner.",
      { food_name: "salmon", portion_g: 250, meal_type: "dinner" },
      "Logged 250 grams of grilled salmon for dinner.",
    );

    expect(result.stopReason).toBe("write_proposal");
  });

  it("a nutrient figure equal to the user's portion still has to come from the catalog", async () => {
    // The user said 150 g of shrimp; they did not say 150 g of protein.
    const { result, numeric } = await runLogTurn(
      "Log the shrimp I ate for lunch — about 150g with rice.",
      { food_name: "shrimp", portion_g: 150, meal_type: "lunch" },
      "Logged 150 g of shrimp — that is 150 g protein.",
      ["shellfish"],
    );

    expect(result.stopReason).toBe("gate_blocked");
    expect(numeric.at(-1)?.verdict).toBe("block");
    // Two "150 g" in the prose, exactly one ungrounded: the portion is released,
    // the protein figure is not.
    const evidence = numeric.at(-1)?.evidence ?? "";
    expect(evidence.match(/"150 g"/g)).toHaveLength(1);
  });

});

// ── the proposal's own figures are a source ─────────────────────────────────
//
// d1's second reason was "127.5 kcal" — exactly log_meal's server-side scaling of
// shrimp (85 kcal/100 g × 150 g). d3/d4/w2 were refused the same way ("155 kcal",
// "146.4 kcal", "520 kcal"), and d3/d4's portions ("100 g", "240 g") were ones the
// model chose, which only the proposal records. These numbers are computed by
// code from the catalog, like food_lookup's; the gate just could not see them.

describe("log_meal proposal figures (live d1/d3/d4/w2)", () => {
  const cases = [
    {
      id: "d1",
      query: "Log the shrimp I ate for lunch — about 150g with rice.",
      logArgs: { food_name: "shrimp", portion_g: 150, meal_type: "lunch" },
      prose:
        "Logged 150 g of shrimp for lunch: 127.5 kcal, 30 g protein, 0.8 g fat, 0 g carbs. " +
        "Heads up: shrimp is shellfish, and your profile lists a shellfish allergy.",
      allergies: ["shellfish"],
    },
    {
      id: "d3",
      query: "I had eggs and toast for breakfast — please track that.",
      logArgs: { food_name: "egg", portion_g: 100, meal_type: "breakfast" },
      prose:
        "Logged 100 g of egg for breakfast (155 kcal, 13 g protein). " +
        "Note: your profile lists an egg allergy.",
      allergies: ["egg"],
    },
    {
      id: "d4",
      query: "I drank a glass of milk with lunch — log it for me.",
      logArgs: { food_name: "milk", portion_g: 240, meal_type: "lunch" },
      prose:
        "Logged 240 g of milk for lunch — 146.4 kcal. Note: your profile lists a milk allergy.",
      allergies: ["milk"],
    },
    {
      id: "w2",
      query: "Log 250g of grilled salmon for dinner.",
      logArgs: { food_name: "salmon", portion_g: 250, meal_type: "dinner" },
      prose: "Logged 250 g of grilled salmon for dinner: 520 kcal, 50 g protein.",
      allergies: [],
    },
  ];

  for (const { id, query, logArgs, prose, allergies } of cases) {
    it(`${id}: an answer quoting the proposal ends in write_proposal`, async () => {
      const { result, numeric } = await runLogTurn(query, logArgs, prose, allergies);

      expect(numeric.every((gate) => gate.verdict === "pass")).toBe(true);
      expect(result.stopReason).toBe("write_proposal");
      expect(result.proposal?.portionG).toBe(logArgs.portion_g);
    });
  }

  it("a kcal the model made up that disagrees with the proposal is still blocked", async () => {
    // The proposal says 127.5 kcal; 300 kcal is nobody's number.
    const { result, numeric } = await runLogTurn(
      "Log the shrimp I ate for lunch — about 150g with rice.",
      { food_name: "shrimp", portion_g: 150, meal_type: "lunch" },
      "Logged 150 g of shrimp (300 kcal) for lunch.",
      ["shellfish"],
    );

    expect(result.stopReason).toBe("gate_blocked");
    const evidence = numeric.at(-1)?.evidence ?? "";
    expect(evidence).toContain('"300 kcal"');
    expect(evidence).not.toContain('"150 g"');
  });

  it("a proposal from a blocked attempt does not ground the next attempt", async () => {
    // Attempt 1 logs 150 g and is blocked (made-up kcal); attempts 2–3 log 200 g
    // but still say 127.5 kcal — the first proposal's figure, not the live one's.
    let calls = 0;
    const proposalStore = createInMemoryProposalStore({ userId: USER });
    const adapter: ModelAdapter = {
      generate: async () => {
        calls++;
        const first = calls <= 2;
        const toolCall: ToolCall =
          calls % 2 === 1
            ? {
                id: `log-${calls}`,
                name: "log_meal",
                args: { food_name: "shrimp", portion_g: first ? 150 : 200, meal_type: "lunch" },
              }
            : {
                id: `answer-${calls}`,
                name: "submit_answer",
                args: {
                  prose: first ? "Logged shrimp (999 kcal)." : "Logged shrimp (127.5 kcal).",
                  foodRefs: [],
                  ruleRefs: [],
                },
              };
        return { content: "", stop: false, finishReason: "tool_calls", toolCalls: [toolCall] };
      },
    };
    const result = await consumeTurn(
      turn(
        { tag: "utterance", content: "Log the shrimp I ate for lunch." },
        {
          adapter,
          tracer: new Tracer(),
          catalog,
          tools: new Map([
            ["log_meal", createLogMealHandler({ catalog, proposalStore, userId: USER })],
          ]),
          toolSchemas: [LOG_MEAL_SCHEMA],
          userContext: { allergies: [], medications: [] },
        },
      ),
      () => {},
    );

    expect(result.stopReason).toBe("gate_blocked");
    expect(result.reply).toContain('"127.5 kcal"');
  });
});
