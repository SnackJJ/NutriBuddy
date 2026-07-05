import { describe, it, expect } from "vitest";
import {
  createQueryCatalog,
  validateParams,
  executeQuery,
  FOOD_LOOKUP_TEMPLATE,
  type QueryCatalog,
  type QueryTemplate,
  type Observation,
  type ParamDef,
  type ColumnDef,
  type QueryResult,
} from "../src/catalog/queryCatalog";
import { buildTemplatePromptSection } from "../src/harness/contextAssembler";
import {
  createCatalog,
  SEED_FOODS,
  type Catalog,
} from "../src/catalog/catalog";
import { resolveFood } from "../src/catalog/resolver";

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
          allergen_tags: food.allergenTags.join(", "),
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

      if (food.allergenTags.length > 0) {
        expect(row.allergen_tags).toBe(food.allergenTags.join(", "));
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
