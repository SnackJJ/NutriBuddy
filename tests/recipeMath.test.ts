import { describe, expect, it } from "vitest";
import { computeRecipePer100g } from "../src/lib/recipeMath";

describe("computeRecipePer100g", () => {
  it("computes per100g from ingredients and finished weight", () => {
    const result = computeRecipePer100g(
      [
        {
          foodId: "a",
          foodName: "chicken",
          grams: 100,
          per100g: { kcal: 165, proteinG: 31, fatG: 3.6, carbsG: 0 },
        },
        {
          foodId: "b",
          foodName: "oil",
          grams: 10,
          per100g: { kcal: 884, proteinG: 0, fatG: 100, carbsG: 0 },
        },
      ],
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 165 + 88.4 = 253.4 kcal in 100g finished
      expect(result.per100g.kcal).toBeCloseTo(253.4, 0);
      expect(result.ingredientTotalG).toBe(110);
    }
  });

  it("blocks finalization when an ingredient is unresolved", () => {
    const result = computeRecipePer100g(
      [
        {
          foodId: "x",
          foodName: "mystery",
          grams: 50,
          per100g: { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 },
          unresolved: true,
        },
      ],
      50,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolvedNames).toContain("mystery");
    }
  });
});
