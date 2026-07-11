import { describe, it, expect } from "vitest";
import {
  createQueryCatalog,
  validateParams,
  executeQuery,
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
  ALL_QUERY_TEMPLATES,
  type QueryCatalog,
  type QueryTemplate,
  type Observation,
  type ParamDef,
  type ColumnDef,
  type QueryResult,
  type MealRecord,
} from "../src/catalog/queryCatalog";
import { buildTemplatePromptSection } from "../src/harness/contextAssembler";
import {
  createCatalog,
  SEED_FOODS,
  type Catalog,
} from "../src/catalog/catalog";
import { resolveFood } from "../src/catalog/resolver";
import { createInMemoryQueryRunner } from "../src/harness/queryCatalog";

// ─── helpers ───────────────────────────────────────────────────────────────

function seedCatalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

function seedQueryCatalog(): QueryCatalog {
  return createQueryCatalog([FOOD_LOOKUP_TEMPLATE]);
}

const CHICKEN_BREAST_ID = "food-chicken-breast-001";

type QueryError = Extract<QueryResult, { readonly type: "error" }>;

function expectObservation(result: QueryResult): Observation {
  if (result.type === "observation") {
    return result.observation;
  }

  throw new Error(
    `Expected observation but got ${result.type}: ${JSON.stringify(result)}`,
  );
}

function expectError(result: QueryResult): QueryError {
  if (result.type === "error") {
    return result;
  }

  throw new Error(
    `Expected error but got ${result.type}: ${JSON.stringify(result)}`,
  );
}

/**
 * Stub query runner: looks up food in the local catalog and returns observation rows.
 * M1 executes against in-memory catalog; future templates will run real SQL against Supabase.
 */
function createStubRunner(catalog: Catalog) {
  return async (
    templateId: string,
    params: Record<string, unknown>,
    _userId: string,
  ): Promise<Observation> => {
    if (templateId !== "food_lookup") {
      throw new Error(`Unknown template: ${templateId}`);
    }

    const foodId = String(params.food_id);
    const portionG =
      typeof params.portion_g === "number" ? params.portion_g : 100;
    const food = catalog.allFoods.find((f) => f.id === foodId);

    if (!food) {
      throw new Error(`Food not found: ${foodId}`);
    }

    const scale = portionG / 100;
    const round = (per100gValue: number) =>
      Math.round(per100gValue * scale * 10) / 10;

    return {
      templateId,
      columns: FOOD_LOOKUP_TEMPLATE.resultSchema,
      rows: [
        {
          food_id: food.id,
          food_name: food.canonicalName,
          portion_g: portionG,
          kcal: round(food.per100g.kcal),
          protein_g: round(food.per100g.proteinG),
          fat_g: round(food.per100g.fatG),
          carbs_g: round(food.per100g.carbsG),
          allergen_tags: (food.allergenTags ?? []).join(", "),
        },
      ],
      rowCount: 1,
      truncated: false,
    };
  };
}

function expectColumn(
  schema: readonly ColumnDef[],
  name: string,
  expected: Pick<ColumnDef, "type" | "unit">,
): void {
  const column = schema.find((c) => c.name === name);
  expect(column).toBeDefined();
  expect(column!.type).toBe(expected.type);
  expect(column!.unit).toBe(expected.unit);
}

// ─── template definitions ──────────────────────────────────────────────────

describe("QueryTemplate definitions", () => {
  it("food_lookup has a unique template id", () => {
    expect(FOOD_LOOKUP_TEMPLATE.id).toBe("food_lookup");
  });

  it("food_lookup has a non-empty description", () => {
    expect(FOOD_LOOKUP_TEMPLATE.description.length).toBeGreaterThan(0);
  });

  it("food_lookup declares typed parameters", () => {
    expect(FOOD_LOOKUP_TEMPLATE.parameters.length).toBeGreaterThan(0);

    const foodIdParam = FOOD_LOOKUP_TEMPLATE.parameters.find(
      (p: ParamDef) => p.name === "food_id",
    );
    expect(foodIdParam).toBeDefined();
    expect(foodIdParam!.type).toBe("string");
    expect(foodIdParam!.required).toBe(true);
  });

  it("food_lookup declares a result schema with unit-bearing numeric columns", () => {
    const schema = FOOD_LOOKUP_TEMPLATE.resultSchema;

    expectColumn(schema, "portion_g", { type: "number", unit: "g" });
    expectColumn(schema, "kcal", { type: "number", unit: "kcal" });
    expectColumn(schema, "protein_g", { type: "number", unit: "g" });
    expectColumn(schema, "fat_g", { type: "number", unit: "g" });
    expectColumn(schema, "carbs_g", { type: "number", unit: "g" });
  });

  it("every column in the result schema has a description", () => {
    for (const col of FOOD_LOOKUP_TEMPLATE.resultSchema) {
      expect(col.description.length).toBeGreaterThan(0);
    }
  });

  it("every parameter in food_lookup has a description", () => {
    for (const param of FOOD_LOOKUP_TEMPLATE.parameters) {
      expect(param.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── query catalog construction ────────────────────────────────────────────

describe("createQueryCatalog", () => {
  it("creates a catalog from template list", () => {
    const catalog = seedQueryCatalog();

    expect(catalog.templates.size).toBe(1);
    expect(catalog.templates.has("food_lookup")).toBe(true);
  });

  it("catalog exposes template list for prompt injection", () => {
    const catalog = seedQueryCatalog();

    expect(catalog.templateList).toHaveLength(1);
    expect(catalog.templateList[0].id).toBe("food_lookup");
  });

  it("creates empty catalog for empty template list", () => {
    const catalog = createQueryCatalog([]);

    expect(catalog.templates.size).toBe(0);
    expect(catalog.templateList).toHaveLength(0);
  });

  it("rejects duplicate template ids", () => {
    expect(() =>
      createQueryCatalog([FOOD_LOOKUP_TEMPLATE, FOOD_LOOKUP_TEMPLATE]),
    ).toThrow(/duplicate/i);
  });
});

// ─── parameter validation ──────────────────────────────────────────────────

describe("validateParams", () => {
  const catalog = seedQueryCatalog();
  const template = catalog.templates.get("food_lookup")!;

  it("passes validation for valid params", () => {
    const errors = validateParams(template, { food_id: CHICKEN_BREAST_ID });
    expect(errors).toHaveLength(0);
  });

  it("passes validation with optional portion_g", () => {
    const errors = validateParams(template, {
      food_id: CHICKEN_BREAST_ID,
      portion_g: 200,
    });
    expect(errors).toHaveLength(0);
  });

  it("fails when required param is missing", () => {
    const errors = validateParams(template, {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("food_id");
    expect(errors[0].message).toMatch(/required/i);
  });

  it("fails when required param is null", () => {
    const errors = validateParams(template, { food_id: null });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("food_id");
  });

  it("fails when string param is wrong type", () => {
    const errors = validateParams(template, { food_id: 42 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("food_id");
    expect(errors[0].message).toMatch(/string/i);
  });

  it("fails when number param is wrong type", () => {
    const errors = validateParams(template, {
      food_id: CHICKEN_BREAST_ID,
      portion_g: "not-a-number",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("portion_g");
    expect(errors[0].message).toMatch(/number/i);
  });

  it("fails when portion_g is not positive", () => {
    const errors = validateParams(template, {
      food_id: CHICKEN_BREAST_ID,
      portion_g: -100,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("portion_g");
  });

  it("fails when extra unknown params are provided", () => {
    const errors = validateParams(template, {
      food_id: CHICKEN_BREAST_ID,
      made_up_param: "value",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/unknown/i);
  });

  it("fails with multiple errors for multiple invalid params", () => {
    const errors = validateParams(template, {
      portion_g: "bad",
      made_up_param: 123,
    });
    // Missing food_id + wrong type portion_g + unknown param
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("empty string food_id is treated as missing", () => {
    const errors = validateParams(template, { food_id: "" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("food_id");
  });
});

// ─── enum parameter validation ─────────────────────────────────────────────

describe("validateParams — enum parameters", () => {
  it("validates enum values against the declared allowed set", () => {
    const template: QueryTemplate = {
      id: "test_enum",
      description: "Test template with enum param",
      parameters: [
        {
          name: "nutrient",
          type: "enum",
          required: true,
          description: "Nutrient to query",
          enumValues: ["kcal", "protein_g", "fat_g"],
        },
      ],
      resultSchema: [],
    };

    expect(validateParams(template, { nutrient: "kcal" })).toHaveLength(0);

    const errors = validateParams(template, { nutrient: "vitamin_d" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("nutrient");
    expect(errors[0].message).toMatch(/enum/i);
  });

  it("enum param without enumValues definition rejects all values", () => {
    const template: QueryTemplate = {
      id: "test_bad_enum",
      description: "Enum with no values defined",
      parameters: [
        {
          name: "color",
          type: "enum" as const,
          required: true,
          description: "A color",
        },
      ],
      resultSchema: [],
    };

    const errors = validateParams(template, { color: "red" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/enum/i);
  });
});

// ─── query execution ───────────────────────────────────────────────────────

describe("executeQuery", () => {
  const foodCatalog = seedCatalog();
  const queryCatalog = seedQueryCatalog();
  const runner = createStubRunner(foodCatalog);

  it("executes food_lookup and returns an observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    expect(obs.templateId).toBe("food_lookup");
    expect(obs.rowCount).toBe(1);
    expect(obs.truncated).toBe(false);
  });

  it("observation carries schema-declared columns", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    expect(obs.columns).toBe(FOOD_LOOKUP_TEMPLATE.resultSchema);
    expect(obs.columns.length).toBeGreaterThan(0);
  });

  it("observation rows contain unit-bearing numeric values", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0];

    expect(typeof row.kcal).toBe("number");
    expect(typeof row.protein_g).toBe("number");
    expect(typeof row.fat_g).toBe("number");
    expect(typeof row.carbs_g).toBe("number");

    expect(typeof row.food_id).toBe("string");
    expect(typeof row.food_name).toBe("string");
  });

  it("food_lookup returns correct nutrition data from the catalog", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0];

    expect(row.kcal).toBe(165);
    expect(row.protein_g).toBe(31);
    expect(row.fat_g).toBe(3.6);
    expect(row.carbs_g).toBe(0);
    expect(row.food_name).toBe("chicken breast");
  });

  it("scales nutrition by portion_g", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID, portion_g: 200 },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0];

    expect(row.kcal).toBe(330);
    expect(row.protein_g).toBe(62);
    expect(row.fat_g).toBe(7.2);
    expect(row.carbs_g).toBe(0);
    expect(row.portion_g).toBe(200);
  });

  it("defaults portion_g to 100 when omitted", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0];

    expect(row.portion_g).toBe(100);
  });

  it("returns typed error for unknown template id", async () => {
    const result = await executeQuery(
      queryCatalog,
      "nonexistent_template",
      {},
      "user-001",
      runner,
    );

    const err = expectError(result);
    expect(err.message).toMatch(/template/i);
    expect(err.availableTemplates).toContain("food_lookup");
  });

  it("error result lists all available template ids for model retry", async () => {
    const catalog = createQueryCatalog([
      FOOD_LOOKUP_TEMPLATE,
      {
        id: "meal_summary",
        description: "Summary of meals in a date range",
        parameters: [],
        resultSchema: [],
      } satisfies QueryTemplate,
    ]);
    const result = await executeQuery(
      catalog,
      "bad_template",
      {},
      "user-001",
      runner,
    );

    const err = expectError(result);
    expect(err.availableTemplates).toContain("food_lookup");
    expect(err.availableTemplates).toContain("meal_summary");
    expect(err.availableTemplates.length).toBe(2);
  });

  it("returns typed error for invalid params", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { portion_g: -5 },
      "user-001",
      runner,
    );

    const err = expectError(result);
    expect(err.message).toMatch(/validation/i);
  });

  it("model cannot inject user_id as a parameter — it is rejected by validation", async () => {
    const rejectRunner = async (): Promise<Observation> => {
      throw new Error("Runner should not be called for invalid params");
    };

    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      {
        food_id: CHICKEN_BREAST_ID,
        user_id: "evil-user",
      },
      "authenticated-user-001",
      rejectRunner,
    );

    const err = expectError(result);
    expect(err.message).toMatch(/user_id/);
    expect(err.message).toMatch(/unknown/i);
  });

  it("userId bound by caller is the only identity that reaches the runner", async () => {
    let capturedUserId: string | undefined;
    const captureRunner = async (
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
            type: "string" as const,
            description: "User scoping",
          },
        ],
        rows: [{ scoped_user: userId }],
        rowCount: 1,
        truncated: false,
      };
    };

    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "authenticated-user-001",
      captureRunner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0] as Record<string, unknown>;
    expect(row.scoped_user).toBe("authenticated-user-001");
    expect(capturedUserId).toBe("authenticated-user-001");
  });

  it("user identity is scoped per-call and never bleeds across executions", async () => {
    const captureRunner = async (
      templateId: string,
      _params: Record<string, unknown>,
      userId: string,
    ): Promise<Observation> => {
      return {
        templateId,
        columns: [
          {
            name: "scoped_user",
            type: "string" as const,
            description: "User scoping test",
          },
        ],
        rows: [{ scoped_user: userId }],
        rowCount: 1,
        truncated: false,
      };
    };

    const resultA = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-A",
      captureRunner,
    );
    const resultB = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: CHICKEN_BREAST_ID },
      "user-B",
      captureRunner,
    );

    const obsA = expectObservation(resultA);
    const obsB = expectObservation(resultB);

    const rowA = obsA.rows[0] as Record<string, unknown>;
    const rowB = obsB.rows[0] as Record<string, unknown>;

    expect(rowA.scoped_user).toBe("user-A");
    expect(rowB.scoped_user).toBe("user-B");
    expect(rowA.scoped_user).not.toBe(rowB.scoped_user);
  });
});

// ─── observation → numeric tracing ─────────────────────────────────────────

describe("observation → numeric tracing", () => {
  const foodCatalog = seedCatalog();
  const queryCatalog = seedQueryCatalog();
  const runner = createStubRunner(foodCatalog);

  it("every numeric fact in an observation maps to a column with a declared unit", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0] as Record<string, unknown>;

    const numericColumnNames = obs.columns
      .filter((c: ColumnDef) => c.type === "number" && c.unit !== undefined)
      .map((c: ColumnDef) => c.name);

    for (const colName of numericColumnNames) {
      expect(typeof row[colName]).toBe("number");
      expect(row[colName]).toBeGreaterThanOrEqual(0);
    }
  });

  it("nutrition numbers come from observations, not model arithmetic", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0] as Record<string, unknown>;

    const modelClaim = { nutrient: "protein_g", value: 20, unit: "g" };

    const columnDef = obs.columns.find(
      (c: ColumnDef) => c.name === modelClaim.nutrient,
    );
    expect(columnDef).toBeDefined();
    expect(columnDef!.unit).toBe(modelClaim.unit);

    const observedValue = row[modelClaim.nutrient];
    expect(observedValue).toBe(modelClaim.value);
  });

  it("numeric provenance is traceable: observation → catalog entry → USDA data", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);
    const row = obs.rows[0] as Record<string, unknown>;

    const observedFoodId = row.food_id;
    expect(observedFoodId).toBe("food-salmon-001");

    const resolved = resolveFood(foodCatalog, "salmon");
    expect(resolved.foodRef).not.toBeNull();
    expect(resolved.foodRef!.foodId).toBe(observedFoodId);

    const { per100g } = resolved.foodRef!;
    expect(row.kcal).toBe(per100g.kcal);
    expect(row.protein_g).toBe(per100g.proteinG);
    expect(row.fat_g).toBe(per100g.fatG);
    expect(row.carbs_g).toBe(per100g.carbsG);

    const kcalCol = obs.columns.find((c: ColumnDef) => c.name === "kcal");
    expect(kcalCol!.unit).toBe("kcal");
    const proteinCol = obs.columns.find(
      (c: ColumnDef) => c.name === "protein_g",
    );
    expect(proteinCol!.unit).toBe("g");
  });

  it("can trace nutrition for any food in the seed catalog", async () => {
    for (const food of foodCatalog.allFoods) {
      const result = await executeQuery(
        queryCatalog,
        "food_lookup",
        { food_id: food.id },
        "user-001",
        runner,
      );

      const obs = expectObservation(result);
      const row = obs.rows[0] as Record<string, unknown>;

      expect(row.food_id).toBe(food.id);
      expect(row.food_name).toBe(food.canonicalName);
      expect(row.kcal).toBe(food.per100g.kcal);
      expect(row.protein_g).toBe(food.per100g.proteinG);
      expect(row.fat_g).toBe(food.per100g.fatG);
      expect(row.carbs_g).toBe(food.per100g.carbsG);

      const tags = food.allergenTags ?? [];
      if (tags.length > 0) {
        expect(row.allergen_tags).toBe(tags.join(", "));
      } else {
        expect(row.allergen_tags).toBe("");
      }
    }
  });

  it("a full read turn: model selects template + params → observation → answer's facts trace to observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: "food-egg-001" },
      "user-001",
      runner,
    );

    const obs = expectObservation(result);

    const modelClaims = [
      { column: "protein_g", value: 13, unit: "g" },
      { column: "fat_g", value: 11, unit: "g" },
      { column: "kcal", value: 155, unit: "kcal" },
    ];

    const row = obs.rows[0] as Record<string, unknown>;
    for (const claim of modelClaims) {
      const colDef = obs.columns.find(
        (c: ColumnDef) => c.name === claim.column,
      );
      expect(colDef).toBeDefined();
      expect(colDef!.unit).toBe(claim.unit);

      const observedValue = row[claim.column];
      expect(observedValue).toBe(claim.value);
    }
  });
});

// ─── template signature exposure ───────────────────────────────────────────

describe("template signature exposure for prompt injection", () => {
  it("each template exposes id, description, parameters, and result schema", () => {
    const catalog = seedQueryCatalog();

    for (const template of catalog.templateList) {
      expect(template.id.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.parameters.length).toBeGreaterThan(0);
      expect(template.resultSchema.length).toBeGreaterThan(0);
    }
  });

  it("template parameters include type info for model consumption", () => {
    const foodIdParam = FOOD_LOOKUP_TEMPLATE.parameters.find(
      (p: ParamDef) => p.name === "food_id",
    );
    expect(foodIdParam).toBeDefined();
    expect(foodIdParam!.type).toBe("string");
    expect(foodIdParam!.required).toBe(true);
    expect(foodIdParam!.description).toBeDefined();

    const portionParam = FOOD_LOOKUP_TEMPLATE.parameters.find(
      (p: ParamDef) => p.name === "portion_g",
    );
    expect(portionParam).toBeDefined();
    expect(portionParam!.type).toBe("number");
    expect(portionParam!.required).toBe(false);
  });

  it("template result schema includes unit info for numeric gate consumption", () => {
    for (const col of FOOD_LOOKUP_TEMPLATE.resultSchema) {
      if (col.type === "number") {
        expect(col.unit).toBeDefined();
        expect(col.unit!.length).toBeGreaterThan(0);
      }
    }
  });

  it("query catalog generates a prompt-parseable template catalog string", () => {
    const catalog = seedQueryCatalog();
    const promptSection = buildTemplatePromptSection(catalog)!;

    expect(promptSection).toContain("food_lookup");
    expect(promptSection).toContain("food_id");
    expect(promptSection).toContain("string (required)");
    expect(promptSection).toContain("portion_g");
    expect(promptSection).toContain("number (optional)");
    expect(promptSection).toContain("kcal");
    expect(promptSection).toContain("protein_g");
  });
});

// ─── template definitions: templates 2–7 ───────────────────────────────────

function assertTemplateShape(
  template: QueryTemplate,
  expectedId: string,
): void {
  expect(template.id).toBe(expectedId);
  expect(template.description.length).toBeGreaterThan(0);
  expect(template.parameters.length).toBeGreaterThan(0);
  expect(template.resultSchema.length).toBeGreaterThan(0);

  for (const p of template.parameters) {
    expect(p.name.length).toBeGreaterThan(0);
    expect(p.description.length).toBeGreaterThan(0);
    expect(["string", "number", "enum", "date"]).toContain(p.type);
  }

  for (const c of template.resultSchema) {
    expect(c.name.length).toBeGreaterThan(0);
    expect(c.description.length).toBeGreaterThan(0);
    expect(["string", "number", "date", "boolean"]).toContain(c.type);
  }
}

const ALL_SEVEN = [
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
];

describe("QueryTemplate definitions — seven reviewed templates", () => {
  it("ALL_QUERY_TEMPLATES contains exactly seven templates", () => {
    expect(ALL_QUERY_TEMPLATES).toHaveLength(7);
  });

  it("every template has a unique id", () => {
    const ids = ALL_SEVEN.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template passes structural validation", () => {
    for (const t of ALL_SEVEN) {
      assertTemplateShape(t, t.id);
    }
  });

  it("meal_summary has date range params and per-meal-type result schema", () => {
    assertTemplateShape(MEAL_SUMMARY_TEMPLATE, "meal_summary");

    const dateParams = MEAL_SUMMARY_TEMPLATE.parameters.filter(
      (p) => p.type === "date",
    );
    expect(dateParams).toHaveLength(2);
    expect(dateParams.every((p) => p.required)).toBe(true);

    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "meal_type", {
      type: "string",
    });
    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "meal_count", {
      type: "number",
    });
    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "total_kcal", {
      type: "number",
      unit: "kcal",
    });
    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "total_protein_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "total_fat_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(MEAL_SUMMARY_TEMPLATE.resultSchema, "total_carbs_g", {
      type: "number",
      unit: "g",
    });
  });

  it("daily_totals has date params and per-day result schema", () => {
    assertTemplateShape(DAILY_TOTALS_TEMPLATE, "daily_totals");

    const dateParams = DAILY_TOTALS_TEMPLATE.parameters.filter(
      (p) => p.type === "date",
    );
    expect(dateParams).toHaveLength(2);
    expect(dateParams.every((p) => p.required)).toBe(true);

    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "date", { type: "date" });
    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "total_kcal", {
      type: "number",
      unit: "kcal",
    });
    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "total_protein_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "total_fat_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "total_carbs_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(DAILY_TOTALS_TEMPLATE.resultSchema, "meal_count", {
      type: "number",
    });
  });

  it("weekly_totals has week_start date column and day_count", () => {
    assertTemplateShape(WEEKLY_TOTALS_TEMPLATE, "weekly_totals");

    expectColumn(WEEKLY_TOTALS_TEMPLATE.resultSchema, "week_start", {
      type: "date",
    });
    expectColumn(WEEKLY_TOTALS_TEMPLATE.resultSchema, "day_count", {
      type: "number",
    });
    expectColumn(WEEKLY_TOTALS_TEMPLATE.resultSchema, "total_kcal", {
      type: "number",
      unit: "kcal",
    });
  });

  it("daily_average exposes averages with total_days denominator", () => {
    assertTemplateShape(DAILY_AVERAGE_TEMPLATE, "daily_average");

    expectColumn(DAILY_AVERAGE_TEMPLATE.resultSchema, "avg_kcal", {
      type: "number",
      unit: "kcal",
    });
    expectColumn(DAILY_AVERAGE_TEMPLATE.resultSchema, "avg_protein_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(DAILY_AVERAGE_TEMPLATE.resultSchema, "days_with_meals", {
      type: "number",
    });
    expectColumn(DAILY_AVERAGE_TEMPLATE.resultSchema, "total_days", {
      type: "number",
    });
  });

  it("range_comparison exposes diff columns for model-free comparison", () => {
    assertTemplateShape(RANGE_COMPARISON_TEMPLATE, "range_comparison");

    // Four date params
    const dateParams = RANGE_COMPARISON_TEMPLATE.parameters.filter(
      (p) => p.type === "date",
    );
    expect(dateParams).toHaveLength(4);

    // Difference columns must exist — the no-arithmetic contract depends on them
    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "diff_kcal", {
      type: "number",
      unit: "kcal",
    });
    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "diff_protein_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "diff_fat_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "diff_carbs_g", {
      type: "number",
      unit: "g",
    });

    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "range1_days", {
      type: "number",
    });
    expectColumn(RANGE_COMPARISON_TEMPLATE.resultSchema, "range2_days", {
      type: "number",
    });
  });

  it("top_k_by_nutrient has enum param for nutrient and number param for k", () => {
    assertTemplateShape(TOP_K_BY_NUTRIENT_TEMPLATE, "top_k_by_nutrient");

    const nutrientParam = TOP_K_BY_NUTRIENT_TEMPLATE.parameters.find(
      (p) => p.name === "nutrient",
    );
    expect(nutrientParam).toBeDefined();
    expect(nutrientParam!.type).toBe("enum");
    expect(nutrientParam!.enumValues).toEqual([
      "kcal",
      "protein",
      "fat",
      "carbs",
    ]);

    const kParam = TOP_K_BY_NUTRIENT_TEMPLATE.parameters.find(
      (p) => p.name === "k",
    );
    expect(kParam).toBeDefined();
    expect(kParam!.type).toBe("number");
    expect(kParam!.required).toBe(true);

    expectColumn(TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema, "rank", {
      type: "number",
    });
    expectColumn(TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema, "food_name", {
      type: "string",
    });
    expectColumn(TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema, "total_portion_g", {
      type: "number",
      unit: "g",
    });
    expectColumn(TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema, "meal_count", {
      type: "number",
    });
  });
});

// ─── query catalog: seven-template construction ───────────────────────────

describe("createQueryCatalog — seven templates", () => {
  it("creates a catalog from all seven templates", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

    expect(catalog.templates.size).toBe(7);
    expect(catalog.templateList).toHaveLength(7);
  });

  it("every template is reachable by id", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

    for (const t of ALL_QUERY_TEMPLATES) {
      expect(catalog.templates.get(t.id)).toBe(t);
    }
  });

  it("rejects duplicate across different template groups", () => {
    expect(() =>
      createQueryCatalog([FOOD_LOOKUP_TEMPLATE, FOOD_LOOKUP_TEMPLATE]),
    ).toThrow(/duplicate/i);
  });
});

// ─── parameter validation: templates 2–7 ──────────────────────────────────

describe("validateParams — templates 2–7", () => {
  const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

  it("meal_summary requires date_from and date_to", () => {
    const t = catalog.templates.get("meal_summary")!;
    expect(validateParams(t, {})).toHaveLength(2);

    const valid = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
    });
    expect(valid).toHaveLength(0);
  });

  it("meal_summary rejects non-date strings for date params", () => {
    const t = catalog.templates.get("meal_summary")!;
    const errors = validateParams(t, {
      date_from: "not-a-date",
      date_to: "2026-07-07",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("date_from");
  });

  it("daily_totals requires date_from and date_to", () => {
    const t = catalog.templates.get("daily_totals")!;
    expect(validateParams(t, {})).toHaveLength(2);

    const valid = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
    });
    expect(valid).toHaveLength(0);
  });

  it("weekly_totals requires date_from and date_to", () => {
    const t = catalog.templates.get("weekly_totals")!;
    expect(validateParams(t, {})).toHaveLength(2);

    const valid = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-14",
    });
    expect(valid).toHaveLength(0);
  });

  it("daily_average requires date_from and date_to", () => {
    const t = catalog.templates.get("daily_average")!;
    expect(validateParams(t, {})).toHaveLength(2);

    const valid = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
    });
    expect(valid).toHaveLength(0);
  });

  it("range_comparison requires four date params", () => {
    const t = catalog.templates.get("range_comparison")!;
    expect(validateParams(t, {})).toHaveLength(4);

    const valid = validateParams(t, {
      range1_from: "2026-06-26",
      range1_to: "2026-07-02",
      range2_from: "2026-07-03",
      range2_to: "2026-07-09",
    });
    expect(valid).toHaveLength(0);
  });

  it("range_comparison rejects extra unknown params", () => {
    const t = catalog.templates.get("range_comparison")!;
    const errors = validateParams(t, {
      range1_from: "2026-06-26",
      range1_to: "2026-07-02",
      range2_from: "2026-07-03",
      range2_to: "2026-07-09",
      user_id: "hacker",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("user_id");
  });

  it("top_k_by_nutrient requires date_from, date_to, nutrient, k", () => {
    const t = catalog.templates.get("top_k_by_nutrient")!;
    expect(validateParams(t, {})).toHaveLength(4);

    const valid = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
      nutrient: "protein",
      k: 5,
    });
    expect(valid).toHaveLength(0);
  });

  it("top_k_by_nutrient rejects invalid nutrient enum values", () => {
    const t = catalog.templates.get("top_k_by_nutrient")!;
    const errors = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
      nutrient: "fiber",
      k: 3,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("nutrient");
    expect(errors[0].message).toMatch(/enum/i);
  });

  it("top_k_by_nutrient rejects non-positive k", () => {
    const t = catalog.templates.get("top_k_by_nutrient")!;
    const errors = validateParams(t, {
      date_from: "2026-07-01",
      date_to: "2026-07-07",
      nutrient: "kcal",
      k: 0,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].param).toBe("k");
  });
});

// ─── in-memory runner: meal-based templates ───────────────────────────────

function makeMeal(overrides: Partial<MealRecord> = {}): MealRecord {
  return {
    userId: "user-001",
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
    // Monday 2026-07-06
    makeMeal({
      foodName: "oatmeal",
      mealType: "breakfast",
      loggedAt: "2026-07-06T08:00:00Z",
      kcal: 170,
      proteinG: 6,
      fatG: 3.6,
      carbsG: 29,
      portionG: 240,
    }),
    makeMeal({
      foodName: "chicken breast",
      mealType: "lunch",
      loggedAt: "2026-07-06T12:00:00Z",
      kcal: 330,
      proteinG: 62,
      fatG: 7.2,
      carbsG: 0,
      portionG: 200,
    }),
    makeMeal({
      foodName: "salmon",
      mealType: "dinner",
      loggedAt: "2026-07-06T19:00:00Z",
      kcal: 354,
      proteinG: 34,
      fatG: 22.1,
      carbsG: 0,
      portionG: 170,
    }),
    // Tuesday 2026-07-07
    makeMeal({
      foodName: "egg",
      mealType: "breakfast",
      loggedAt: "2026-07-07T08:00:00Z",
      kcal: 310,
      proteinG: 26,
      fatG: 22,
      carbsG: 2.2,
      portionG: 200,
    }),
    makeMeal({
      foodName: "white rice",
      mealType: "lunch",
      loggedAt: "2026-07-07T12:00:00Z",
      kcal: 260,
      proteinG: 5.4,
      fatG: 0.6,
      carbsG: 56,
      portionG: 200,
    }),
    makeMeal({
      foodName: "broccoli",
      mealType: "dinner",
      loggedAt: "2026-07-07T19:00:00Z",
      kcal: 34,
      proteinG: 2.8,
      fatG: 0.4,
      carbsG: 7,
      portionG: 100,
    }),
    // Wednesday 2026-07-08
    makeMeal({
      foodName: "chicken breast",
      mealType: "lunch",
      loggedAt: "2026-07-08T12:00:00Z",
      kcal: 330,
      proteinG: 62,
      fatG: 7.2,
      carbsG: 0,
      portionG: 200,
    }),
    // Thursday 2026-07-09
    makeMeal({
      foodName: "salmon",
      mealType: "dinner",
      loggedAt: "2026-07-09T19:00:00Z",
      kcal: 354,
      proteinG: 34,
      fatG: 22.1,
      carbsG: 0,
      portionG: 170,
    }),
    makeMeal({
      foodName: "banana",
      mealType: "snack",
      loggedAt: "2026-07-09T15:00:00Z",
      kcal: 105,
      proteinG: 1.3,
      fatG: 0.4,
      carbsG: 27.1,
      portionG: 118,
    }),
  ];
}

describe("createInMemoryQueryRunner — food_lookup (existing)", () => {
  const catalog = seedCatalog();
  const runner = createInMemoryQueryRunner(catalog);

  it("returns observation for valid food", async () => {
    const obs = await runner(
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
    );
    expect(obs.templateId).toBe("food_lookup");
    expect(obs.rows[0].food_name).toBe("salmon");
  });
});

describe("createInMemoryQueryRunner — meal_summary", () => {
  const catalog = seedCatalog();
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("aggregates meals by meal type within date range", async () => {
    const obs = await runner(
      "meal_summary",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.templateId).toBe("meal_summary");
    expect(obs.rowCount).toBeGreaterThan(0);
    expect(obs.truncated).toBe(false);

    // Find lunch row
    const lunch = obs.rows.find((r) => r.meal_type === "lunch");
    expect(lunch).toBeDefined();
    expect(lunch!.meal_count).toBe(3); // Mon lunch, Tue lunch, Wed lunch
    expect(lunch!.total_kcal).toBeGreaterThan(0);
    expect(lunch!.total_protein_g).toBeGreaterThan(0);
  });

  it("returns only rows for meal types that have data", async () => {
    const obs = await runner(
      "meal_summary",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    const mealTypes = obs.rows.map((r) => r.meal_type);
    // breakfast, lunch, dinner, snack should all be present in our test data
    expect(mealTypes).toContain("breakfast");
    expect(mealTypes).toContain("lunch");
    expect(mealTypes).toContain("dinner");
    expect(mealTypes).toContain("snack");
    // No rows for meal types with zero meals
    for (const r of obs.rows) {
      expect(r.meal_count).toBeGreaterThan(0);
    }
  });

  it("scopes to user identity", async () => {
    const mixedMeals = [
      makeMeal({
        userId: "user-A",
        foodName: "chicken breast",
        loggedAt: "2026-07-06T12:00:00Z",
        kcal: 330,
      }),
      makeMeal({
        userId: "user-B",
        foodName: "salmon",
        loggedAt: "2026-07-06T12:00:00Z",
        kcal: 354,
      }),
    ];
    const mixedRunner = createInMemoryQueryRunner(catalog, mixedMeals);

    const obsA = await mixedRunner(
      "meal_summary",
      {
        date_from: "2026-07-01",
        date_to: "2026-07-10",
      },
      "user-A",
    );
    expect(obsA.rows).toHaveLength(1);
    expect(obsA.rows[0].meal_type).toBe("lunch");
    expect(obsA.rows[0].total_kcal).toBe(330);

    const obsB = await mixedRunner(
      "meal_summary",
      {
        date_from: "2026-07-01",
        date_to: "2026-07-10",
      },
      "user-B",
    );
    expect(obsB.rows).toHaveLength(1);
    expect(obsB.rows[0].total_kcal).toBe(354);
  });

  it("returns empty when no meals in range", async () => {
    const obs = await runner(
      "meal_summary",
      {
        date_from: "2020-01-01",
        date_to: "2020-01-07",
      },
      "user-001",
    );

    expect(obs.rows).toHaveLength(0);
    expect(obs.rowCount).toBe(0);
  });

  it("carries schema-declared columns with unit metadata", async () => {
    const obs = await runner(
      "meal_summary",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.columns).toBe(MEAL_SUMMARY_TEMPLATE.resultSchema);

    // Nutrition columns must carry units; count columns are unitless
    const unitColumns = obs.columns.filter(
      (c) => c.type === "number" && c.name.startsWith("total_"),
    );
    for (const col of unitColumns) {
      expect(col.unit).toBeDefined();
    }
  });
});

describe("createInMemoryQueryRunner — daily_totals", () => {
  const catalog = seedCatalog();
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("returns one row per day with meals", async () => {
    const obs = await runner(
      "daily_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.templateId).toBe("daily_totals");
    // 4 days (Mon–Thu) all have meals
    expect(obs.rowCount).toBe(4);

    const dates = obs.rows.map((r) => r.date);
    expect(dates).toContain("2026-07-06");
    expect(dates).toContain("2026-07-07");
    expect(dates).toContain("2026-07-08");
    expect(dates).toContain("2026-07-09");
  });

  it("sums nutrition correctly for a day", async () => {
    const obs = await runner(
      "daily_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-06",
      },
      "user-001",
    );

    expect(obs.rowCount).toBe(1);
    const day = obs.rows[0];
    // Mon: oatmeal(170) + chicken(330) + salmon(354) = 854 kcal
    expect(day.total_kcal).toBe(854);
    expect(day.meal_count).toBe(3);
  });

  it("days with no meals are omitted", async () => {
    const obs = await runner(
      "daily_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    // July 8 (Wed) has 1 meal, July 9 (Thu) has 2 meals
    // All 4 days have at least 1 meal
    const day6 = obs.rows.find((r) => r.date === "2026-07-06");
    expect(day6).toBeDefined();
    expect(day6!.meal_count).toBe(3);

    const day8 = obs.rows.find((r) => r.date === "2026-07-08");
    expect(day8).toBeDefined();
    expect(day8!.meal_count).toBe(1);
  });

  it("carries schema-declared columns", async () => {
    const obs = await runner(
      "daily_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-06",
      },
      "user-001",
    );

    expect(obs.columns).toBe(DAILY_TOTALS_TEMPLATE.resultSchema);
  });
});

describe("createInMemoryQueryRunner — weekly_totals", () => {
  const catalog = seedCatalog();
  // Week covering Mon 2026-07-06 through Thu 2026-07-09 (same ISO week)
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("groups by ISO week and returns week_start Mondays", async () => {
    const obs = await runner(
      "weekly_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.templateId).toBe("weekly_totals");
    expect(obs.rowCount).toBe(1); // All meals in one ISO week
    expect(obs.rows[0].week_start).toBe("2026-07-06"); // Monday of that week
  });

  it("counts distinct days and total meals", async () => {
    const obs = await runner(
      "weekly_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    const week = obs.rows[0];
    expect(week.meal_count).toBe(9); // All 9 meals
    expect(week.day_count).toBe(4); // Mon–Thu
  });

  it("totals nutrition across the week", async () => {
    const obs = await runner(
      "weekly_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    const week = obs.rows[0];
    // All meals combined: need to sum from makeWeekMeals
    // oatmeal(170) + chicken(330) + salmon(354) + egg(310) + rice(260) +
    // broccoli(34) + chicken(330) + salmon(354) + banana(105) = 2247
    expect(week.total_kcal).toBeGreaterThan(2000);
    expect(week.total_kcal).toBe(2247);
  });

  it("carries schema-declared columns", async () => {
    const obs = await runner(
      "weekly_totals",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.columns).toBe(WEEKLY_TOTALS_TEMPLATE.resultSchema);
  });
});

describe("createInMemoryQueryRunner — daily_average", () => {
  const catalog = seedCatalog();
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("computes average per day over the full range", async () => {
    const obs = await runner(
      "daily_average",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.templateId).toBe("daily_average");
    expect(obs.rowCount).toBe(1);

    const row = obs.rows[0];
    expect(row.total_days).toBe(4); // 4 days inclusive
    expect(row.days_with_meals).toBe(4);
    // Total kcal = 2247, avg = 2247/4 = 561.75 → round to 561.8
    expect(row.avg_kcal).toBe(561.8);
    expect(row.avg_protein_g).toBeGreaterThan(0);
    expect(row.avg_fat_g).toBeGreaterThan(0);
    expect(row.avg_carbs_g).toBeGreaterThan(0);
  });

  it("denominator is total days, not days with meals", async () => {
    // Only 1 day of meals out of a 7-day range
    const singleDayMeals = [
      makeMeal({ loggedAt: "2026-07-06T12:00:00Z", kcal: 500 }),
    ];
    const singleRunner = createInMemoryQueryRunner(catalog, singleDayMeals);

    const obs = await singleRunner(
      "daily_average",
      {
        date_from: "2026-07-01",
        date_to: "2026-07-07",
      },
      "user-001",
    );

    expect(obs.rows[0].total_days).toBe(7);
    expect(obs.rows[0].days_with_meals).toBe(1);
    expect(obs.rows[0].avg_kcal).toBe(71.4); // 500/7 ≈ 71.4
  });

  it("carries schema-declared columns", async () => {
    const obs = await runner(
      "daily_average",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.columns).toBe(DAILY_AVERAGE_TEMPLATE.resultSchema);
  });
});

describe("createInMemoryQueryRunner — range_comparison", () => {
  const catalog = seedCatalog();

  // Week 1 (2026-07-06 to 2026-07-07): 5 meals, 2 days
  // Week 2 (2026-07-08 to 2026-07-09): 3 meals, 2 days
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("computes per-range averages and diff columns", async () => {
    const obs = await runner(
      "range_comparison",
      {
        range1_from: "2026-07-06",
        range1_to: "2026-07-07",
        range2_from: "2026-07-08",
        range2_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.templateId).toBe("range_comparison");
    expect(obs.rowCount).toBe(1);

    const row = obs.rows[0];
    // R1: Mon(854) + Tue(604) = 1458 over 2 days = 729 avg
    // R2: Wed(330) + Thu(354+105) = 789 over 2 days = 394.5 avg
    expect(row.range1_avg_kcal).toBe(729);
    expect(row.range2_avg_kcal).toBe(394.5);
    expect(row.diff_kcal).toBe(394.5 - 729); // -334.5
    expect(row.range1_days).toBe(2);
    expect(row.range2_days).toBe(2);
  });

  it("diff column is observed, not model-computed", async () => {
    const obs = await runner(
      "range_comparison",
      {
        range1_from: "2026-07-06",
        range1_to: "2026-07-07",
        range2_from: "2026-07-08",
        range2_to: "2026-07-09",
      },
      "user-001",
    );

    const row = obs.rows[0];
    // The diff MUST be available as a column so the model reads it
    expect(typeof row.diff_kcal).toBe("number");
    expect(typeof row.diff_protein_g).toBe("number");
    expect(typeof row.diff_fat_g).toBe("number");
    expect(typeof row.diff_carbs_g).toBe("number");

    // Verify: diff ≈ range2 - range1 (within 0.2 for floating point / rounding)
    // Runner computes diff from raw values before display rounding,
    // so re-deriving from display values may differ by ≤0.1.
    const tolerance = 0.2;
    expect(
      Math.abs(
        Number(row.diff_kcal) -
          (Number(row.range2_avg_kcal) - Number(row.range1_avg_kcal)),
      ),
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(
        Number(row.diff_protein_g) -
          (Number(row.range2_avg_protein_g) - Number(row.range1_avg_protein_g)),
      ),
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(
        Number(row.diff_fat_g) -
          (Number(row.range2_avg_fat_g) - Number(row.range1_avg_fat_g)),
      ),
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(
        Number(row.diff_carbs_g) -
          (Number(row.range2_avg_carbs_g) - Number(row.range1_avg_carbs_g)),
      ),
    ).toBeLessThanOrEqual(tolerance);
  });

  it("carries schema-declared columns", async () => {
    const obs = await runner(
      "range_comparison",
      {
        range1_from: "2026-07-06",
        range1_to: "2026-07-07",
        range2_from: "2026-07-08",
        range2_to: "2026-07-09",
      },
      "user-001",
    );

    expect(obs.columns).toBe(RANGE_COMPARISON_TEMPLATE.resultSchema);
  });
});

describe("createInMemoryQueryRunner — top_k_by_nutrient", () => {
  const catalog = seedCatalog();
  const meals = makeWeekMeals();
  const runner = createInMemoryQueryRunner(catalog, meals);

  it("ranks foods by the specified nutrient descending", async () => {
    const obs = await runner(
      "top_k_by_nutrient",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
        nutrient: "protein",
        k: 3,
      },
      "user-001",
    );

    expect(obs.templateId).toBe("top_k_by_nutrient");
    expect(obs.rowCount).toBe(3);

    // Rank 1 must have highest protein
    expect(obs.rows[0].rank).toBe(1);
    expect(obs.rows[0].total_protein_g).toBeGreaterThanOrEqual(
      Number(obs.rows[1].total_protein_g),
    );
  });

  it("returns at most k rows", async () => {
    const obs = await runner(
      "top_k_by_nutrient",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
        nutrient: "kcal",
        k: 5,
      },
      "user-001",
    );

    expect(obs.rowCount).toBeLessThanOrEqual(5);
    // There are 6 distinct foods, so we should get 5
    expect(obs.rowCount).toBe(5);
  });

  it("returns fewer rows when there are fewer distinct foods than k", async () => {
    // Only 1 food type
    const singleFoodMeals = [
      makeMeal({ loggedAt: "2026-07-06T12:00:00Z" }),
      makeMeal({ loggedAt: "2026-07-06T19:00:00Z" }),
    ];
    const singleRunner = createInMemoryQueryRunner(catalog, singleFoodMeals);

    const obs = await singleRunner(
      "top_k_by_nutrient",
      {
        date_from: "2026-07-01",
        date_to: "2026-07-10",
        nutrient: "protein",
        k: 10,
      },
      "user-001",
    );

    expect(obs.rowCount).toBe(1);
    expect(obs.rows[0].rank).toBe(1);
  });

  it("supports ranking by all four nutrient types", async () => {
    for (const nutrient of ["kcal", "protein", "fat", "carbs"] as const) {
      const obs = await runner(
        "top_k_by_nutrient",
        {
          date_from: "2026-07-06",
          date_to: "2026-07-09",
          nutrient,
          k: 3,
        },
        "user-001",
      );

      expect(obs.rowCount).toBeGreaterThan(0);
      // Rows must be sorted by the chosen nutrient descending
      for (let i = 0; i < obs.rowCount - 1; i++) {
        const nutrientCol =
          nutrient === "kcal"
            ? "total_kcal"
            : nutrient === "protein"
              ? "total_protein_g"
              : nutrient === "fat"
                ? "total_fat_g"
                : "total_carbs_g";
        expect(Number(obs.rows[i][nutrientCol])).toBeGreaterThanOrEqual(
          Number(obs.rows[i + 1][nutrientCol]),
        );
      }
    }
  });

  it("carries schema-declared columns", async () => {
    const obs = await runner(
      "top_k_by_nutrient",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
        nutrient: "kcal",
        k: 3,
      },
      "user-001",
    );

    expect(obs.columns).toBe(TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema);
  });

  it("total_portion_g tracks cumulative portion across meals", async () => {
    const obs = await runner(
      "top_k_by_nutrient",
      {
        date_from: "2026-07-06",
        date_to: "2026-07-09",
        nutrient: "protein",
        k: 5,
      },
      "user-001",
    );

    const chicken = obs.rows.find((r) => r.food_name === "chicken breast");
    expect(chicken).toBeDefined();
    // chicken breast appears twice: 200g + 200g = 400g
    expect(chicken!.total_portion_g).toBe(400);
    expect(chicken!.meal_count).toBe(2);
  });
});

// ─── full catalog prompt section ──────────────────────────────────────────

describe("buildTemplatePromptSection — seven templates", () => {
  it("renders all seven template ids", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("food_lookup");
    expect(section).toContain("meal_summary");
    expect(section).toContain("daily_totals");
    expect(section).toContain("weekly_totals");
    expect(section).toContain("daily_average");
    expect(section).toContain("range_comparison");
    expect(section).toContain("top_k_by_nutrient");
  });

  it("includes parameter type annotations for all templates", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("(required)");
    // meal_summary and daily_totals have required date params
    expect(section).toContain("date (required)");
    // top_k_by_nutrient has enum param
    expect(section).toContain("enum (required)");
    expect(section).toContain("kcal");
    expect(section).toContain("protein");
    expect(section).toContain("fat");
    expect(section).toContain("carbs");
  });

  it("includes unit-bearing result columns for all templates", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
    const section = buildTemplatePromptSection(catalog)!;

    // Unit-bearing columns must appear for numeric gate consumption
    expect(section).toContain("(kcal)");
    expect(section).toContain("(g)");
  });

  it("range_comparison section includes diff columns", () => {
    const catalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
    const section = buildTemplatePromptSection(catalog)!;

    expect(section).toContain("diff_kcal");
    expect(section).toContain("diff_protein_g");
  });

  it("returns undefined for empty catalog", () => {
    const section = buildTemplatePromptSection(createQueryCatalog([]));
    expect(section).toBeUndefined();
  });

  it("returns undefined for undefined catalog", () => {
    const section = buildTemplatePromptSection(undefined);
    expect(section).toBeUndefined();
  });
});

// ─── executeQuery with all seven templates ─────────────────────────────────

describe("executeQuery — all seven templates through catalog layer", () => {
  const foodCatalog = seedCatalog();
  const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);
  // Runner with no meal data (only food_lookup will return non-empty)
  const runner = createInMemoryQueryRunner(foodCatalog, []);

  it("executes food_lookup successfully", async () => {
    const result = await executeQuery(
      queryCatalog,
      "food_lookup",
      { food_id: "food-salmon-001" },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
  });

  it("executes meal_summary (empty meals) and returns empty observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "meal_summary",
      { date_from: "2026-07-01", date_to: "2026-07-07" },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rowCount).toBe(0);
    }
  });

  it("executes daily_totals (empty meals) and returns empty observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "daily_totals",
      { date_from: "2026-07-01", date_to: "2026-07-07" },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rowCount).toBe(0);
    }
  });

  it("executes weekly_totals (empty meals) and returns empty observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "weekly_totals",
      { date_from: "2026-07-01", date_to: "2026-07-14" },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rowCount).toBe(0);
    }
  });

  it("executes daily_average (empty meals) and returns zero averages", async () => {
    const result = await executeQuery(
      queryCatalog,
      "daily_average",
      { date_from: "2026-07-01", date_to: "2026-07-07" },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rows[0].avg_kcal).toBe(0);
      expect(result.observation.rows[0].total_days).toBe(7);
      expect(result.observation.rows[0].days_with_meals).toBe(0);
    }
  });

  it("executes range_comparison (empty meals) and returns zero diffs", async () => {
    const result = await executeQuery(
      queryCatalog,
      "range_comparison",
      {
        range1_from: "2026-07-01",
        range1_to: "2026-07-07",
        range2_from: "2026-07-08",
        range2_to: "2026-07-14",
      },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rows[0].diff_kcal).toBe(0);
    }
  });

  it("executes top_k_by_nutrient (empty meals) and returns empty observation", async () => {
    const result = await executeQuery(
      queryCatalog,
      "top_k_by_nutrient",
      {
        date_from: "2026-07-01",
        date_to: "2026-07-07",
        nutrient: "protein",
        k: 5,
      },
      "user-001",
      runner,
    );
    expect(result.type).toBe("observation");
    if (result.type === "observation") {
      expect(result.observation.rowCount).toBe(0);
    }
  });

  it("returns typed error for unknown template among seven", async () => {
    const result = await executeQuery(
      queryCatalog,
      "nonexistent",
      {},
      "user-001",
      runner,
    );
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.availableTemplates).toHaveLength(7);
      expect(result.availableTemplates).toContain("meal_summary");
      expect(result.availableTemplates).toContain("range_comparison");
    }
  });
});
