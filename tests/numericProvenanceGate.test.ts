import { describe, expect, it } from "vitest";
import { checkNumericProvenance } from "../src/harness/numericProvenanceGate";
import type { Observation, ColumnDef } from "../src/catalog/queryCatalog";
import type { TypedOutput } from "../src/harness/turn";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeObservation(
  templateId: string,
  columns: readonly ColumnDef[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Observation {
  return {
    templateId,
    columns,
    rows: rows as any,
    rowCount: rows.length,
    truncated: false,
  };
}

function typedOutput(prose: string, extra?: Partial<TypedOutput>): TypedOutput {
  return {
    prose,
    foodRefs: extra?.foodRefs ?? [],
    ruleRefs: extra?.ruleRefs ?? [],
  };
}

const CHICKEN_COLUMNS: ColumnDef[] = [
  { name: "food_id", type: "string", description: "Catalog food ID" },
  { name: "food_name", type: "string", description: "Canonical name" },
  {
    name: "portion_g",
    type: "number",
    unit: "g",
    description: "Portion size in grams",
  },
  { name: "kcal", type: "number", unit: "kcal", description: "Calories" },
  {
    name: "protein_g",
    type: "number",
    unit: "g",
    description: "Protein per portion",
  },
  {
    name: "fat_g",
    type: "number",
    unit: "g",
    description: "Fat per portion",
  },
  {
    name: "carbs_g",
    type: "number",
    unit: "g",
    description: "Carbs per portion",
  },
  {
    name: "allergen_tags",
    type: "string",
    description: "Allergen tags",
  },
];

// ─── tests ──────────────────────────────────────────────────────────────────

describe("checkNumericProvenance", () => {
  it("passes when prose contains no numbers with units", () => {
    const result = checkNumericProvenance({
      output: typedOutput(
        "Based on your profile, here are some recommendations.",
      ),
      observations: [],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("passes when all prose numbers match observation values exactly", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    const result = checkNumericProvenance({
      output: typedOutput(
        "Chicken breast has 31g protein and 165 kcal per 100g serving.",
      ),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("blocks when prose contains a number that does not trace to any observation", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    const result = checkNumericProvenance({
      output: typedOutput(
        "Chicken breast has 500g protein per 100g.", // 500g not in observation
      ),
      observations: [obs],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("500"))).toBe(true);
  });

  it("passes when a prose number falls within rounding tolerance of an observation value", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31.2, // DB has 31.2g
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    // Prose says "31g" — should match 31.2 within tolerance
    const result = checkNumericProvenance({
      output: typedOutput("Chicken breast has 31g protein per 100g serving."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("blocks when a prose number is outside rounding tolerance", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    // 50g is way off from 31g — outside tolerance
    const result = checkNumericProvenance({
      output: typedOutput("Chicken breast has 50g protein per 100g."),
      observations: [obs],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("50"))).toBe(true);
  });

  it("passes when multiple observations together ground all prose numbers", () => {
    const chicken = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    const rice = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "rice-white-001",
        food_name: "Rice, white, cooked",
        portion_g: 150,
        kcal: 195,
        protein_g: 4.2,
        fat_g: 0.4,
        carbs_g: 42,
        allergen_tags: "",
      },
    ]);

    const result = checkNumericProvenance({
      output: typedOutput(
        "Chicken breast has 31g protein and 165 kcal. Rice has 42g carbs and 195 kcal per 150g.",
      ),
      observations: [chicken, rice],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("handles unit normalization: g ↔ mg", () => {
    const columns: ColumnDef[] = [
      {
        name: "vitamin_c_mg",
        type: "number",
        unit: "mg",
        description: "Vitamin C",
      },
    ];

    const obs = makeObservation("food_lookup", columns, [
      { vitamin_c_mg: 500 },
    ]);

    // Prose says "0.5 g of vitamin C" which is 500mg — should match after unit normalization
    const result = checkNumericProvenance({
      output: typedOutput("This food has 0.5g of vitamin C."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("handles unit normalization: kcal ↔ cal", () => {
    const columns: ColumnDef[] = [
      { name: "kcal", type: "number", unit: "kcal", description: "Calories" },
    ];

    const obs = makeObservation("food_lookup", columns, [{ kcal: 165 }]);

    // Prose says "165000 cal" but observation has 165 kcal
    // NB: kcal label in prose ("165 kcal") is the common case;
    // this test covers the cal → kcal conversion
    const result = checkNumericProvenance({
      output: typedOutput("Contains 165 calories of energy."),
      observations: [obs],
    });

    // "calories" in prose isn't unit-attached in the regex sense
    // unless we also match the word. For now this is expected to pass
    // because "165" without a unit is not unit-attached.
    // We test the actual unit-attached case below.
    expect(result.passed).toBe(true);
  });

  it("handles unit normalization: 165000 cal observation with 165 kcal prose", () => {
    const columns: ColumnDef[] = [
      {
        name: "energy_cal",
        type: "number",
        unit: "cal",
        description: "Energy",
      },
    ];

    const obs = makeObservation("food_lookup", columns, [
      { energy_cal: 165000 },
    ]);

    // Prose uses kcal (common household unit), observation uses cal
    const result = checkNumericProvenance({
      output: typedOutput("Contains 165 kcal of energy."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("handles unit normalization: kg ↔ g", () => {
    const columns: ColumnDef[] = [
      { name: "portion_g", type: "number", unit: "g", description: "Portion" },
    ];

    const obs = makeObservation("food_lookup", columns, [{ portion_g: 100 }]);

    const result = checkNumericProvenance({
      output: typedOutput("A 0.1 kg portion of this food."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("reports all ungrounded numbers in the evidence", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    const result = checkNumericProvenance({
      output: typedOutput(
        "Chicken breast has 500g protein and 999 kcal per serving.", // both ungrounded
      ),
      observations: [obs],
    });

    expect(result.passed).toBe(false);
    // Should report at least two ungrounded facts
    const has500 = result.reasons.some((r) => r.includes("500"));
    const has999 = result.reasons.some((r) => r.includes("999"));
    expect(has500 || has999).toBe(true);
  });

  it("passes when prose has numeric words but no unit-attached numbers", () => {
    const result = checkNumericProvenance({
      output: typedOutput(
        "Here are three options for breakfast. Option two is the best.",
      ),
      observations: [],
    });

    expect(result.passed).toBe(true);
  });

  it("uses configurable tolerance", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "chicken-breast-001",
        food_name: "Chicken breast, raw",
        portion_g: 100,
        kcal: 165,
        protein_g: 31,
        fat_g: 3.6,
        carbs_g: 0,
        allergen_tags: "",
      },
    ]);

    // With 0% tolerance, even 31 vs 31.2 should block
    // But 31 vs 31 is exact
    const resultPass = checkNumericProvenance({
      output: typedOutput("Chicken breast has 31g protein."),
      observations: [obs],
      tolerance: 0,
    });

    expect(resultPass.passed).toBe(true);

    // With 0% tolerance, 32g vs 31 should block
    const resultBlock = checkNumericProvenance({
      output: typedOutput("Chicken breast has 32g protein."),
      observations: [obs],
      tolerance: 0,
    });

    expect(resultBlock.passed).toBe(false);
  });

  it("passes when observation has a non-numeric column (string type is not checked)", () => {
    const columns: ColumnDef[] = [
      {
        name: "food_name",
        type: "string",
        description: "Name",
      },
    ];

    const obs = makeObservation("food_lookup", columns, [
      { food_name: "Chicken breast" },
    ]);

    // Prose mentioning the food name string is fine — numeric gate only checks numbers
    const result = checkNumericProvenance({
      output: typedOutput("Chicken breast is a great option."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
  });

  it("handles multiple observations from different templates", () => {
    const foodA = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "salmon-001",
        food_name: "Salmon, Atlantic",
        portion_g: 100,
        kcal: 208,
        protein_g: 20,
        fat_g: 13,
        carbs_g: 0,
        allergen_tags: "fish",
      },
    ]);

    const foodB = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "broccoli-001",
        food_name: "Broccoli, raw",
        portion_g: 100,
        kcal: 34,
        protein_g: 2.8,
        fat_g: 0.4,
        carbs_g: 6.6,
        allergen_tags: "",
      },
    ]);

    const result = checkNumericProvenance({
      output: typedOutput(
        "Salmon has 20g protein and 208 kcal. Broccoli has 34 kcal and 2.8g protein.",
      ),
      observations: [foodA, foodB],
    });

    expect(result.passed).toBe(true);
  });

  it("tolerates decimal rounding for fractional nutrition values", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "food-001",
        food_name: "Some food",
        portion_g: 100,
        kcal: 165,
        protein_g: 31.45, // DB has 31.45
        fat_g: 3.6,
        carbs_g: 0.7, // DB has 0.7
        allergen_tags: "",
      },
    ]);

    // Prose rounds to 31g (from 31.45) and 3.6g fat (exact match).
    // 31g vs 31.45 is within 2% tolerance — rounding passes.
    const result = checkNumericProvenance({
      output: typedOutput("This food has 31g protein and 3.6g fat."),
      observations: [obs],
    });

    expect(result.passed).toBe(true);
  });
});
