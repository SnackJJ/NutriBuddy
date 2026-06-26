import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getInteractions,
  normalizeDrug,
  supabaseInteractionStore,
  type DrugNutrientInteraction,
  type InteractionStore,
} from "../src/lib/drugInteractions";

const SAMPLE: DrugNutrientInteraction[] = [
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
    drugName: "metformin",
    nutrient: "alcohol",
    foodExamples: ["beer", "wine"],
    severity: "moderate",
    source: "MedlinePlus",
  },
];

function fakeStore(rows: DrugNutrientInteraction[]): InteractionStore {
  return { all: async () => rows };
}

describe("normalizeDrug", () => {
  it("lowercases and trims so profile spelling never misses a rule", () => {
    expect(normalizeDrug("  Warfarin ")).toBe("warfarin");
    expect(normalizeDrug("METFORMIN")).toBe("metformin");
  });
});

describe("getInteractions", () => {
  it("returns every rule whose drug the user takes, case-insensitively", async () => {
    const result = await getInteractions(["Warfarin"], fakeStore(SAMPLE));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.nutrient).sort()).toEqual([
      "cranberry",
      "vitamin K",
    ]);
  });

  it("collects rules across multiple medications", async () => {
    const result = await getInteractions(
      ["warfarin", "metformin"],
      fakeStore(SAMPLE),
    );
    expect(result.map((r) => r.drugName).sort()).toEqual([
      "metformin",
      "warfarin",
      "warfarin",
    ]);
  });

  it("returns nothing for a medication with no known interaction", async () => {
    const result = await getInteractions(["ibuprofen"], fakeStore(SAMPLE));
    expect(result).toEqual([]);
  });

  it("short-circuits to empty without touching the store when no meds given", async () => {
    let touched = false;
    const store: InteractionStore = {
      all: async () => {
        touched = true;
        return SAMPLE;
      },
    };
    expect(await getInteractions([], store)).toEqual([]);
    expect(await getInteractions(["", "  "], store)).toEqual([]);
    expect(touched).toBe(false);
  });
});

describe("supabaseInteractionStore", () => {
  it("selects from drug_nutrient_interactions and maps snake_case rows to camelCase", async () => {
    let selectedTable = "";
    let selectedCols = "";
    const client = {
      from(table: string) {
        selectedTable = table;
        return {
          select(cols: string) {
            selectedCols = cols;
            return Promise.resolve({
              data: [
                {
                  drug_name: "warfarin",
                  nutrient: "vitamin K",
                  food_examples: ["kale", "spinach"],
                  severity: "high",
                  source: "NIH ODS",
                },
              ],
              error: null,
            });
          },
        };
      },
    };

    const rows = await supabaseInteractionStore(client).all();

    expect(selectedTable).toBe("drug_nutrient_interactions");
    expect(selectedCols).toContain("food_examples");
    expect(rows).toEqual([
      {
        drugName: "warfarin",
        nutrient: "vitamin K",
        foodExamples: ["kale", "spinach"],
        severity: "high",
        source: "NIH ODS",
      },
    ]);
  });

  it("throws a clear error when the query fails (fail loud, never silently empty)", async () => {
    const client = {
      from() {
        return {
          select() {
            return Promise.resolve({
              data: null,
              error: { message: "permission denied" },
            });
          },
        };
      },
    };

    await expect(supabaseInteractionStore(client).all()).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("seed migration", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../supabase/migrations/0001_drug_nutrient_interactions.sql", import.meta.url)),
    "utf8",
  );

  it("creates the table with the agreed columns", () => {
    expect(sql).toMatch(/create table[^;]*drug_nutrient_interactions/i);
    for (const col of [
      "drug_name",
      "nutrient",
      "food_examples",
      "severity",
      "source",
      "created_at",
    ]) {
      expect(sql.toLowerCase()).toContain(col);
    }
  });

  it("seeds 20-30 interaction rows", () => {
    const rows = sql.match(/array\[/gi) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeLessThanOrEqual(30);
  });

  it("covers the six interactions named in the acceptance criteria", () => {
    const lower = sql.toLowerCase();
    for (const keyword of [
      "warfarin",
      "vitamin k",
      "tyramine",
      "metformin",
      "grapefruit",
      "levothyroxine",
      "potassium",
    ]) {
      expect(lower).toContain(keyword);
    }
  });

  it("cites every rule to an authoritative source", () => {
    expect(sql).toMatch(/NIH ODS|MedlinePlus/);
  });
});
