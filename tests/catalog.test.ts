import { describe, it, expect } from "vitest";
import {
  createCatalog,
  SEED_FOODS,
  CATALOG_SNAPSHOT_VERSION,
  type Catalog,
  type CatalogFood,
  type FoodRef,
  type ResolveResult,
} from "../src/catalog/catalog";
import {
  resolveFood,
  DEFAULT_FUZZY_HIGH,
  DEFAULT_FUZZY_MEDIUM,
  DEFAULT_AMBIGUITY_MARGIN,
  type ResolverConfig,
} from "../src/catalog/resolver";

// ─── helpers ───────────────────────────────────────────────────────────────

function seedCatalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

function expectMatched(
  result: ResolveResult,
  expectedFoodId: string,
  expectedMatchType: "exact" | "alias" | "fuzzy",
): void {
  expect(result.matchType).toBe(expectedMatchType);
  expect(result.foodRef).not.toBeNull();
  expect(result.foodRef!.foodId).toBe(expectedFoodId);
  expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
}

function expectMiss(
  result: ResolveResult,
  expectedMatchType: "miss_ambiguous" | "miss_low_confidence" | "miss_unknown",
): void {
  expect(result.matchType).toBe(expectedMatchType);
  expect(result.foodRef).toBeNull();
  expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
}

// ─── catalog construction ──────────────────────────────────────────────────

describe("createCatalog", () => {
  it("creates a catalog from seed foods with correct snapshot metadata", () => {
    const catalog = createCatalog(SEED_FOODS);

    expect(catalog.snapshot.version).toBe(CATALOG_SNAPSHOT_VERSION);
    expect(catalog.snapshot.foodCount).toBe(SEED_FOODS.length);
  });

  it("indexes foods by canonical name in lowercase", () => {
    const catalog = seedCatalog();

    expect(catalog.foods.has("chicken breast")).toBe(true);
    // createCatalog normalizes keys to lowercase; resolution handles case
    // at query time (resolveFood lowercases input before map lookup).
    expect(catalog.foods.has("CHICKEN BREAST")).toBe(false);
  });

  it("builds alias index mapping aliases to canonical names", () => {
    const catalog = createCatalog([
      {
        id: "test-001",
        canonicalName: "Test Food",
        aliases: ["test alias", "another alias"],
        per100g: { kcal: 100, proteinG: 10, fatG: 5, carbsG: 5 },
        allergenTags: [],
        portionAliases: {},
        category: "test",
      },
    ]);

    expect(catalog.aliasIndex.get("test alias")).toBe("test food");
    expect(catalog.aliasIndex.get("another alias")).toBe("test food");
  });

  it("allows foods with no aliases", () => {
    const catalog = createCatalog([
      {
        id: "solo-001",
        canonicalName: "Solo Food",
        aliases: [],
        per100g: { kcal: 50, proteinG: 1, fatG: 1, carbsG: 10 },
        allergenTags: [],
        portionAliases: {},
        category: "test",
      },
    ]);

    expect(catalog.foods.size).toBe(1);
  });

  it("returns empty catalog for empty food list", () => {
    const catalog = createCatalog([]);

    expect(catalog.snapshot.foodCount).toBe(0);
    expect(catalog.foods.size).toBe(0);
    expect(catalog.aliasIndex.size).toBe(0);
  });
});

// ─── exact match ───────────────────────────────────────────────────────────

describe("resolveFood — exact match", () => {
  const catalog = seedCatalog();

  it("resolves canonical food name to FoodRef with matchType exact", () => {
    const result = resolveFood(catalog, "chicken breast");

    expectMatched(result, "food-chicken-breast-001", "exact");
    expect(result.foodRef!.canonicalName).toBe("chicken breast");
    expect(result.foodRef!.matchScore).toBe(1.0);
  });

  it("is case-insensitive", () => {
    const result = resolveFood(catalog, "Chicken Breast");

    expectMatched(result, "food-chicken-breast-001", "exact");
  });

  it("trims whitespace from input", () => {
    const result = resolveFood(catalog, "  salmon  ");

    expectMatched(result, "food-salmon-001", "exact");
  });

  it("resolves single-word food names", () => {
    const result = resolveFood(catalog, "egg");

    expectMatched(result, "food-egg-001", "exact");
  });

  it("resolves multi-word food names", () => {
    const result = resolveFood(catalog, "sweet potato");

    expectMatched(result, "food-sweet-potato-001", "exact");
  });

  it("carries per-100g nutrition data in the FoodRef", () => {
    const result = resolveFood(catalog, "salmon");

    expect(result.foodRef!.per100g).toEqual({
      kcal: 208,
      proteinG: 20,
      fatG: 13,
      carbsG: 0,
    });
  });

  it("carries allergen tags in the FoodRef", () => {
    const result = resolveFood(catalog, "salmon");

    expect(result.foodRef!.allergenTags).toContain("fish");
  });

  it("carries catalog snapshot identity in every result", () => {
    const result = resolveFood(catalog, "banana");

    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });
});

// ─── alias match ───────────────────────────────────────────────────────────

describe("resolveFood — alias match", () => {
  const catalog = seedCatalog();

  it("resolves via alias table with matchType alias", () => {
    const result = resolveFood(catalog, "hen breast");

    expectMatched(result, "food-chicken-breast-001", "alias");
    expect(result.foodRef!.canonicalName).toBe("chicken breast");
    expect(result.foodRef!.matchScore).toBe(1.0);
  });

  it("is case-insensitive for alias matching", () => {
    const result = resolveFood(catalog, "Hen Breast");

    expectMatched(result, "food-chicken-breast-001", "alias");
  });

  it("resolves common aliases (steak → beef steak)", () => {
    const result = resolveFood(catalog, "steak");

    expectMatched(result, "food-beef-steak-001", "alias");
  });

  it("resolves prawn → shrimp alias", () => {
    const result = resolveFood(catalog, "prawn");

    expectMatched(result, "food-shrimp-001", "alias");
  });

  it("resolves rice → white rice alias", () => {
    const result = resolveFood(catalog, "rice");

    expectMatched(result, "food-rice-white-001", "alias");
    expect(result.foodRef!.canonicalName).toBe("white rice");
  });

  it("resolves bread → white bread alias", () => {
    const result = resolveFood(catalog, "bread");

    expectMatched(result, "food-bread-white-001", "alias");
    expect(result.foodRef!.canonicalName).toBe("white bread");
  });

  it("carries the correct FoodRef properties for alias-matched foods", () => {
    const result = resolveFood(catalog, "prawns");

    expect(result.foodRef!.foodId).toBe("food-shrimp-001");
    expect(result.foodRef!.canonicalName).toBe("shrimp");
    expect(result.foodRef!.allergenTags).toContain("shellfish");
    expect(result.foodRef!.matchType).toBe("alias");
  });
});

// ─── fuzzy match ───────────────────────────────────────────────────────────

describe("resolveFood — fuzzy match", () => {
  const catalog = seedCatalog();

  it("resolves minor typos with matchType fuzzy", () => {
    const result = resolveFood(catalog, "chiken breast");

    expectMatched(result, "food-chicken-breast-001", "fuzzy");
  });

  it("records the match score for fuzzy matches", () => {
    // "salmo" vs "salmon": bigram Jaccard = 0.8 (drops the 'n')
    const result = resolveFood(catalog, "salmo");

    expect(result.matchType).toBe("fuzzy");
    expect(result.foodRef!.matchScore).toBeGreaterThan(0);
    expect(result.foodRef!.matchScore).toBeLessThan(1.0);
  });

  it("resolves slight misspellings", () => {
    const result = resolveFood(catalog, "brocolli");

    expectMatched(result, "food-broccoli-001", "fuzzy");
  });

  it("resolves slight misspellings of multi-word names", () => {
    // "chickn breast" vs "chicken breast": bigram Jaccard ≈ 0.79
    const result = resolveFood(catalog, "chickn breast");

    expectMatched(result, "food-chicken-breast-001", "fuzzy");
  });

  it("returns miss_unknown when fuzzy score is below medium threshold", () => {
    const result = resolveFood(catalog, "xyzabc");

    expectMiss(result, "miss_unknown");
  });
});

// ─── miss: ambiguous ───────────────────────────────────────────────────────

describe("resolveFood — miss_ambiguous", () => {
  it("returns miss_ambiguous when multiple foods are close matches", () => {
    // Two foods sharing "protein shake" prefix. The query "protein shake"
    // matches both with similar bigram scores → ambiguous.
    const foods: CatalogFood[] = [
      {
        id: "ps-vanilla",
        canonicalName: "protein shake vanilla",
        aliases: [],
        per100g: { kcal: 120, proteinG: 25, fatG: 2, carbsG: 5 },
        allergenTags: [],
        portionAliases: { serving: 300 },
        category: "beverage",
      },
      {
        id: "ps-chocolate",
        canonicalName: "protein shake chocolate",
        aliases: [],
        per100g: { kcal: 130, proteinG: 25, fatG: 3, carbsG: 6 },
        allergenTags: [],
        portionAliases: { serving: 300 },
        category: "beverage",
      },
    ];
    const smallCatalog = createCatalog(foods);

    const result = resolveFood(smallCatalog, "protein shake");

    expectMiss(result, "miss_ambiguous");
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBe(2);
    // Both candidates should have close scores (gap < ambiguity margin)
    const scores = result.candidates!.map((c) => c.matchScore);
    expect(Math.abs(scores[0] - scores[1])).toBeLessThan(
      DEFAULT_AMBIGUITY_MARGIN,
    );
  });

  it("includes candidate FoodRefs with scores for clarification context", () => {
    const foods: CatalogFood[] = [
      {
        id: "ps-vanilla",
        canonicalName: "protein shake vanilla",
        aliases: [],
        per100g: { kcal: 120, proteinG: 25, fatG: 2, carbsG: 5 },
        allergenTags: [],
        portionAliases: { serving: 300 },
        category: "beverage",
      },
      {
        id: "ps-chocolate",
        canonicalName: "protein shake chocolate",
        aliases: [],
        per100g: { kcal: 130, proteinG: 25, fatG: 3, carbsG: 6 },
        allergenTags: [],
        portionAliases: { serving: 300 },
        category: "beverage",
      },
    ];
    const smallCatalog = createCatalog(foods);

    const result = resolveFood(smallCatalog, "protein shake");

    expect(result.candidates).toBeDefined();
    for (const candidate of result.candidates!) {
      expect(candidate.foodId).toBeDefined();
      expect(candidate.canonicalName).toBeDefined();
      expect(candidate.matchScore).toBeGreaterThan(0);
    }
  });

  it("returns miss_ambiguous when gap between 1st and 2nd is below ambiguity margin", () => {
    // "chicken breast" and "chicken thigh" both match "chicken breast grilled" closely.
    // Query: "chicken" (but this is exact on whole chicken — so use "chickn")
    // Actually, let's use the shared-prefix case: "protein shake" against
    // "protein shake vanilla" and "protein shake chocolate".
    const foods: CatalogFood[] = [
      {
        id: "r-001",
        canonicalName: "protein shake vanilla",
        aliases: [],
        per100g: { kcal: 120, proteinG: 25, fatG: 2, carbsG: 5 },
        allergenTags: [],
        portionAliases: {},
        category: "beverage",
      },
      {
        id: "r-002",
        canonicalName: "protein shake chocolate",
        aliases: [],
        per100g: { kcal: 130, proteinG: 25, fatG: 3, carbsG: 6 },
        allergenTags: [],
        portionAliases: {},
        category: "beverage",
      },
    ];
    const cat = createCatalog(foods);

    const result = resolveFood(cat, "protein shake");

    expect(result.matchType).toMatch(/^miss_/);
    expect(result.foodRef).toBeNull();
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── miss: low confidence ──────────────────────────────────────────────────

describe("resolveFood — miss_low_confidence", () => {
  it("returns miss_low_confidence when best fuzzy score is in medium range with one dominant candidate", () => {
    // "chickn" vs "chicken": bigram Jaccard ≈ 0.571 (medium range)
    // Gap to "chicken thigh" (≈0.333) ≈ 0.238 ≥ 0.12 → single dominant at medium
    const result = resolveFood(seedCatalog(), "chickn");

    expectMiss(result, "miss_low_confidence");
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(1);
    // The top candidate should be "chicken"
    expect(result.candidates![0].canonicalName).toBe("chicken");
  });
});

// ─── miss: unknown ─────────────────────────────────────────────────────────

describe("resolveFood — miss_unknown", () => {
  const catalog = seedCatalog();

  it("returns miss_unknown for completely unknown foods", () => {
    const result = resolveFood(catalog, "dragonfruit");

    expectMiss(result, "miss_unknown");
    expect(result.candidates).toBeUndefined();
  });

  it("returns miss_unknown for empty string", () => {
    const result = resolveFood(catalog, "");

    expectMiss(result, "miss_unknown");
  });

  it("returns miss_unknown for whitespace-only input", () => {
    const result = resolveFood(catalog, "   ");

    expectMiss(result, "miss_unknown");
  });

  it("returns miss_unknown for very dissimilar strings", () => {
    const result = resolveFood(catalog, "spaceship engine oil");

    expectMiss(result, "miss_unknown");
  });
});

// ─── model cannot mint arbitrary food IDs ─────────────────────────────────

describe("model-provided strings cannot mint arbitrary food IDs", () => {
  const catalog = seedCatalog();

  it("does not resolve raw food IDs — only names work", () => {
    const result = resolveFood(catalog, "food-chicken-breast-001");

    // A raw food ID is not a canonical name or alias — it should miss
    expect(result.matchType).toMatch(/^miss_/);
    expect(result.foodRef).toBeNull();
  });

  it("does not resolve arbitrary model-hallucinated food names", () => {
    const result = resolveFood(catalog, "a bowl of ultra-protein mega-shake");

    expectMiss(result, "miss_unknown");
  });

  it("does not resolve by partial or made-up IDs", () => {
    const result = resolveFood(catalog, "food-magical-fruit-999");

    expectMiss(result, "miss_unknown");
  });

  it("FoodRef.matchType is always set by the resolver, never by the model", () => {
    // The model can propose "salmon"; the resolver determines matchType
    const result = resolveFood(catalog, "salmon");

    expect(result.foodRef!.matchType).toBe("exact");
    // The matchType is an enum value, not arbitrary model text
    expect(["exact", "alias", "fuzzy"]).toContain(result.foodRef!.matchType);
  });

  it("the resolver is the sole source of truth for food identity", () => {
    // Even if the model returns "chicken breast protein: 31g per 100g",
    // the FoodRef (id, canonicalName, allergenTags) must come from the resolver
    const result = resolveFood(catalog, "chicken breast");

    // The FoodRef has a stable catalog ID and comes from the catalog
    expect(result.foodRef!.foodId).toBe("food-chicken-breast-001");
    // The FoodRef's canonicalName is the catalog's canonical name, not the model's
    expect(result.foodRef!.canonicalName).toBe("chicken breast");
    // Allergen data comes from the catalog, not model memory
    expect(result.foodRef!.allergenTags).toEqual([]);
    // Nutrition per 100g comes from the catalog, not model arithmetic
    expect(result.foodRef!.per100g.proteinG).toBe(31);
  });

  it("cannot construct a FoodRef bypassing the resolver", () => {
    // There is no constructor, factory, or API path to create a FoodRef
    // except through resolveFood(). This test verifies that trying to
    // resolve a raw ID string (which a model might hallucinate) fails.
    const result = resolveFood(catalog, "food-fake-fruit-000");

    expect(result.foodRef).toBeNull();
    expect(result.matchType).toBe("miss_unknown");
  });
});

// ─── FoodRef stability ─────────────────────────────────────────────────────

describe("FoodRef stability", () => {
  const catalog = seedCatalog();

  it("returns the same FoodRef for the same input every time", () => {
    const r1 = resolveFood(catalog, "chicken breast");
    const r2 = resolveFood(catalog, "chicken breast");

    expect(r1.foodRef!.foodId).toBe(r2.foodRef!.foodId);
    expect(r1.foodRef!.canonicalName).toBe(r2.foodRef!.canonicalName);
    expect(r1.matchType).toBe(r2.matchType);
  });

  it("returns the same FoodRef regardless of case or whitespace", () => {
    const r1 = resolveFood(catalog, "EGG");
    const r2 = resolveFood(catalog, "  egg  ");
    const r3 = resolveFood(catalog, "Egg");

    const ids = [r1, r2, r3].map((r) => r.foodRef!.foodId);
    expect(new Set(ids).size).toBe(1);
  });
});

// ─── ResolveResult carries catalog snapshot identity ───────────────────────

describe("ResolveResult carries catalog snapshot identity", () => {
  const catalog = seedCatalog();

  it("includes catalogSnapshotId in exact match results", () => {
    const result = resolveFood(catalog, "banana");
    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it("includes catalogSnapshotId in alias match results", () => {
    const result = resolveFood(catalog, "steak");
    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it("includes catalogSnapshotId in fuzzy match results", () => {
    const result = resolveFood(catalog, "brocolli");
    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it("includes catalogSnapshotId in miss results", () => {
    const result = resolveFood(catalog, "dragonfruit");
    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });
});

// ─── ResolveResult carries the original input ──────────────────────────────

describe("ResolveResult carries the original input", () => {
  const catalog = seedCatalog();

  it("preserves the original input string for matched results", () => {
    const result = resolveFood(catalog, "salmon");
    expect(result.input).toBe("salmon");
  });

  it("preserves the original input string for miss results", () => {
    const result = resolveFood(catalog, "dragonfruit");
    expect(result.input).toBe("dragonfruit");
  });
});

// ─── Custom resolver config ────────────────────────────────────────────────

describe("resolveFood — custom config thresholds", () => {
  const catalog = seedCatalog();

  it("respects a lowered high threshold for fuzzy matching", () => {
    // "salmo" vs "salmon": bigram Jaccard ≈ 0.8 → fuzzy at default 0.75
    const defaultResult = resolveFood(catalog, "salmo");
    expect(defaultResult.matchType).toBe("fuzzy");

    // Raise the threshold above 0.8 → no longer fuzzy
    const strictResult = resolveFood(catalog, "salmo", {
      fuzzyHighThreshold: 0.9,
    });
    expect(strictResult.matchType).toMatch(/^miss_/);
  });

  it("respects a raised medium threshold", () => {
    // "chickn brst" — a fuzzy-ish query
    const result = resolveFood(catalog, "chickn brst", {
      fuzzyMediumThreshold: 0.8,
    });
    // With a high medium threshold, this should be miss_unknown
    expect(result.matchType).toBe("miss_unknown");
  });

  it("respects increased ambiguity margin", () => {
    // Two foods sharing a common prefix. With default margin the gap puts
    // them in miss_low_confidence territory (single dominant at medium).
    // With a higher margin that exceeds the gap, they become ambiguous.
    // "almond joy" vs "almond butter" with query "almond":
    //   score(almond, almon joy) ≈ 0.556, score(almond, almond butter) ≈ 0.417
    //   gap ≈ 0.139. Default margin 0.12: 0.139 ≥ 0.12 → miss_low_confidence
    //   Custom margin 0.20: 0.139 < 0.20 → miss_ambiguous
    const foods: CatalogFood[] = [
      {
        id: "a-joy",
        canonicalName: "almond joy",
        aliases: [],
        per100g: { kcal: 500, proteinG: 5, fatG: 25, carbsG: 60 },
        allergenTags: ["tree_nut"],
        portionAliases: {},
        category: "snack",
      },
      {
        id: "a-butter",
        canonicalName: "almond butter",
        aliases: [],
        per100g: { kcal: 614, proteinG: 21, fatG: 56, carbsG: 19 },
        allergenTags: ["tree_nut"],
        portionAliases: {},
        category: "legume_nut",
      },
    ];
    const cat = createCatalog(foods);

    // Default margin: gap 0.139 ≥ 0.12 → miss_low_confidence (single dominant at medium)
    const defaultResult = resolveFood(cat, "almond");
    expect(defaultResult.matchType).toBe("miss_low_confidence");

    // Raised margin: gap 0.139 < 0.20 → miss_ambiguous
    const strictResult = resolveFood(cat, "almond", {
      ambiguityMargin: 0.2,
    });
    expect(strictResult.matchType).toBe("miss_ambiguous");
  });
});

// ─── maxCandidates limit ───────────────────────────────────────────────────

describe("resolveFood — maxCandidates", () => {
  it("limits candidates to the configured max", () => {
    // Create multiple similar foods
    const foods: CatalogFood[] = Array.from({ length: 10 }, (_, i) => ({
      id: `multi-${i.toString().padStart(3, "0")}`,
      canonicalName: `protein shake flavor ${i}`,
      aliases: [],
      per100g: { kcal: 50 + i, proteinG: 5, fatG: 1, carbsG: 5 },
      allergenTags: [],
      portionAliases: {},
      category: "beverage",
    }));
    const cat = createCatalog(foods);

    const result = resolveFood(cat, "protein shake", { maxCandidates: 3 });

    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeLessThanOrEqual(3);
  });
});

// ─── seed data integrity ───────────────────────────────────────────────────

describe("seed data integrity", () => {
  it("every seed food has a unique id", () => {
    const ids = SEED_FOODS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every seed food has a non-empty canonical name", () => {
    for (const food of SEED_FOODS) {
      expect(food.canonicalName.length).toBeGreaterThan(0);
    }
  });

  it("every seed food has valid per-100g nutrition values", () => {
    for (const food of SEED_FOODS) {
      expect(food.per100g.kcal).toBeGreaterThanOrEqual(0);
      expect(food.per100g.proteinG).toBeGreaterThanOrEqual(0);
      expect(food.per100g.fatG).toBeGreaterThanOrEqual(0);
      expect(food.per100g.carbsG).toBeGreaterThanOrEqual(0);
    }
  });

  it("every seed food has a category", () => {
    const validCategories = [
      "meat",
      "seafood",
      "grain",
      "vegetable",
      "dairy",
      "fruit",
      "legume_nut",
      "beverage",
    ];

    for (const food of SEED_FOODS) {
      expect(validCategories).toContain(food.category);
    }
  });

  it("no canonical name collides with another food's alias", () => {
    const catalog = seedCatalog();
    const canonicalNames = new Set(catalog.foods.keys());

    for (const [alias] of catalog.aliasIndex) {
      expect(canonicalNames.has(alias)).toBe(false);
    }
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────

describe("resolveFood — edge cases", () => {
  const catalog = seedCatalog();

  it("handles very long input strings gracefully", () => {
    const longInput = "a".repeat(1000);
    const result = resolveFood(catalog, longInput);

    expect(result.matchType).toBe("miss_unknown");
  });

  it("handles input with special characters", () => {
    const result = resolveFood(catalog, "chicken!!@#$%");

    // Should try to fuzzy match against "chicken" or related entries
    // May be miss_unknown or miss_low_confidence depending on thresholds
    expect(result.matchType).toMatch(/^miss_/);
    expect(result.foodRef).toBeNull();
  });

  it("handles input that is a substring of a canonical name", () => {
    // "chicken" is a substring of "chicken breast" and "chicken thigh"
    // AND it's also an exact match for the "chicken" canonical entry
    const result = resolveFood(catalog, "chicken");

    // Exact match on "chicken" (whole chicken) should fire first
    expectMatched(result, "food-chicken-whole-001", "exact");
  });

  it("handles input with trailing/leading whitespace and multiple spaces", () => {
    const result = resolveFood(catalog, "   chicken    breast   ");

    expectMatched(result, "food-chicken-breast-001", "exact");
  });

  it("returns consistent results for empty catalog", () => {
    const emptyCatalog = createCatalog([]);

    const result = resolveFood(emptyCatalog, "anything");

    expectMiss(result, "miss_unknown");
    expect(result.catalogSnapshotId).toBe(CATALOG_SNAPSHOT_VERSION);
  });

  it("does not mutate catalog state during resolution", () => {
    const cat = seedCatalog();
    const foodCountBefore = cat.foods.size;
    const aliasCountBefore = cat.aliasIndex.size;

    resolveFood(cat, "chicken breast");
    resolveFood(cat, "unknown food");
    resolveFood(cat, "brocolli");

    expect(cat.foods.size).toBe(foodCountBefore);
    expect(cat.aliasIndex.size).toBe(aliasCountBefore);
  });
});
