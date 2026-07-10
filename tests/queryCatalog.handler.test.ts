import { describe, it, expect } from "vitest";
import {
  createQueryCatalogHandler,
  createInMemoryQueryRunner,
  QUERY_CATALOG_SCHEMA,
  QUERY_CATALOG_TOOL,
  type QueryCatalogHandlerDeps,
} from "../src/harness/queryCatalog";
import {
  createQueryCatalog,
  FOOD_LOOKUP_TEMPLATE,
  ALL_QUERY_TEMPLATES,
  type QueryCatalog,
  type QueryRunner,
  type Observation,
  type ObservationRow,
  type ColumnDef,
  type QueryResult,
  type MealRecord,
} from "../src/catalog/queryCatalog";
import {
  createCatalog,
  SEED_FOODS,
  type Catalog,
} from "../src/catalog/catalog";

// ─── helpers ───────────────────────────────────────────────────────────────

const USER_ID = "user-001";
const FOOD_LOOKUP_ID = FOOD_LOOKUP_TEMPLATE.id;

type QueryErrorResult = Extract<QueryResult, { readonly type: "error" }>;

function seedFoodCatalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

function seedQueryCatalog(): QueryCatalog {
  return createQueryCatalog([FOOD_LOOKUP_TEMPLATE]);
}

function makeHandler(overrides: Partial<QueryCatalogHandlerDeps> = {}) {
  const foodCatalog = seedFoodCatalog();
  const queryCatalog = seedQueryCatalog();
  const runner = createInMemoryQueryRunner(foodCatalog);
  return createQueryCatalogHandler({
    queryCatalog,
    runner,
    userId: USER_ID,
    ...overrides,
  });
}

function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeDefined();
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }

  return value as Record<string, unknown>;
}

function parseResult(result: string): QueryResult {
  const parsed: unknown = JSON.parse(result);
  const record = expectRecord(parsed);
  if (record.type === "observation" || record.type === "error") {
    return parsed as QueryResult;
  }

  throw new Error(`unexpected query_catalog result: ${result}`);
}

function expectObservationResult(result: string): Observation {
  const parsed = parseResult(result);
  expect(parsed.type).toBe("observation");
  if (parsed.type !== "observation") {
    throw new Error(`Expected observation but got ${parsed.type}`);
  }

  return parsed.observation;
}

function expectErrorResult(result: string): QueryErrorResult {
  const parsed = parseResult(result);
  expect(parsed.type).toBe("error");
  if (parsed.type !== "error") {
    throw new Error(`Expected error but got ${parsed.type}`);
  }

  return parsed;
}

function firstRow(observation: Observation): ObservationRow {
  expect(observation.rows).toHaveLength(1);
  return observation.rows[0];
}

function expectNumber(value: unknown): number {
  expect(typeof value).toBe("number");
  if (typeof value !== "number") {
    throw new Error("expected number");
  }

  return value;
}

function expectColumn(
  columns: readonly ColumnDef[],
  name: string,
  expected: Pick<ColumnDef, "type" | "unit">,
): void {
  const column = columns.find((c) => c.name === name);
  expect(column).toBeDefined();
  expect(column!.type).toBe(expected.type);
  expect(column!.unit).toBe(expected.unit);
}

function createScopedUserRunner(): {
  readonly runner: QueryRunner;
  readonly getCapturedUserId: () => string | undefined;
} {
  let capturedUserId: string | undefined;
  return {
    getCapturedUserId: () => capturedUserId,
    runner: async (
      templateId: string,
      _params: Record<string, unknown>,
      userId: string,
    ): Promise<Observation> => {
      capturedUserId = userId;
      return {
        templateId,
        columns: [
          {
            name: "scoped_user",
            type: "string",
            description: "User scoping test",
          },
        ],
        rows: [{ scoped_user: userId }],
        rowCount: 1,
        truncated: false,
      };
    },
  };
}

// ─── schema shape ──────────────────────────────────────────────────────────

describe("QUERY_CATALOG_SCHEMA", () => {
  it("has the correct tool name", () => {
    expect(QUERY_CATALOG_SCHEMA.function.name).toBe(QUERY_CATALOG_TOOL);
  });

  it("is type function", () => {
    expect(QUERY_CATALOG_SCHEMA.type).toBe("function");
  });

  it("has a non-empty description", () => {
    expect(QUERY_CATALOG_SCHEMA.function.description.length).toBeGreaterThan(0);
  });

  it("declares template_id as required", () => {
    const params = QUERY_CATALOG_SCHEMA.function.parameters;
    expect(params.type).toBe("object");
    expect(params.properties).toBeDefined();

    const properties = expectRecord(params.properties);
    expect(properties.template_id).toBeDefined();

    const required = params.required as string[];
    expect(required).toContain("template_id");
  });

  it("only template_id is required in schema (template-specific validation is handler-side)", () => {
    const params = QUERY_CATALOG_SCHEMA.function.parameters;
    const required = params.required as string[];
    expect(required).toEqual(["template_id"]);
  });
});

// ─── handler dispatch: food_lookup ─────────────────────────────────────────

describe("createQueryCatalogHandler — food_lookup", () => {
  it("returns an observation for a valid food_lookup call", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-salmon-001",
    });

    const observation = expectObservationResult(result);
    expect(observation.templateId).toBe(FOOD_LOOKUP_ID);
    expect(observation.rowCount).toBe(1);
  });

  it("returns correct nutrition data from the catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-chicken-breast-001",
    });

    const row = firstRow(expectObservationResult(result));
    expect(row.kcal).toBe(165);
    expect(row.protein_g).toBe(31);
    expect(row.fat_g).toBe(3.6);
    expect(row.carbs_g).toBe(0);
    expect(row.food_name).toBe("chicken breast");
  });

  it("scales nutrition by portion_g", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-salmon-001",
      portion_g: 150,
    });

    const row = firstRow(expectObservationResult(result));
    // Salmon: 208 kcal / 100g → 312 kcal / 150g
    expect(row.kcal).toBe(312);
    expect(row.protein_g).toBe(30);
    expect(row.portion_g).toBe(150);
  });

  it("defaults portion_g to 100 when omitted", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-egg-001",
    });

    const row = firstRow(expectObservationResult(result));
    expect(row.portion_g).toBe(100);
  });

  it("observation carries schema-declared columns with unit metadata", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-broccoli-001",
    });

    const { columns } = expectObservationResult(result);
    expect(columns.length).toBeGreaterThan(0);

    expectColumn(columns, "kcal", { type: "number", unit: "kcal" });
    expectColumn(columns, "protein_g", { type: "number", unit: "g" });
  });

  it("includes allergen_tags from the catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-salmon-001",
    });

    const row = firstRow(expectObservationResult(result));
    expect(row.allergen_tags).toBe("fish");
  });

  it("empty allergen_tags for foods with no allergens", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-chicken-breast-001",
    });

    const row = firstRow(expectObservationResult(result));
    expect(row.allergen_tags).toBe("");
  });
});

// ─── handler dispatch: error cases ─────────────────────────────────────────

describe("createQueryCatalogHandler — error cases", () => {
  it("returns typed error for unknown template id", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "nonexistent_template",
    });

    const err = expectErrorResult(result);
    expect(err.message).toBeDefined();
    expect(String(err.message)).toMatch(/template/i);
    expect(err.availableTemplates).toBeDefined();
  });

  it("error result lists available templates for model retry", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "invented_template",
    });

    const err = expectErrorResult(result);
    expect(err.availableTemplates).toContain(FOOD_LOOKUP_ID);
  });

  it("returns typed error when template_id is missing", async () => {
    const handler = makeHandler();
    const result = await handler({});

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/template_id/i);
  });

  it("returns typed error when template_id is empty string", async () => {
    const handler = makeHandler();
    const result = await handler({ template_id: "" });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/template_id/i);
  });

  it("returns typed error for missing required template param (food_id)", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|food_id/i);
  });

  it("returns typed error for invalid param type", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-salmon-001",
      portion_g: -5,
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|portion_g/i);
  });

  it("returns typed error when food_id not found in catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-nonexistent-999",
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/not found/i);
  });
});

// ─── user identity binding ─────────────────────────────────────────────────

describe("createQueryCatalogHandler — user identity binding", () => {
  it("userId bound by caller is the only identity that reaches the runner", async () => {
    const scopedUserRunner = createScopedUserRunner();

    const handler = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: scopedUserRunner.runner,
      userId: "authenticated-user-001",
    });

    const result = await handler({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-chicken-breast-001",
    });

    const row = firstRow(expectObservationResult(result));
    expect(row.scoped_user).toBe("authenticated-user-001");
    expect(scopedUserRunner.getCapturedUserId()).toBe("authenticated-user-001");
  });

  it("user identity is scoped per-call and never bleeds across executions", async () => {
    const scopedUserRunner = createScopedUserRunner();

    const handlerA = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: scopedUserRunner.runner,
      userId: "user-A",
    });
    const handlerB = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: scopedUserRunner.runner,
      userId: "user-B",
    });

    const resultA = await handlerA({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-chicken-breast-001",
    });
    const rowA = firstRow(expectObservationResult(resultA));
    expect(rowA.scoped_user).toBe("user-A");

    const resultB = await handlerB({
      template_id: FOOD_LOOKUP_ID,
      food_id: "food-chicken-breast-001",
    });
    const rowB = firstRow(expectObservationResult(resultB));
    expect(rowB.scoped_user).toBe("user-B");

    expect(rowA.scoped_user).not.toBe(rowB.scoped_user);
  });
});

// ─── in-memory query runner ────────────────────────────────────────────────

describe("createInMemoryQueryRunner", () => {
  const foodCatalog = seedFoodCatalog();

  it("returns observation with correct templateId", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    const obs = await runner(
      FOOD_LOOKUP_ID,
      { food_id: "food-salmon-001" },
      USER_ID,
    );

    expect(obs.templateId).toBe(FOOD_LOOKUP_ID);
    expect(obs.rowCount).toBe(1);
    expect(obs.truncated).toBe(false);
  });

  it("returns all columns from FOOD_LOOKUP_TEMPLATE result schema", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    const obs = await runner(
      FOOD_LOOKUP_ID,
      { food_id: "food-banana-001" },
      USER_ID,
    );

    const colNames = obs.columns.map((c) => c.name);
    expect(colNames).toContain("food_id");
    expect(colNames).toContain("food_name");
    expect(colNames).toContain("portion_g");
    expect(colNames).toContain("kcal");
    expect(colNames).toContain("protein_g");
    expect(colNames).toContain("fat_g");
    expect(colNames).toContain("carbs_g");
    expect(colNames).toContain("allergen_tags");
  });

  it("scales nutrition linearly by portion size", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    const obs100 = await runner(
      FOOD_LOOKUP_ID,
      { food_id: "food-rice-white-001", portion_g: 100 },
      USER_ID,
    );
    const obs200 = await runner(
      FOOD_LOOKUP_ID,
      { food_id: "food-rice-white-001", portion_g: 200 },
      USER_ID,
    );

    const row100 = firstRow(obs100);
    const row200 = firstRow(obs200);
    expect(expectNumber(row200.kcal)).toBe(expectNumber(row100.kcal) * 2);
  });

  it("throws for an unsupported template id", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    await expect(runner("bad_template", {}, USER_ID)).rejects.toThrow(
      /unknown template/i,
    );
  });

  it("throws when food_id is not in the catalog", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    await expect(
      runner(FOOD_LOOKUP_ID, { food_id: "food-missing" }, USER_ID),
    ).rejects.toThrow(/not found/i);
  });

  it("can look up every food in the seed catalog and return correct per-100g values", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);

    for (const food of foodCatalog.allFoods) {
      const obs = await runner(FOOD_LOOKUP_ID, { food_id: food.id }, USER_ID);
      const row = firstRow(obs);

      expect(row.food_id).toBe(food.id);
      expect(row.food_name).toBe(food.canonicalName);
      expect(row.kcal).toBe(food.per100g.kcal);
      expect(row.protein_g).toBe(food.per100g.proteinG);
      expect(row.fat_g).toBe(food.per100g.fatG);
      expect(row.carbs_g).toBe(food.per100g.carbsG);
    }
  });
});

// ─── handler dispatch: meal-based templates ───────────────────────────────

function makeMeal(overrides: Partial<MealRecord> = {}): MealRecord {
  return {
    userId: USER_ID,
    foodName: "chicken breast",
    portionG: 200,
    mealType: "lunch",
    loggedAt: "2026-07-06T12:00:00Z",
    kcal: 330,
    proteinG: 62,
    fatG: 7.2,
    carbsG: 0,
    ...overrides,
  };
}

function makeWeekMeals(): MealRecord[] {
  return [
    makeMeal({ foodName: "oatmeal", mealType: "breakfast", loggedAt: "2026-07-06T08:00:00Z", kcal: 170, proteinG: 6, fatG: 3.6, carbsG: 29, portionG: 240 }),
    makeMeal({ loggedAt: "2026-07-06T12:00:00Z", kcal: 330, proteinG: 62, fatG: 7.2, carbsG: 0 }),
    makeMeal({ foodName: "salmon", mealType: "dinner", loggedAt: "2026-07-06T19:00:00Z", kcal: 354, proteinG: 34, fatG: 22.1, carbsG: 0, portionG: 170 }),
    makeMeal({ foodName: "egg", mealType: "breakfast", loggedAt: "2026-07-07T08:00:00Z", kcal: 310, proteinG: 26, fatG: 22, carbsG: 2.2, portionG: 200 }),
  ];
}

function makeSevenTemplateHandler(meals?: MealRecord[]) {
  const foodCatalog = seedFoodCatalog();
  const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
  const runner = createInMemoryQueryRunner(foodCatalog, meals ?? []);
  return createQueryCatalogHandler({
    queryCatalog,
    runner,
    userId: USER_ID,
  });
}

describe("createQueryCatalogHandler — meal_summary", () => {
  it("returns observation for valid meal_summary call", async () => {
    const handler = makeSevenTemplateHandler(makeWeekMeals());
    const result = await handler({
      template_id: "meal_summary",
      date_from: "2026-07-01",
      date_to: "2026-07-10",
    });

    const observation = expectObservationResult(result);
    expect(observation.templateId).toBe("meal_summary");
    expect(observation.rowCount).toBeGreaterThan(0);
    expect(observation.truncated).toBe(false);
  });

  it("scopes to userId (cross-tenant isolation)", async () => {
    const mixedMeals = [
      { ...makeMeal(), userId: "user-A", foodName: "chicken", kcal: 300 },
      { ...makeMeal(), userId: "user-B", foodName: "salmon", kcal: 400 },
    ];
    // Handler is bound to user-A
    const handler = createQueryCatalogHandler({
      queryCatalog: createQueryCatalog(ALL_QUERY_TEMPLATES),
      runner: createInMemoryQueryRunner(seedFoodCatalog(), mixedMeals),
      userId: "user-A",
    });

    const result = await handler({
      template_id: "meal_summary",
      date_from: "2026-07-01",
      date_to: "2026-07-10",
    });

    const obs = expectObservationResult(result);
    // Only user-A's meal should appear
    const totalKcal = obs.rows.reduce((s, r) => s + Number(r.total_kcal), 0);
    expect(totalKcal).toBe(300);
  });
});

describe("createQueryCatalogHandler — daily_totals", () => {
  it("returns one row per day with meals", async () => {
    const handler = makeSevenTemplateHandler(makeWeekMeals());
    const result = await handler({
      template_id: "daily_totals",
      date_from: "2026-07-06",
      date_to: "2026-07-07",
    });

    const observation = expectObservationResult(result);
    expect(observation.templateId).toBe("daily_totals");
    expect(observation.rowCount).toBe(2); // 2 days
  });
});

describe("createQueryCatalogHandler — range_comparison", () => {
  it("exposes diff columns for range comparison", async () => {
    const handler = makeSevenTemplateHandler(makeWeekMeals());
    const result = await handler({
      template_id: "range_comparison",
      range1_from: "2026-07-06",
      range1_to: "2026-07-06",
      range2_from: "2026-07-07",
      range2_to: "2026-07-07",
    });

    const observation = expectObservationResult(result);
    expect(observation.templateId).toBe("range_comparison");
    expect(observation.rowCount).toBe(1);

    const row = observation.rows[0];
    // diff columns must exist
    expect(typeof row.diff_kcal).toBe("number");
    expect(typeof row.diff_protein_g).toBe("number");
    expect(typeof row.diff_fat_g).toBe("number");
    expect(typeof row.diff_carbs_g).toBe("number");
  });
});

describe("createQueryCatalogHandler — top_k_by_nutrient", () => {
  it("returns top-k ranked foods by nutrient", async () => {
    const handler = makeSevenTemplateHandler(makeWeekMeals());
    const result = await handler({
      template_id: "top_k_by_nutrient",
      date_from: "2026-07-01",
      date_to: "2026-07-10",
      nutrient: "protein",
      k: 3,
    });

    const observation = expectObservationResult(result);
    expect(observation.templateId).toBe("top_k_by_nutrient");
    expect(observation.rowCount).toBeGreaterThan(0);
    expect(observation.rowCount).toBeLessThanOrEqual(3);
    expect(observation.rows[0].rank).toBe(1);
  });
});

describe("createQueryCatalogHandler — error cases for new templates", () => {
  it("rejects meal_summary with missing date params", async () => {
    const handler = makeSevenTemplateHandler();
    const result = await handler({
      template_id: "meal_summary",
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|date_from/i);
  });

  it("rejects range_comparison with missing range params", async () => {
    const handler = makeSevenTemplateHandler();
    const result = await handler({
      template_id: "range_comparison",
      range1_from: "2026-07-01",
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|range1_to/i);
  });

  it("rejects top_k_by_nutrient with invalid nutrient enum", async () => {
    const handler = makeSevenTemplateHandler();
    const result = await handler({
      template_id: "top_k_by_nutrient",
      date_from: "2026-07-01",
      date_to: "2026-07-07",
      nutrient: "fiber",
      k: 3,
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|nutrient/i);
  });

  it("error result lists all seven available templates", async () => {
    const handler = makeSevenTemplateHandler();
    const result = await handler({
      template_id: "invented_template",
    });

    const err = expectErrorResult(result);
    expect(err.availableTemplates).toHaveLength(7);
    expect(err.availableTemplates).toContain("food_lookup");
    expect(err.availableTemplates).toContain("meal_summary");
    expect(err.availableTemplates).toContain("range_comparison");
    expect(err.availableTemplates).toContain("top_k_by_nutrient");
  });
});
