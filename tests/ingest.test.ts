import { describe, it, expect, vi } from "vitest";
import { ingestFoods, runIngestion } from "../src/ingest/usda";
import { UsdaClient } from "../src/lib/usda";
import type { FoodNutrition } from "../src/lib/usda";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── structural: runtime isolation from USDA (issue #42) ─────────────────────

describe("runtime code has no USDA network dependency", () => {
  it("harness loop does not import UsdaClient or createGetFoodNutritionTool", () => {
    const loopSource = fs.readFileSync("src/harness/loop.ts", "utf-8");
    expect(loopSource).not.toMatch(/from.*usda/);
    expect(loopSource).not.toMatch(/UsdaClient/);
    expect(loopSource).not.toMatch(/createGetFoodNutritionTool/);
  });

  it("turn seam does not import UsdaClient or createGetFoodNutritionTool", () => {
    const turnSource = fs.readFileSync("src/harness/turn.ts", "utf-8");
    expect(turnSource).not.toMatch(/from.*usda/);
    expect(turnSource).not.toMatch(/UsdaClient/);
    expect(turnSource).not.toMatch(/createGetFoodNutritionTool/);
  });

  it("chat API route does not import UsdaClient or createGetFoodNutritionTool", () => {
    const routeSource = fs.readFileSync("app/api/chat/route.ts", "utf-8");
    expect(routeSource).not.toMatch(/from.*usda/);
    expect(routeSource).not.toMatch(/UsdaClient/);
    expect(routeSource).not.toMatch(/createGetFoodNutritionTool/);
  });

  it("chatApi helpers do not import UsdaClient or createGetFoodNutritionTool", () => {
    const chatApiSource = fs.readFileSync("src/lib/chatApi.ts", "utf-8");
    expect(chatApiSource).not.toMatch(/from.*usda/);
    expect(chatApiSource).not.toMatch(/UsdaClient/);
    expect(chatApiSource).not.toMatch(/createGetFoodNutritionTool/);
  });

  it("CLI does not import UsdaClient or createGetFoodNutritionTool", () => {
    const cliSource = fs.readFileSync("src/cli.ts", "utf-8");
    expect(cliSource).not.toMatch(/from.*usda/);
    expect(cliSource).not.toMatch(/UsdaClient/);
    expect(cliSource).not.toMatch(/createGetFoodNutritionTool/);
  });

  it("the tool layer reads only the local catalog (query_catalog, food_lookup)", () => {
    // Verify the food_lookup template exists as the catalog-based nutrition lookup
    const queryCatalogSource = fs.readFileSync(
      "src/catalog/queryCatalog.ts",
      "utf-8",
    );
    expect(queryCatalogSource).toContain("food_lookup");
    // The food_lookup description explicitly says it uses the local catalog
    expect(queryCatalogSource).toContain("catalog food ID");
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function appleNutrition(): FoodNutrition {
  return {
    food_name: "Apples, raw, with skin",
    portion_g: 100,
    kcal: 52,
    protein_g: 0.3,
    fat_g: 0.2,
    carbs_g: 14,
    fiber_g: 2.4,
    sugars_g: 10,
    saturated_fat_g: 0.03,
    cholesterol_mg: 0,
    sodium_mg: 1,
    calcium_mg: 6,
    iron_mg: 0.1,
    potassium_mg: 107,
    vitamin_c_mg: 4.6,
    vitamin_d_mcg: 0,
  };
}

function salmonNutrition(): FoodNutrition {
  return {
    food_name: "Salmon, Atlantic, raw",
    portion_g: 100,
    kcal: 208,
    protein_g: 20,
    fat_g: 13,
    carbs_g: 0,
    fiber_g: 0,
    sugars_g: 0,
    saturated_fat_g: 3.1,
    cholesterol_mg: 55,
    sodium_mg: 59,
    calcium_mg: 9,
    iron_mg: 0.3,
    potassium_mg: 363,
    vitamin_c_mg: 0,
    vitamin_d_mcg: 11,
  };
}

function makeClient(
  impl: (food: string) => Promise<FoodNutrition | null>,
): UsdaClient {
  return {
    getFoodNutrition: async (foodName: string, _portionG?: number) =>
      impl(foodName),
  } as UsdaClient;
}

// ─── ingestFoods ─────────────────────────────────────────────────────────────

describe("ingestFoods", () => {
  it("fetches and maps multiple foods into CatalogFood entries", async () => {
    const client = makeClient(async (food) => {
      if (food === "apple") return appleNutrition();
      if (food === "salmon") return salmonNutrition();
      return null;
    });

    const results = await ingestFoods(client, ["apple", "salmon"]);

    expect(results).toHaveLength(2);
    expect(results[0].canonicalName).toBe("apples, raw, with skin");
    expect(results[0].per100g.kcal).toBe(52);
    expect(results[0].per100g.proteinG).toBe(0.3);
    expect(results[0].per100g.fatG).toBe(0.2);
    expect(results[0].per100g.carbsG).toBe(14);
    // All 14 nutrient fields present
    expect(results[0].per100g.fiberG).toBe(2.4);
    expect(results[0].per100g.saturatedFatG).toBe(0.03);
    expect(results[0].per100g.vitaminDMcg).toBe(0);

    expect(results[1].canonicalName).toBe("salmon, atlantic, raw");
    expect(results[1].per100g.kcal).toBe(208);
  });

  it("assigns sequential ids based on ingestion order", async () => {
    const client = makeClient(async (food) => {
      if (food === "apple") return appleNutrition();
      if (food === "salmon") return salmonNutrition();
      return null;
    });

    const results = await ingestFoods(client, ["apple", "salmon"]);

    expect(results[0].id).toContain("-000");
    expect(results[1].id).toContain("-001");
  });

  it("skips foods USDA returns no results for", async () => {
    const client = makeClient(async (food) => {
      if (food === "apple") return appleNutrition();
      return null; // "dragonfruit" not found
    });

    const results = await ingestFoods(client, ["apple", "dragonfruit"]);

    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe("apples, raw, with skin");
  });

  it("skips foods that throw during fetch (error resilience)", async () => {
    const client = makeClient(async (food) => {
      if (food === "apple") return appleNutrition();
      throw new Error("API down");
    });

    const results = await ingestFoods(client, ["apple", "fail-food"]);

    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe("apples, raw, with skin");
  });

  it("skips empty/whitespace food names", async () => {
    const client = makeClient(async () => appleNutrition());

    const results = await ingestFoods(client, ["", "  ", "apple"]);

    expect(results).toHaveLength(1);
    expect(results[0].canonicalName).toBe("apples, raw, with skin");
  });

  it("returns empty array for empty input list", async () => {
    const client = makeClient(async () => appleNutrition());

    const results = await ingestFoods(client, []);

    expect(results).toHaveLength(0);
  });

  it("emits CatalogFood entries with empty allergen tags (fail-closed)", async () => {
    const client = makeClient(async () => salmonNutrition());

    const results = await ingestFoods(client, ["salmon"]);

    expect(results[0].allergenTags).toEqual([]);
  });

  it("derives aliases from USDA food descriptions", async () => {
    const client = makeClient(async () => appleNutrition());

    const results = await ingestFoods(client, ["apple"]);

    expect(results[0].aliases).toContain("apples");
    expect(results[0].aliases).toContain("apples raw");
  });

  it("uses provided category overrides", async () => {
    const client = makeClient(async () => appleNutrition());

    const results = await ingestFoods(client, ["apple"], { apple: "test-category" });

    expect(results[0].category).toBe("test-category");
  });

  it("guesses categories when no override provided", async () => {
    const client = makeClient(async () => salmonNutrition());

    const results = await ingestFoods(client, ["salmon"]);

    expect(results[0].category).toBe("seafood");
  });
});

// ─── runIngestion ────────────────────────────────────────────────────────────

describe("runIngestion", () => {
  it("writes a versioned CatalogSnapshot JSON file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-ingest-"));
    const outputPath = path.join(tmpDir, "catalog-snapshot.json");

    const client = makeClient(async (food) => {
      if (food === "apple") return appleNutrition();
      return null;
    });

    try {
      const snapshot = await runIngestion(client, ["apple"], outputPath);

      expect(snapshot.version).toMatch(/^usda-snapshot-/);
      expect(snapshot.source).toBe("USDA FoodData Central");
      expect(snapshot.foods).toHaveLength(1);

      // Verify the file was written
      const content = fs.readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.version).toBe(snapshot.version);
      expect(parsed.foods).toHaveLength(1);
      expect(parsed.foods[0].canonicalName).toBe("apples, raw, with skin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates output directories if they do not exist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-ingest-"));
    const nestedPath = path.join(tmpDir, "sub", "nested", "snapshot.json");

    const client = makeClient(async () => appleNutrition());

    try {
      const snapshot = await runIngestion(client, ["apple"], nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(snapshot.foods).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("version stamp is suitable for trace reproduction", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-ingest-"));
    const outputPath = path.join(tmpDir, "snapshot.json");

    const client = makeClient(async () => appleNutrition());

    try {
      const snapshot = await runIngestion(client, ["apple"], outputPath);

      // Version is stable for rerunning against the same snapshot
      expect(typeof snapshot.version).toBe("string");
      expect(snapshot.version.length).toBeGreaterThan("usda-snapshot-".length);
      // generatedAt is an ISO 8601 timestamp
      expect(snapshot.generatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns the snapshot object for inspection (testable output)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-ingest-"));
    const outputPath = path.join(tmpDir, "snapshot.json");

    const client = makeClient(async () => appleNutrition());

    try {
      const snapshot = await runIngestion(client, ["apple"], outputPath);

      // Verify the returned object matches what was written
      const content = fs.readFileSync(outputPath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.version).toBe(snapshot.version);
      expect(parsed.source).toBe(snapshot.source);
      expect(parsed.foods).toHaveLength(snapshot.foods.length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
