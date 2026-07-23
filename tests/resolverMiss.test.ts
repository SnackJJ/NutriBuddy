import { describe, expect, it } from "vitest";
import {
  projectResolverMiss,
  utteranceForCandidatePick,
} from "../src/lib/resolverMiss";

describe("projectResolverMiss", () => {
  it("projects miss_ambiguous with clickable candidates", () => {
    const miss = projectResolverMiss(
      {
        error: 'food not found in catalog: "chicken"',
        match_type: "miss_ambiguous",
        catalog_snapshot: "snap-1",
        message: "multiple matches",
        candidates: [
          {
            food_id: "f1",
            food_name: "chicken breast",
            match_score: 0.82,
            allergen_tags: [],
          },
          { food_id: "f2", food_name: "chicken thigh", match_score: 0.8 },
        ],
      },
      { food_name: "chicken", portion_g: 150, meal_type: "lunch" },
    );

    expect(miss).toMatchObject({
      matchType: "miss_ambiguous",
      input: "chicken",
      message: "multiple matches",
      portionG: 150,
      mealType: "lunch",
    });
    expect(miss?.candidates).toHaveLength(2);
    expect(miss?.candidates[0]).toEqual({
      foodId: "f1",
      foodName: "chicken breast",
      matchScore: 0.82,
      allergenTags: [],
    });
  });

  it("projects miss_unknown with empty candidates", () => {
    const miss = projectResolverMiss({
      error: 'food not found in catalog: "宫保鸡丁"',
      match_type: "miss_unknown",
      message: "not in catalog",
    });
    expect(miss?.matchType).toBe("miss_unknown");
    expect(miss?.input).toBe("宫保鸡丁");
    expect(miss?.candidates).toEqual([]);
  });

  it("returns undefined for non-miss payloads", () => {
    expect(projectResolverMiss({ proposal_id: "p1" })).toBeUndefined();
    expect(projectResolverMiss(null)).toBeUndefined();
  });
});

describe("utteranceForCandidatePick", () => {
  it("builds a re-log utterance without free-form retyping of the original phrase", () => {
    expect(
      utteranceForCandidatePick(
        { foodId: "f1", foodName: "chicken breast" },
        { portionG: 150, mealType: "lunch" },
      ),
    ).toBe("Log 150g of chicken breast for lunch");
  });

  it("defaults portion and meal type", () => {
    expect(
      utteranceForCandidatePick({ foodId: "f1", foodName: "egg" }, {}),
    ).toBe("Log 100g of egg for snack");
  });
});
