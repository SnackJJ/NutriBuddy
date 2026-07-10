import { describe, it, expect, beforeAll } from "vitest";
import {
  buildPreGateContext,
  checkPostGate,
  classifyUtteranceIntent,
  scanUtteranceForConflicts,
  type UserContext,
} from "../src/harness/gate";
import type {
  DrugNutrientInteraction,
  InteractionStore,
} from "../src/lib/drugInteractions";
import { createCatalog, SEED_FOODS, type Catalog } from "../src/catalog/catalog";

const SAMPLE_INTERACTIONS: DrugNutrientInteraction[] = [
  {
    drugName: "warfarin",
    nutrient: "vitamin K",
    foodExamples: ["kale", "spinach", "broccoli"],
    severity: "high",
    source: "NIH ODS",
  },
  {
    drugName: "warfarin",
    nutrient: "cranberry",
    foodExamples: ["cranberry juice"],
    severity: "moderate",
    source: "MedlinePlus",
  },
  {
    drugName: "spironolactone",
    nutrient: "potassium",
    foodExamples: ["banana", "potato", "salt substitutes"],
    severity: "high",
    source: "MedlinePlus",
  },
];

function fakeStore(rows: DrugNutrientInteraction[]): InteractionStore {
  return { all: async () => rows };
}

// ─── buildPreGateContext ────────────────────────────────────────────────

describe("buildPreGateContext", () => {
  it("returns empty pinned region when user has no allergies or medications", async () => {
    const ctx = await buildPreGateContext(
      { allergies: [], medications: [] },
      fakeStore([]),
    );
    expect(ctx.pinnedRegion).toBe("");
  });

  it("includes allergy constraints when user has allergies", async () => {
    const ctx = await buildPreGateContext(
      { allergies: ["peanut", "milk"], medications: [] },
      fakeStore([]),
    );
    expect(ctx.pinnedRegion).toContain("peanut");
    expect(ctx.pinnedRegion).toContain("milk");
    expect(ctx.pinnedRegion.toLowerCase()).toContain("allerg");
  });

  it("includes medication list and drug-nutrient interactions", async () => {
    const ctx = await buildPreGateContext(
      { allergies: [], medications: ["warfarin"] },
      fakeStore(SAMPLE_INTERACTIONS),
    );
    expect(ctx.pinnedRegion).toContain("warfarin");
    // high-severity interaction should appear
    expect(ctx.pinnedRegion).toContain("vitamin K");
    expect(ctx.pinnedRegion).toContain("kale");
  });

  it("combines allergy and medication sections when both present", async () => {
    const ctx = await buildPreGateContext(
      { allergies: ["egg"], medications: ["warfarin"] },
      fakeStore(SAMPLE_INTERACTIONS),
    );
    expect(ctx.pinnedRegion).toContain("egg");
    expect(ctx.pinnedRegion).toContain("warfarin");
    expect(ctx.pinnedRegion).toContain("vitamin K");
  });

  it("includes medications even when no interactions exist for them", async () => {
    const ctx = await buildPreGateContext(
      { allergies: [], medications: ["ibuprofen"] },
      fakeStore(SAMPLE_INTERACTIONS),
    );
    expect(ctx.pinnedRegion).toContain("ibuprofen");
  });

  it("short-circuits store when user has no medications", async () => {
    let touched = false;
    const store: InteractionStore = {
      all: async () => {
        touched = true;
        return [];
      },
    };
    await buildPreGateContext(
      { allergies: ["peanut"], medications: [] },
      store,
    );
    expect(touched).toBe(false);
  });
});

// ─── checkPostGate ─────────────────────────────────────────────────────

describe("checkPostGate", () => {
  const userNoAllergies: UserContext = {
    allergies: [],
    medications: ["warfarin"],
  };

  const userMilkAllergy: UserContext = {
    allergies: ["milk"],
    medications: [],
  };

  it("passes clean output with no allergen mentions and no drug conflicts", () => {
    const result = checkPostGate(
      "You can enjoy a fresh apple as a healthy snack.",
      userNoAllergies,
      [],
    );
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks when output mentions an allergen directly", () => {
    const result = checkPostGate(
      "I recommend adding milk to your morning coffee.",
      userMilkAllergy,
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons.some((r) => r.toLowerCase().includes("milk"))).toBe(true);
  });

  it("blocks when output mentions an allergen synonym (dairy for milk allergy)", () => {
    const result = checkPostGate(
      "Try adding some dairy products like yogurt to your breakfast.",
      userMilkAllergy,
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes("dairy"))).toBe(
      true,
    );
  });

  it("blocks when output mentions a cheese (synonym of milk)", () => {
    const result = checkPostGate(
      "A cheese platter makes a great appetizer.",
      userMilkAllergy,
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes("cheese"))).toBe(
      true,
    );
  });

  it("blocks on high-severity drug-nutrient conflict (warfarin + kale)", () => {
    const result = checkPostGate(
      "Kale salad is a great source of vitamins.",
      userNoAllergies,
      SAMPLE_INTERACTIONS,
    );
    expect(result.passed).toBe(false);
    expect(
      result.reasons.some(
        (r) => r.includes("kale") && r.includes("warfarin"),
      ),
    ).toBe(true);
  });

  it("does NOT block on moderate-severity drug interactions (warfarin + cranberry)", () => {
    const result = checkPostGate(
      "A glass of cranberry juice is refreshing.",
      userNoAllergies,
      SAMPLE_INTERACTIONS,
    );
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("accumulates multiple violations across allergens and drug conflicts", () => {
    const result = checkPostGate(
      "Eat kale with a glass of milk and some cheese for strong bones.",
      { allergies: ["milk"], medications: ["warfarin"] },
      SAMPLE_INTERACTIONS,
    );
    expect(result.passed).toBe(false);
    // at least: milk allergy match + kale/warfarin conflict
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("is case-insensitive when matching", () => {
    const result = checkPostGate(
      "Try some KALE chips and DAIRY-free MILK alternatives.",
      userMilkAllergy,
      [],
    );
    expect(result.passed).toBe(false);
    // "MILK" and "DAIRY" both trigger the milk allergy — case-insensitive match.
    // The first synonym ("milk") hits, so the reason names "milk".
    expect(result.reasons.some((r) => r.toLowerCase().includes("milk"))).toBe(
      true,
    );
  });

  it("handles peanut allergy with groundnut synonym", () => {
    const result = checkPostGate(
      "Groundnut oil is commonly used in Asian cooking.",
      { allergies: ["peanut"], medications: [] },
      [],
    );
    expect(result.passed).toBe(false);
  });

  it("handles shellfish allergy with shrimp/crab synonyms", () => {
    const result = checkPostGate(
      "Shrimp scampi is a classic Italian dish.",
      { allergies: ["shellfish"], medications: [] },
      [],
    );
    expect(result.passed).toBe(false);
  });

  it("does not false-positive on words that are substrings of allergens", () => {
    // "eggplant" contains "egg" but should not match an egg allergy
    const result = checkPostGate(
      "Grilled eggplant is a delicious Mediterranean dish.",
      { allergies: ["egg"], medications: [] },
      [],
    );
    // "eggplant" is not a synonym for egg allergy — it should pass
    expect(result.passed).toBe(true);
  });
});

// ─── classifyUtteranceIntent ────────────────────────────────────────────

describe("classifyUtteranceIntent", () => {
  it("classifies prescriptive asks as prescriptive", () => {
    expect(classifyUtteranceIntent("Should I eat shrimp for dinner?")).toBe("prescriptive");
    expect(classifyUtteranceIntent("What should I eat for breakfast?")).toBe("prescriptive");
    expect(classifyUtteranceIntent("Recommend a healthy snack.")).toBe("prescriptive");
    expect(classifyUtteranceIntent("Is salmon safe for me?")).toBe("prescriptive");
    expect(classifyUtteranceIntent("Can I eat peanuts?")).toBe("prescriptive");
    expect(classifyUtteranceIntent("What's a good source of protein?")).toBe("prescriptive");
  });

  it("classifies descriptive log/track mentions as descriptive", () => {
    expect(classifyUtteranceIntent("Log the shrimp I ate for lunch")).toBe("descriptive");
    expect(classifyUtteranceIntent("I ate a bowl of rice for lunch")).toBe("descriptive");
    expect(classifyUtteranceIntent("Track 200g chicken breast for dinner")).toBe("descriptive");
    expect(classifyUtteranceIntent("I had eggs and toast for breakfast")).toBe("descriptive");
    expect(classifyUtteranceIntent("Record the salmon I consumed")).toBe("descriptive");
  });

  it("classifies neutral queries as neutral", () => {
    expect(classifyUtteranceIntent("How much protein is in chicken?")).toBe("neutral");
    expect(classifyUtteranceIntent("What is the calorie content of rice?")).toBe("neutral");
    expect(classifyUtteranceIntent("Tell me about vitamin C")).toBe("neutral");
    expect(classifyUtteranceIntent("hi")).toBe("neutral");
  });
});

// ─── scanUtteranceForConflicts ──────────────────────────────────────────

describe("scanUtteranceForConflicts", () => {
  let catalog: Catalog;

  beforeAll(() => {
    catalog = createCatalog(SEED_FOODS);
  });

  it("returns empty conflicts and hitFoods when utterance has no food mentions", () => {
    const result = scanUtteranceForConflicts(
      "What time is it?",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.conflicts).toHaveLength(0);
    expect(result.hitFoods).toHaveLength(0);
  });

  it("returns empty conflicts when food is mentioned but user has no matching allergy", () => {
    const result = scanUtteranceForConflicts(
      "Should I eat chicken breast for dinner?",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.conflicts).toHaveLength(0);
  });

  it("detects shellfish allergy conflict when shrimp is mentioned", () => {
    const result = scanUtteranceForConflicts(
      "Should I eat shrimp for dinner?",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts.some((c) => c.id === "shellfish")).toBe(true);
    expect(result.hitFoods).toContain("shrimp");
  });

  it("detects multiple conflicts for multi-allergen foods", () => {
    // Noodles are tagged with wheat — if user is allergic to wheat
    const result = scanUtteranceForConflicts(
      "I had noodles for lunch",
      catalog,
      { allergies: ["wheat"], medications: [] },
    );

    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts.some((c) => c.id === "wheat")).toBe(true);
    expect(result.hitFoods.some((f) => f === "noodles")).toBe(true);
  });

  it("detects conflicts across multiple foods in one utterance", () => {
    const result = scanUtteranceForConflicts(
      "I ate shrimp and salmon for dinner",
      catalog,
      { allergies: ["shellfish", "fish"], medications: [] },
    );

    expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
    const conflictIds = result.conflicts.map((c) => c.id);
    expect(conflictIds).toContain("shellfish");
    expect(conflictIds).toContain("fish");
    expect(result.hitFoods).toContain("shrimp");
    expect(result.hitFoods).toContain("salmon");
  });

  it("detects conflicts via food aliases", () => {
    // "prawn" is an alias for shrimp
    const result = scanUtteranceForConflicts(
      "I ate some prawns for dinner",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(result.conflicts.some((c) => c.id === "shellfish")).toBe(true);
    expect(result.hitFoods).toContain("shrimp");
  });

  it("classifies prescriptive intent when asking for recommendations", () => {
    const result = scanUtteranceForConflicts(
      "Should I eat shrimp for dinner?",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.intent).toBe("prescriptive");
  });

  it("classifies descriptive intent when logging a meal", () => {
    const result = scanUtteranceForConflicts(
      "Log the shrimp I ate for lunch",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.intent).toBe("descriptive");
  });

  it("returns no conflicts for foods without allergen tags", () => {
    // Chicken breast has no allergen tags
    const result = scanUtteranceForConflicts(
      "I ate chicken breast for lunch",
      catalog,
      { allergies: ["shellfish", "milk", "egg"], medications: [] },
    );

    expect(result.conflicts).toHaveLength(0);
  });

  it("returns empty for foods with allergen tags that don't match user allergies", () => {
    // Salmon has fish allergen tag, but user is only allergic to shellfish
    const result = scanUtteranceForConflicts(
      "I ate salmon for dinner",
      catalog,
      { allergies: ["shellfish"], medications: [] },
    );

    expect(result.conflicts).toHaveLength(0);
  });
});
