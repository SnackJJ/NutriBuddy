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
  type QueryCatalog,
  type QueryRunner,
  type Observation,
  type ColumnDef,
} from "../src/catalog/queryCatalog";
import {
  createCatalog,
  SEED_FOODS,
  type Catalog,
} from "../src/catalog/catalog";

// ─── helpers ───────────────────────────────────────────────────────────────

function seedFoodCatalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

function seedQueryCatalog(): QueryCatalog {
  return createQueryCatalog([FOOD_LOOKUP_TEMPLATE]);
}

function makeHandler(
  overrides: Partial<QueryCatalogHandlerDeps> = {},
) {
  const foodCatalog = seedFoodCatalog();
  const queryCatalog = seedQueryCatalog();
  const runner = createInMemoryQueryRunner(foodCatalog);
  return createQueryCatalogHandler({
    queryCatalog,
    runner,
    userId: "user-001",
    ...overrides,
  });
}

function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

function expectObservationResult(result: string): Record<string, unknown> {
  const parsed = parseResult(result);
  expect(parsed.type).toBe("observation");
  return parsed;
}

function expectErrorResult(result: string): Record<string, unknown> {
  const parsed = parseResult(result);
  expect(parsed.type).toBe("error");
  return parsed;
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

    const properties = params.properties as Record<string, unknown>;
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
      template_id: "food_lookup",
      food_id: "food-salmon-001",
    });

    const obs = expectObservationResult(result);
    expect(obs.observation).toBeDefined();
    const observation = obs.observation as Record<string, unknown>;
    expect(observation.templateId).toBe("food_lookup");
    expect(observation.rowCount).toBe(1);
  });

  it("returns correct nutrition data from the catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-chicken-breast-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];
    expect(rows[0].kcal).toBe(165);
    expect(rows[0].protein_g).toBe(31);
    expect(rows[0].fat_g).toBe(3.6);
    expect(rows[0].carbs_g).toBe(0);
    expect(rows[0].food_name).toBe("chicken breast");
  });

  it("scales nutrition by portion_g", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-salmon-001",
      portion_g: 150,
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];

    // Salmon: 208 kcal / 100g → 312 kcal / 150g
    expect(rows[0].kcal).toBe(312);
    expect(rows[0].protein_g).toBe(30);
    expect(rows[0].portion_g).toBe(150);
  });

  it("defaults portion_g to 100 when omitted", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-egg-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];
    expect(rows[0].portion_g).toBe(100);
  });

  it("observation carries schema-declared columns with unit metadata", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-broccoli-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const columns = observation.columns as ColumnDef[];
    expect(columns.length).toBeGreaterThan(0);

    const kcalCol = columns.find((c: ColumnDef) => c.name === "kcal");
    expect(kcalCol).toBeDefined();
    expect(kcalCol!.type).toBe("number");
    expect(kcalCol!.unit).toBe("kcal");

    const proteinCol = columns.find((c: ColumnDef) => c.name === "protein_g");
    expect(proteinCol).toBeDefined();
    expect(proteinCol!.type).toBe("number");
    expect(proteinCol!.unit).toBe("g");
  });

  it("includes allergen_tags from the catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-salmon-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];
    expect(rows[0].allergen_tags).toBe("fish");
  });

  it("empty allergen_tags for foods with no allergens", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-chicken-breast-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];
    expect(rows[0].allergen_tags).toBe("");
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
    const available = err.availableTemplates as string[];
    expect(available).toContain("food_lookup");
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
      template_id: "food_lookup",
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|food_id/i);
  });

  it("returns typed error for invalid param type", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-salmon-001",
      portion_g: -5,
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/validation|portion_g/i);
  });

  it("returns typed error when food_id not found in catalog", async () => {
    const handler = makeHandler();
    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-nonexistent-999",
    });

    const err = expectErrorResult(result);
    expect(String(err.message)).toMatch(/not found/i);
  });
});

// ─── user identity binding ─────────────────────────────────────────────────

describe("createQueryCatalogHandler — user identity binding", () => {
  it("userId bound by caller is the only identity that reaches the runner", async () => {
    let capturedUserId: string | undefined;
    const captureRunner: QueryRunner = async (
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
    };

    const handler = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: captureRunner,
      userId: "authenticated-user-001",
    });

    const result = await handler({
      template_id: "food_lookup",
      food_id: "food-chicken-breast-001",
    });

    const obs = expectObservationResult(result);
    const observation = obs.observation as Record<string, unknown>;
    const rows = observation.rows as Record<string, unknown>[];
    expect(rows[0].scoped_user).toBe("authenticated-user-001");
    expect(capturedUserId).toBe("authenticated-user-001");
  });

  it("user identity is scoped per-call and never bleeds across executions", async () => {
    let capturedUserId: string | undefined;
    const captureRunner: QueryRunner = async (
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
    };

    const handlerA = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: captureRunner,
      userId: "user-A",
    });
    const handlerB = createQueryCatalogHandler({
      queryCatalog: seedQueryCatalog(),
      runner: captureRunner,
      userId: "user-B",
    });

    const resultA = await handlerA({
      template_id: "food_lookup",
      food_id: "food-chicken-breast-001",
    });
    const obsA = expectObservationResult(resultA);
    const rowsA = (obsA.observation as Record<string, unknown>)
      .rows as Record<string, unknown>[];
    expect(rowsA[0].scoped_user).toBe("user-A");

    const resultB = await handlerB({
      template_id: "food_lookup",
      food_id: "food-chicken-breast-001",
    });
    const obsB = expectObservationResult(resultB);
    const rowsB = (obsB.observation as Record<string, unknown>)
      .rows as Record<string, unknown>[];
    expect(rowsB[0].scoped_user).toBe("user-B");

    expect(rowsA[0].scoped_user).not.toBe(rowsB[0].scoped_user);
  });
});

// ─── in-memory query runner ────────────────────────────────────────────────

describe("createInMemoryQueryRunner", () => {
  const foodCatalog = seedFoodCatalog();

  it("returns observation with correct templateId", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    const obs = await runner(
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
    );

    expect(obs.templateId).toBe("food_lookup");
    expect(obs.rowCount).toBe(1);
    expect(obs.truncated).toBe(false);
  });

  it("returns all columns from FOOD_LOOKUP_TEMPLATE result schema", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    const obs = await runner(
      "food_lookup",
      { food_id: "food-banana-001" },
      "user-001",
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
      "food_lookup",
      { food_id: "food-rice-white-001", portion_g: 100 },
      "user-001",
    );
    const obs200 = await runner(
      "food_lookup",
      { food_id: "food-rice-white-001", portion_g: 200 },
      "user-001",
    );

    const row100 = obs100.rows[0] as Record<string, unknown>;
    const row200 = obs200.rows[0] as Record<string, unknown>;
    expect(row200.kcal).toBe((row100.kcal as number) * 2);
  });

  it("throws for an unsupported template id", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    await expect(
      runner("bad_template", {}, "user-001"),
    ).rejects.toThrow(/unknown template/i);
  });

  it("throws when food_id is not in the catalog", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);
    await expect(
      runner("food_lookup", { food_id: "food-missing" }, "user-001"),
    ).rejects.toThrow(/not found/i);
  });

  it("can look up every food in the seed catalog and return correct per-100g values", async () => {
    const runner = createInMemoryQueryRunner(foodCatalog);

    for (const food of foodCatalog.allFoods) {
      const obs = await runner(
        "food_lookup",
        { food_id: food.id },
        "user-001",
      );
      const row = obs.rows[0] as Record<string, unknown>;

      expect(row.food_id).toBe(food.id);
      expect(row.food_name).toBe(food.canonicalName);
      expect(row.kcal).toBe(food.per100g.kcal);
      expect(row.protein_g).toBe(food.per100g.proteinG);
      expect(row.fat_g).toBe(food.per100g.fatG);
      expect(row.carbs_g).toBe(food.per100g.carbsG);
    }
  });
});
