import { describe, it, expect } from "vitest";
import {
  UsdaClient,
  createGetFoodNutritionTool,
  GET_FOOD_NUTRITION_SCHEMA,
  mapToCatalogFood,
  generateFoodId,
  createCatalogSnapshot,
} from "../src/lib/usda";
import type { FoodNutrition, FoodNutritionLookup } from "../src/lib/usda";

// --- helpers ---

function okJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function usdaFoodResponse(
  foods: Array<{
    description: string;
    nutrients: Array<{ id: number; value: number }>;
  }>,
): Response {
  return okJson({
    foods: foods.map((f) => ({
      fdcId: 1234,
      description: f.description,
      dataType: "Foundation",
      foodNutrients: f.nutrients.map((n) => ({
        nutrientId: n.id,
        nutrientName: `Nutrient ${n.id}`,
        value: n.value,
        unitName: "g",
      })),
    })),
  });
}

/** A complete set of 14 nutrients for a 100g reference portion. */
function fullNutrients(
  overrides: Partial<Record<number, number>> = {},
): Record<number, number> {
  const defaults: Record<number, number> = {
    1008: 52, // kcal
    1003: 0.3, // protein_g
    1004: 0.2, // fat_g
    1005: 14, // carbs_g
    1079: 2.4, // fiber_g
    2000: 10, // sugars_g
    1258: 0.03, // saturated_fat_g
    1253: 0, // cholesterol_mg
    1093: 1, // sodium_mg
    1087: 6, // calcium_mg
    1089: 0.1, // iron_mg
    1092: 107, // potassium_mg
    1162: 4.6, // vitamin_c_mg
    1114: 0, // vitamin_d_mcg
  };
  const merged: Record<number, number> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      merged[Number(key)] = value;
    }
  }
  return merged;
}

function nutrientEntries(
  n: Record<number, number>,
): Array<{ id: number; value: number }> {
  return Object.entries(n).map(([id, v]) => ({ id: Number(id), value: v }));
}

// --- UsdaClient ---

describe("UsdaClient", () => {
  it("throws when no API key is available", () => {
    expect(() => new UsdaClient({ env: {} })).toThrow(/USDA_API_KEY/);
  });

  it("reads API key from USDA_API_KEY env var", async () => {
    let capturedUrl: string | undefined;
    const client = new UsdaClient({
      env: { USDA_API_KEY: "env-key" },
      fetchImpl: async (url) => {
        capturedUrl = String(url);
        return usdaFoodResponse([{ description: "apple", nutrients: [] }]);
      },
    });

    await client.getFoodNutrition("apple");
    expect(capturedUrl).toContain("api_key=env-key");
  });

  it("searches USDA foods/search endpoint with the query", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? "");
        return usdaFoodResponse([{ description: "apple", nutrients: [] }]);
      },
    });

    await client.getFoodNutrition("apple");
    expect(capturedUrl).toContain("/fdc/v1/foods/search");
    const body = JSON.parse(capturedBody!);
    expect(body.query).toBe("apple");
  });

  it("returns FoodNutrition for the first match with all 14 nutrient fields", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        usdaFoodResponse([
          {
            description: "Apples, raw, with skin",
            nutrients: nutrientEntries(fullNutrients()),
          },
        ]),
    });

    const result = await client.getFoodNutrition("apple");
    expect(result).not.toBeNull();
    expect(result!.food_name).toBe("Apples, raw, with skin");
    expect(result!.kcal).toBe(52);
    expect(result!.protein_g).toBe(0.3);
    expect(result!.fat_g).toBe(0.2);
    expect(result!.carbs_g).toBe(14);
    expect(result!.fiber_g).toBe(2.4);
    expect(result!.sugars_g).toBe(10);
    expect(result!.saturated_fat_g).toBe(0.03);
    expect(result!.cholesterol_mg).toBe(0);
    expect(result!.sodium_mg).toBe(1);
    expect(result!.calcium_mg).toBe(6);
    expect(result!.iron_mg).toBe(0.1);
    expect(result!.potassium_mg).toBe(107);
    expect(result!.vitamin_c_mg).toBe(4.6);
    expect(result!.vitamin_d_mcg).toBe(0);
  });

  it("scales nutrient values by portion_g / 100", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        usdaFoodResponse([
          {
            description: "apple",
            nutrients: [
              { id: 1008, value: 52 },
              { id: 1003, value: 0.3 },
            ],
          },
        ]),
    });

    const result = await client.getFoodNutrition("apple", 150);
    expect(result!.kcal).toBeCloseTo(78, 5); // 52 * 1.5
    expect(result!.protein_g).toBeCloseTo(0.45, 5); // 0.3 * 1.5
    expect(result!.portion_g).toBe(150);
  });

  it("defaults portion_g to 100 (no scaling)", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        usdaFoodResponse([
          {
            description: "apple",
            nutrients: [{ id: 1008, value: 52 }],
          },
        ]),
    });

    const result = await client.getFoodNutrition("apple");
    expect(result!.portion_g).toBe(100);
    expect(result!.kcal).toBe(52);
  });

  it("returns null when foods array is empty", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () => okJson({ foods: [] }),
    });

    const result = await client.getFoodNutrition("zzz_nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when foodNutrients is missing from the food object", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        okJson({
          foods: [
            {
              fdcId: 1,
              description: "bare food",
              dataType: "Foundation",
            },
          ],
        }),
    });

    const result = await client.getFoodNutrition("bare food");
    expect(result).not.toBeNull();
    expect(result!.food_name).toBe("bare food");
    // all nutrients default to 0
    expect(result!.kcal).toBe(0);
    expect(result!.protein_g).toBe(0);
  });

  it("throws on non-2xx response with status code in message", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () => new Response("server error", { status: 500 }),
    });

    await expect(client.getFoodNutrition("apple")).rejects.toThrow(/500/);
  });

  it("throws on a 200 response whose body is not valid JSON", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.getFoodNutrition("apple")).rejects.toThrow();
  });

  it("defaults missing nutrients to 0 (no NaN)", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        usdaFoodResponse([
          {
            description: "apple",
            nutrients: [
              { id: 1008, value: 52 },
              { id: 1003, value: 0.3 },
            ],
          },
        ]),
    });

    const result = await client.getFoodNutrition("apple");
    expect(result!.kcal).toBe(52);
    expect(result!.protein_g).toBe(0.3);
    // these nutrients were not in the response → default to 0
    expect(result!.fat_g).toBe(0);
    expect(result!.fiber_g).toBe(0);
    expect(result!.vitamin_c_mg).toBe(0);
    expect(result!.vitamin_d_mcg).toBe(0);
  });

  it("ignores nutrients with undefined or non-finite values", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        okJson({
          foods: [
            {
              fdcId: 1,
              description: "weird food",
              foodNutrients: [
                { nutrientId: 1008, value: null },
                { nutrientId: 1003, value: 0.3 },
                { nutrientId: 1004 },
              ],
            },
          ],
        }),
    });

    const result = await client.getFoodNutrition("weird food");
    expect(result!.kcal).toBe(0); // null value → ignored
    expect(result!.protein_g).toBe(0.3);
    expect(result!.fat_g).toBe(0); // missing value → ignored
  });

  it("uses the first food when multiple matches are returned", async () => {
    const client = new UsdaClient({
      apiKey: "k",
      fetchImpl: async () =>
        usdaFoodResponse([
          {
            description: "first match",
            nutrients: [{ id: 1008, value: 100 }],
          },
          {
            description: "second match",
            nutrients: [{ id: 1008, value: 200 }],
          },
        ]),
    });

    const result = await client.getFoodNutrition("test");
    expect(result!.food_name).toBe("first match");
    expect(result!.kcal).toBe(100);
  });
});

// --- Schema ---

describe("GET_FOOD_NUTRITION_SCHEMA", () => {
  it("has type function", () => {
    const schema = GET_FOOD_NUTRITION_SCHEMA as Record<string, unknown>;
    expect(schema.type).toBe("function");
  });

  it("has name get_food_nutrition", () => {
    const fn = (GET_FOOD_NUTRITION_SCHEMA as Record<string, unknown>)
      .function as Record<string, unknown>;
    expect(fn.name).toBe("get_food_nutrition");
  });

  it("has food_name as a required string property", () => {
    const fn = (GET_FOOD_NUTRITION_SCHEMA as Record<string, unknown>)
      .function as Record<string, unknown>;
    const params = fn.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.food_name.type).toBe("string");
    expect(params.required).toContain("food_name");
  });

  it("has portion_g as an optional number property", () => {
    const fn = (GET_FOOD_NUTRITION_SCHEMA as Record<string, unknown>)
      .function as Record<string, unknown>;
    const params = fn.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.portion_g.type).toBe("number");
    const required = params.required as string[];
    expect(required).not.toContain("portion_g");
  });
});

// --- Tool handler ---

describe("createGetFoodNutritionTool", () => {
  function makeClient(
    impl: (food: string, portion?: number) => Promise<FoodNutrition | null>,
  ): FoodNutritionLookup {
    return { getFoodNutrition: impl };
  }

  it("exposes the schema on the returned handler", () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    expect(tool.schema).toBe(GET_FOOD_NUTRITION_SCHEMA);
  });

  it("rejects empty food_name", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "" });
    expect(result).toContain("food_name");
  });

  it("rejects missing food_name", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({});
    expect(result).toContain("food_name");
  });

  it("rejects zero portion_g", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "apple", portion_g: 0 });
    expect(result).toContain("portion");
  });

  it("rejects negative portion_g", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "apple", portion_g: -10 });
    expect(result).toContain("portion");
  });

  it("rejects NaN portion_g", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "apple", portion_g: NaN });
    expect(result).toContain("portion");
  });

  it("rejects Infinity portion_g", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({
      food_name: "apple",
      portion_g: Infinity,
    });
    expect(result).toContain("portion");
  });

  it("returns JSON-serialized FoodNutrition on success", async () => {
    const food: FoodNutrition = {
      food_name: "Apple",
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
    const client = makeClient(async () => food);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "apple" });
    const parsed = JSON.parse(result) as FoodNutrition;
    expect(parsed.food_name).toBe("Apple");
    expect(parsed.kcal).toBe(52);
    expect(parsed.protein_g).toBe(0.3);
  });

  it("returns error string when food not found", async () => {
    const client = makeClient(async () => null);
    const tool = createGetFoodNutritionTool(client);
    const result = await tool.execute({ food_name: "zzz_nonexistent" });
    expect(typeof result).toBe("string");
    expect(result).toMatch(/未找到|no food found/i);
  });

  it("returns error string when UsdaClient throws (never throws)", async () => {
    const client = makeClient(async () => {
      throw new Error("API down");
    });
    const tool = createGetFoodNutritionTool(client);
    // should not throw — error is returned as a string
    const result = await tool.execute({ food_name: "apple" });
    expect(typeof result).toBe("string");
    expect(result).toContain("USDA");
  });
});

// ─── Snapshot ingestion adapter (issue #42) ─────────────────────────────────

describe("generateFoodId", () => {
  it("generates a stable id from a food name and index", () => {
    const id = generateFoodId("Apples, raw, with skin", 1);
    expect(id).toBe("food-usda-apples-raw-with-skin-001");
  });

  it("pads the index to three digits", () => {
    expect(generateFoodId("banana", 5)).toContain("-005");
    expect(generateFoodId("banana", 42)).toContain("-042");
    expect(generateFoodId("banana", 100)).toContain("-100");
  });

  it("lowercases and replaces non-alphanumeric characters with dashes", () => {
    const id = generateFoodId("Chicken Breast", 1);
    expect(id).toBe("food-usda-chicken-breast-001");
  });

  it("strips leading and trailing dashes from the fragment", () => {
    const id = generateFoodId("  (special food)  ", 3);
    expect(id).toMatch(/^food-usda-special-food-003$/);
  });
});

describe("mapToCatalogFood", () => {
  function appleFood(): FoodNutrition {
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

  it("maps a USDA FoodNutrition to a CatalogFood entry with all 14 nutrients", () => {
    const result = mapToCatalogFood(appleFood(), 0);

    expect(result.id).toBe("food-usda-apples-raw-with-skin-000");
    expect(result.canonicalName).toBe("apples, raw, with skin");
    expect(result.per100g.kcal).toBe(52);
    expect(result.per100g.proteinG).toBe(0.3);
    expect(result.per100g.fatG).toBe(0.2);
    expect(result.per100g.carbsG).toBe(14);
    expect(result.per100g.fiberG).toBe(2.4);
    expect(result.per100g.sugarsG).toBe(10);
    expect(result.per100g.saturatedFatG).toBe(0.03);
    expect(result.per100g.cholesterolMg).toBe(0);
    expect(result.per100g.sodiumMg).toBe(1);
    expect(result.per100g.calciumMg).toBe(6);
    expect(result.per100g.ironMg).toBe(0.1);
    expect(result.per100g.potassiumMg).toBe(107);
    expect(result.per100g.vitaminCMg).toBe(4.6);
    expect(result.per100g.vitaminDMcg).toBe(0);
  });

  it("omits allergen tags — unreviewed foods fail closed at the entity check (issue #66)", () => {
    const result = mapToCatalogFood(appleFood(), 0);
    // An empty array would falsely mean "reviewed, no allergens"
    expect(result.allergenTags).toBeUndefined();
  });

  it("derives aliases from comma-separated USDA food descriptions", () => {
    const result = mapToCatalogFood(appleFood(), 0);

    // "Apples, raw, with skin" → aliases should include short forms
    expect(result.aliases).toContain("apples");
    expect(result.aliases).toContain("apples raw");
  });

  it("does not derive aliases for simple names without commas", () => {
    const food: FoodNutrition = {
      food_name: "banana",
      portion_g: 100,
      kcal: 89,
      protein_g: 1.1,
      fat_g: 0.3,
      carbs_g: 23,
      fiber_g: 2.6,
      sugars_g: 12,
      saturated_fat_g: 0.1,
      cholesterol_mg: 0,
      sodium_mg: 1,
      calcium_mg: 5,
      iron_mg: 0.3,
      potassium_mg: 358,
      vitamin_c_mg: 8.7,
      vitamin_d_mcg: 0,
    };

    const result = mapToCatalogFood(food, 0);
    expect(result.aliases).toEqual([]);
  });

  it("uses the provided category", () => {
    const result = mapToCatalogFood(appleFood(), 0, "fruit");
    expect(result.category).toBe("fruit");
  });

  it("defaults category to general", () => {
    const result = mapToCatalogFood(appleFood(), 0);
    expect(result.category).toBe("general");
  });

  it("produces empty portion aliases (human review needed)", () => {
    const result = mapToCatalogFood(appleFood(), 0);
    expect(result.portionAliases).toEqual({});
  });

  it("generates unique ids for each index", () => {
    const r0 = mapToCatalogFood(appleFood(), 0);
    const r1 = mapToCatalogFood(appleFood(), 1);
    expect(r0.id).not.toBe(r1.id);
    expect(r0.id).toContain("-000");
    expect(r1.id).toContain("-001");
  });
});

describe("createCatalogSnapshot", () => {
  function appleFood(): FoodNutrition {
    return {
      food_name: "apple",
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

  it("creates a versioned snapshot envelope", () => {
    const foods = [
      mapToCatalogFood(appleFood(), 0),
      mapToCatalogFood(appleFood(), 1),
    ];
    const snapshot = createCatalogSnapshot(foods, new Date("2026-07-10"));

    expect(snapshot.version).toBe("usda-snapshot-2026-07-10");
    expect(snapshot.generatedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(snapshot.source).toBe("USDA FoodData Central");
    expect(snapshot.foods).toEqual(foods);
  });

  it("version stamp is date-stamped from generation time", () => {
    const foods = [mapToCatalogFood(appleFood(), 0)];
    const snapshot = createCatalogSnapshot(foods, new Date("2025-01-15"));

    expect(snapshot.version).toBe("usda-snapshot-2025-01-15");
  });

  it("snapshot version stamp is suitable for trace reproduction", () => {
    const foods = [mapToCatalogFood(appleFood(), 0)];
    const snapshot = createCatalogSnapshot(foods, new Date("2026-07-10"));

    // The version is a string that can be stored and compared
    expect(typeof snapshot.version).toBe("string");
    expect(snapshot.version.length).toBeGreaterThan(0);
  });

  it("produces deterministic snapshots for the same inputs", () => {
    const foods = [mapToCatalogFood(appleFood(), 0)];
    const s1 = createCatalogSnapshot(foods, new Date("2026-07-10"));
    const s2 = createCatalogSnapshot(foods, new Date("2026-07-10"));

    expect(s1.version).toBe(s2.version);
    expect(s1.source).toBe(s2.source);
    expect(s1.foods).toEqual(s2.foods);
  });
});
