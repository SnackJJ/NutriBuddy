import { describe, expect, it } from "vitest";
import {
  checkAdvisoryStructure,
  type Conflict,
} from "../src/harness/advisoryGate";
import type { TypedOutput } from "../src/harness/turn";

// ─── helpers ────────────────────────────────────────────────────────────────

function typedOutput(
  prose: string,
  extra?: Partial<TypedOutput>,
): TypedOutput {
  return {
    prose,
    foodRefs: extra?.foodRefs ?? [],
    ruleRefs: extra?.ruleRefs ?? [],
  };
}

const PEANUT_CONFLICT: Conflict = {
  type: "allergy",
  id: "peanut",
  description: "User is allergic to peanut",
};

const WARFARIN_CONFLICT: Conflict = {
  type: "drug_interaction",
  id: "WARFARIN-VITK",
  description: "Warfarin interacts with vitamin K",
};

// ─── tests ──────────────────────────────────────────────────────────────────

describe("checkAdvisoryStructure", () => {
  it("passes when no conflicts exist and output has no foodRefs", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("Here is some general nutrition advice."),
      conflicts: [],
    });

    expect(result.passed).toBe(true);
  });

  it("passes when no conflicts exist even with food recommendations", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("I recommend chicken breast.", {
        foodRefs: [
          {
            foodId: "chicken-breast-001",
            foodName: "Chicken breast, raw",
            matchType: "exact",
          },
        ],
      }),
      conflicts: [],
    });

    expect(result.passed).toBe(true);
  });

  it("passes when conflicts exist but output has no food recommendations", () => {
    // A reply that acknowledges a constraint without recommending food
    // doesn't need advisory ruleRefs because it's not making recommendations.
    const result = checkAdvisoryStructure({
      output: typedOutput(
        "I understand you have a peanut allergy. How can I help you today?",
      ),
      conflicts: [PEANUT_CONFLICT],
    });

    expect(result.passed).toBe(true);
  });

  it("passes when food recommendations with conflicts include advisory ruleRefs", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput(
        "For your omega-3 goals, I recommend salmon. Note: check warfarin interaction.",
        {
          foodRefs: [
            {
              foodId: "salmon-001",
              foodName: "Salmon, Atlantic, raw",
              matchType: "exact",
              allergens: ["fish"],
            },
          ],
          ruleRefs: [
            {
              ruleId: "WARFARIN-VITK",
              summary: "High vitamin K foods may interfere with warfarin",
            },
          ],
        },
      ),
      conflicts: [WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(true);
  });

  it("blocks when food recommendations exist with conflicts but ruleRefs are empty", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("I recommend eating peanuts for protein.", {
        foodRefs: [
          {
            foodId: "peanut-001",
            foodName: "Peanuts, raw",
            matchType: "exact",
            allergens: ["peanut"],
          },
        ],
        ruleRefs: [], // empty — should have advisory
      }),
      conflicts: [PEANUT_CONFLICT],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("blocks when ruleRefs exist but have empty ruleIds", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("Here is my recommendation.", {
        foodRefs: [
          {
            foodId: "spinach-001",
            foodName: "Spinach, raw",
            matchType: "exact",
          },
        ],
        ruleRefs: [
          {
            ruleId: "", // invalid — empty ruleId
            summary: "Some advisory",
          },
        ],
      }),
      conflicts: [WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("empty"))).toBe(true);
  });

  it("blocks when ruleRefs exist but all have empty ruleIds", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("Recommendation here.", {
        foodRefs: [
          {
            foodId: "kale-001",
            foodName: "Kale, raw",
            matchType: "exact",
          },
        ],
        ruleRefs: [
          {
            ruleId: "", // empty — invalid
            summary: "Some advisory",
          },
        ],
      }),
      conflicts: [WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(false);
  });

  it("reports the specific conflict that triggered the advisory requirement", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("I recommend eating peanuts.", {
        foodRefs: [
          {
            foodId: "peanut-001",
            foodName: "Peanuts, raw",
            matchType: "exact",
          },
        ],
        ruleRefs: [],
      }),
      conflicts: [PEANUT_CONFLICT, WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(false);
    // Evidence should mention conflicts that were not addressed
    expect(
      result.reasons.some(
        (r) =>
          r.toLowerCase().includes("conflict") ||
          r.toLowerCase().includes("advisory"),
      ),
    ).toBe(true);
  });

  it("passes with multiple conflicts all addressed by ruleRefs", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput(
        "For your goals, here are my recommendations. Note interactions.",
        {
          foodRefs: [
            {
              foodId: "salmon-001",
              foodName: "Salmon, Atlantic, raw",
              matchType: "exact",
              allergens: ["fish"],
            },
          ],
          ruleRefs: [
            {
              ruleId: "PEANUT-ALLERGY",
              summary: "Avoid peanuts due to allergy",
            },
            {
              ruleId: "WARFARIN-VITK",
              summary: "Monitor vitamin K intake with warfarin",
            },
          ],
        },
      ),
      conflicts: [PEANUT_CONFLICT, WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(true);
  });

  it("passes when conflicts exist but typed output has neither foodRefs nor ruleRefs (pure informational response)", () => {
    // An informational response without food recommendations doesn't trigger
    // the advisory requirement. The lexical backstop catches food mentions.
    const result = checkAdvisoryStructure({
      output: typedOutput(
        "Your current profile lists peanut as an allergy. Would you like to set protein targets?",
      ),
      conflicts: [PEANUT_CONFLICT],
    });

    expect(result.passed).toBe(true);
  });

  it("blocks when foodRefs exist with conflict but ruleRefs is missing from output entirely", () => {
    // Simulate incomplete typed output where ruleRefs might be absent
    const incomplete = {
      prose: "I recommend peanuts.",
      foodRefs: [
        {
          foodId: "peanut-001",
          foodName: "Peanuts, raw",
          matchType: "exact" as const,
        },
      ],
      ruleRefs: undefined as any,
    } as TypedOutput;

    const result = checkAdvisoryStructure({
      output: incomplete,
      conflicts: [PEANUT_CONFLICT],
    });

    expect(result.passed).toBe(false);
  });

  it("passes when ruleRefs have valid ids (even with empty summary)", () => {
    const result = checkAdvisoryStructure({
      output: typedOutput("Recommendation.", {
        foodRefs: [
          {
            foodId: "spinach-001",
            foodName: "Spinach, raw",
            matchType: "exact",
          },
        ],
        ruleRefs: [
          {
            ruleId: "WARFARIN-VITK",
            summary: "", // empty summary is ok — ruleId is what matters
          },
        ],
      }),
      conflicts: [WARFARIN_CONFLICT],
    });

    expect(result.passed).toBe(true);
  });
});
