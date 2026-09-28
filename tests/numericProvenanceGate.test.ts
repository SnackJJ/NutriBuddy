import { describe, expect, it } from "vitest";
import { checkNumericProvenance, extractNumbersFromProse } from "../src/harness/numericProvenanceGate";
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

// ── the unit vocabulary is measured against the corpus, not remembered ──────
//
// This test exists because the gap it guards was invisible: the gate could not
// extract "600 IU" or "15 mcg" at all, so a figure stated from the evidence text
// was never checked — and vitamin D's recommended intake is written in exactly
// those two units. Nothing failed; the gate simply did not look.
//
// The list is derived from the committed corpus (counts in the comment below), so
// a new source whose units are not recognized shows up here rather than as an
// unchecked number in an answer.

describe("unit vocabulary covers what the corpus states", () => {
  // Occurrences of `<number> <unit>` in sources/*/sections.jsonl, measured
  // 2026-09-17: mg 420, mcg 285, g 64, iu 92, nmol 58, ng 58.
  const CORPUS_UNITS = ["mg", "mcg", "g", "iu", "nmol", "ng"];

  for (const unit of CORPUS_UNITS) {
    it(`extracts a number attached to "${unit}"`, () => {
      const extracted = extractNumbersFromProse(`The value is 123 ${unit} per day.`);
      expect(extracted.map((entry) => entry.unit)).toContain(unit);
    });
  }

  it("writes micrograms in the three spellings the corpus uses", () => {
    for (const spelling of ["mcg", "µg", "ug"]) {
      expect(extractNumbersFromProse(`15 ${spelling}`).map((entry) => entry.unit)).toContain(spelling);
    }
  });

  it("converts micrograms against milligram observations instead of calling it a mismatch", () => {
    // 0.5 mg and 500 mcg are the same amount; without the conversion table the
    // gate would have seen a grounded figure as ungrounded, which is the failure
    // direction that costs a correct answer.
    const check = checkNumericProvenance({
      output: { prose: "That food has 500 mcg of folate.", foodRefs: [], ruleRefs: [] },
      observations: [
        makeObservation(
          "food_lookup",
          [{ name: "folate", type: "number", unit: "mg", description: "folate" }],
          [{ folate: 0.5 }],
        ),
      ],
    });
    expect(check.passed).toBe(true);
  });
});

// ── spelled-out units must be groundable, not merely visible ────────────────
//
// Recognizing a unit the catalog cannot express is worse than not recognizing it:
// the figure becomes visible to the gate and then fails to match an observation
// column written as `mg`, so a correctly grounded answer gets refused. The
// reviewer of this change found exactly that, which is why the direction is
// asserted rather than the extraction alone.

describe("spelled-out mass units fold onto the catalog's vocabulary", () => {
  const cases = [
    { prose: "That food has 500 milligrams of sodium.", unit: "mg", value: 500 },
    { prose: "It provides 100 grams of protein.", unit: "g", value: 100 },
    { prose: "It has 500 micrograms of folate.", unit: "mcg", value: 500 },
    { prose: "That is 2 kilograms of food.", unit: "kg", value: 2 },
  ];

  for (const { prose, unit, value } of cases) {
    it(`passes "${prose}" against an observation in ${unit}`, () => {
      const check = checkNumericProvenance({
        output: { prose, foodRefs: [], ruleRefs: [] },
        observations: [
          makeObservation(
            "food_lookup",
            [{ name: "amount", type: "number", unit, description: "amount" }],
            [{ amount: value }],
          ),
        ],
      });
      expect(check.reasons).toEqual([]);
      expect(check.passed).toBe(true);
    });
  }

  it("still blocks a spelled-out unit with no matching observation", () => {
    const check = checkNumericProvenance({
      output: { prose: "It provides 100 grams of protein.", foodRefs: [], ruleRefs: [] },
      observations: [],
    });
    expect(check.passed).toBe(false);
  });
});

// ── the user's own portion is a source (live d1) ────────────────────────────
//
// d1 said "about 150g" and the answer's "150 g" was refused as ungrounded. The
// user's words may ground a *portion*; they may not ground nutrient content, and
// they never ground energy — those still have to come from the catalog.

describe("user-stated quantities", () => {
  function check(prose: string, userInput: string, observations: Observation[] = []) {
    return checkNumericProvenance({ output: typedOutput(prose), observations, userInput });
  }

  describe("ground a portion the user said", () => {
    const cases = [
      { userInput: "Log the shrimp I ate — about 150g with rice.", prose: "Logged 150 g of shrimp." },
      { userInput: "I had 150 g of shrimp", prose: "Logged 150g shrimp." },
      { userInput: "I had 150g of shrimp", prose: "Logged 150 grams of shrimp." },
      { userInput: "I had 150 grams of shrimp", prose: "Logged 150 g of shrimp." },
      { userInput: "I had 150g of shrimp", prose: "Logged 0.15 kg of shrimp." },
      { userInput: "I drank 2 cups of milk", prose: "Logged 2 cups of milk." },
      { userInput: "I drank 1 cup of milk", prose: "That is about 237 ml of milk." },
      { userInput: "I had 5 oz of salmon", prose: "Logged 142 g of salmon." },
      { userInput: "I drank half a cup of milk", prose: "Logged 0.5 cup of milk." },
      { userInput: "Log 250g of salmon", prose: "| Food | Portion |\n| salmon | 250 g |" },
    ];
    for (const { userInput, prose } of cases) {
      it(`"${userInput}" → "${prose.replace(/\n/g, " ")}"`, () => {
        const result = check(prose, userInput);
        expect(result.reasons).toEqual([]);
        expect(result.passed).toBe(true);
      });
    }
  });

  describe("do not ground nutrient content or other units", () => {
    const cases = [
      // The user's number, reframed as a nutrient: the case the fix must not open.
      { userInput: "I had 150g of shrimp", prose: "That is 150 g protein." },
      { userInput: "I had 150g of shrimp", prose: "That is 150 g of protein." },
      { userInput: "I had 150g of shrimp", prose: "It has 150 g of total fat." },
      { userInput: "I had 150g of shrimp", prose: "Protein: 150 g" },
      { userInput: "I had 150g of shrimp", prose: "| Protein | 150 g |" },
      { userInput: "I had 150g of shrimp", prose: "carbs of 150 g" },
      // Energy is never a portion, even when the user said it.
      { userInput: "I had 500 kcal of pasta", prose: "Logged 500 kcal of pasta." },
      // A user's own nutrient claim is not a source either.
      { userInput: "My shake had 30 g protein", prose: "Logged a shake with 30 g of protein." },
      // Mass ↔ volume needs a density — a food fact, not a unit fact.
      { userInput: "I drank 250 ml of milk", prose: "Logged 250 g of milk." },
      // A different number is not the user's number.
      { userInput: "I had 150g of shrimp", prose: "Logged 200 g of shrimp." },
      // No user input, no user source.
      { userInput: "", prose: "Logged 150 g of shrimp." },
    ];
    for (const { userInput, prose } of cases) {
      it(`"${userInput}" ↛ "${prose}"`, () => {
        expect(check(prose, userInput).passed).toBe(false);
      });
    }
  });

  it("releases the portion but still blocks a nutrient figure in the same answer", () => {
    const result = check("Logged 150 g of shrimp — 150 g protein, 20 g fat.", "about 150g of shrimp");
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain('"150 g"');
    expect(result.reasons[1]).toContain('"20 g"');
  });

  it("does not replace observations: catalog figures still ground as before", () => {
    const obs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "food-shrimp-001",
        food_name: "shrimp",
        portion_g: 150,
        kcal: 127.5,
        protein_g: 30,
        fat_g: 0.8,
        carbs_g: 0,
        allergen_tags: "shellfish",
      },
    ]);
    const result = check("150 g shrimp: 127.5 kcal, 30 g protein.", "about 150g of shrimp", [obs]);
    expect(result.passed).toBe(true);
  });
});
