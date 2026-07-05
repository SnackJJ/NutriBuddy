// Typed Query Catalog — reviewed template catalog with parameter validation,
// user-identity binding, and schema-declared observations (PRD v2 §3.2 / ADD Phase 1).
//
// The model selects templates by id and provides typed parameters. Deterministic
// code validates parameters, binds user identity outside model-fillable input,
// executes against a data port, and returns schema-declared observations with
// unit-bearing numeric fields.
//
// Nutrition numbers come from observations, not model arithmetic. The template
// boundary ensures malformed queries are unrepresentable.

// ─── types ─────────────────────────────────────────────────────────────────

/** Typed parameter definition exposed in the template signature. */
export interface ParamDef {
  readonly name: string;
  readonly type: "string" | "number" | "enum" | "date";
  readonly required: boolean;
  readonly description: string;
  /** Allowed values for enum parameters. */
  readonly enumValues?: readonly string[];
}

/** A column in the observation result schema with unit-bearing metadata. */
export interface ColumnDef {
  readonly name: string;
  readonly type: "number" | "string" | "date" | "boolean";
  /** Unit for numeric columns (e.g. "g", "kcal", "mg"); undefined for non-numeric. */
  readonly unit?: string;
  readonly description: string;
}

/** A reviewed query template: typed params → reviewed SQL → schema-declared observations. */
export interface QueryTemplate {
  /** Stable template id the model selects (e.g. "food_lookup"). */
  readonly id: string;
  /** Human-readable description for prompt injection. */
  readonly description: string;
  /** Typed parameters the model must provide. */
  readonly parameters: readonly ParamDef[];
  /** Declared result schema with unit-bearing column metadata. */
  readonly resultSchema: readonly ColumnDef[];
}

/** One row of an observation result. Keys match ColumnDef names. */
export interface ObservationRow {
  readonly [column: string]: unknown;
}

/**
 * A schema-declared observation produced by executing a query template.
 * Every numeric column carries a declared unit; numeric facts trace to
 * (templateId, rowIndex, columnName).
 */
export interface Observation {
  readonly templateId: string;
  readonly columns: readonly ColumnDef[];
  readonly rows: readonly ObservationRow[];
  readonly rowCount: number;
  /** True when the row cap was hit and more rows exist. */
  readonly truncated: boolean;
}

/** Either a successful observation or a typed error the model can retry on. */
export type QueryResult =
  | { readonly type: "observation"; readonly observation: Observation }
  | {
      readonly type: "error";
      readonly templateId: string;
      readonly message: string;
      /** Available template ids so the model can retry with a valid selection. */
      readonly availableTemplates: readonly string[];
    };

/** A validation error about a specific parameter. */
export interface ValidationError {
  readonly param: string;
  readonly message: string;
}

/** The query catalog: immutable container for reviewed templates. */
export interface QueryCatalog {
  readonly templates: ReadonlyMap<string, QueryTemplate>;
  /** Flat list for prompt injection (template signatures). */
  readonly templateList: readonly QueryTemplate[];
}

/**
 * Query runner port. Executes a template against a data source.
 * The userId is bound by the caller (not from model params).
 * In production this runs reviewed SQL; tests can stub with in-memory data.
 */
export type QueryRunner = (
  templateId: string,
  params: Record<string, unknown>,
  userId: string,
) => Promise<Observation>;

// ─── catalog container ─────────────────────────────────────────────────────

/** Build an immutable query catalog from a list of templates. */
export function createQueryCatalog(
  templates: readonly QueryTemplate[],
): QueryCatalog {
  const map = new Map<string, QueryTemplate>();

  for (const t of templates) {
    if (map.has(t.id)) {
      throw new Error(`Duplicate query template id: ${t.id}`);
    }
    map.set(t.id, t);
  }

  return {
    templates: map,
    templateList: templates,
  };
}

// ─── parameter validation ──────────────────────────────────────────────────

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function validateParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  // Required check
  if (!isPresent(value)) {
    if (param.required) {
      return {
        param: param.name,
        message: `Required parameter "${param.name}" is missing.`,
      };
    }
    return null; // optional, not present → OK
  }

  // Type checks
  switch (param.type) {
    case "string": {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a non-empty string.`,
        };
      }
      break;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a finite number.`,
        };
      }
      // Portion-like numbers must be positive
      if (value <= 0) {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a positive number.`,
        };
      }
      break;
    }
    case "enum": {
      if (typeof value !== "string") {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a string (enum).`,
        };
      }
      if (
        param.enumValues &&
        param.enumValues.length > 0 &&
        !param.enumValues.includes(value)
      ) {
        return {
          param: param.name,
          message:
            `Parameter "${param.name}" value "${value}" is not in the allowed enum: ` +
            `[${param.enumValues.join(", ")}].`,
        };
      }
      if (!param.enumValues || param.enumValues.length === 0) {
        return {
          param: param.name,
          message: `Parameter "${param.name}" has no defined enum values.`,
        };
      }
      break;
    }
    case "date": {
      if (typeof value !== "string") {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a string (ISO 8601 date).`,
        };
      }
      // Validate ISO 8601 date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(value)) {
        return {
          param: param.name,
          message: `Parameter "${param.name}" must be a valid ISO 8601 date (YYYY-MM-DD).`,
        };
      }
      break;
    }
  }

  return null;
}

/**
 * Validate model-provided params against a template's parameter definitions.
 * Returns an empty array when all params pass validation.
 */
export function validateParams(
  template: QueryTemplate,
  params: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check each declared parameter
  for (const param of template.parameters) {
    const error = validateParam(param, params[param.name]);
    if (error) {
      errors.push(error);
    }
  }

  // Check for unknown parameters (model cannot inject extra fields)
  const declaredNames = new Set(template.parameters.map((p) => p.name));
  for (const key of Object.keys(params)) {
    if (!declaredNames.has(key)) {
      errors.push({
        param: key,
        message: `Unknown parameter "${key}" — this template does not accept it.`,
      });
    }
  }

  return errors;
}

// ─── query execution ───────────────────────────────────────────────────────

function makeErrorResult(
  templateId: string,
  message: string,
  catalog: QueryCatalog,
): QueryResult {
  return {
    type: "error",
    templateId,
    message,
    availableTemplates: catalog.templateList.map((t) => t.id),
  };
}

/**
 * Execute a query template: validate params → run against data port → return observation.
 *
 * The userId is bound by the caller (authenticated session) and passed to the runner;
 * the model cannot supply or override it. This is the read-path gate: the model chooses
 * template id and typed parameters; deterministic code handles the rest.
 *
 * @param catalog - the query template catalog
 * @param templateId - the template the model selected
 * @param params - typed parameters the model supplied
 * @param userId - authenticated user identity bound by the caller
 * @param runner - data port that executes the template (DB in prod, stub in tests)
 */
export async function executeQuery(
  catalog: QueryCatalog,
  templateId: string,
  params: Record<string, unknown>,
  userId: string,
  runner: QueryRunner,
): Promise<QueryResult> {
  // 1. Template lookup
  const template = catalog.templates.get(templateId);
  if (!template) {
    return makeErrorResult(
      templateId,
      `Unknown query template "${templateId}". Available templates: ` +
        catalog.templateList.map((t) => t.id).join(", "),
      catalog,
    );
  }

  // 2. Parameter validation
  const errors = validateParams(template, params);
  if (errors.length > 0) {
    const details = errors
      .map((e) => `  - ${e.param}: ${e.message}`)
      .join("\n");
    return makeErrorResult(
      templateId,
      `Parameter validation failed for template "${templateId}":\n${details}`,
      catalog,
    );
  }

  // 3. Execute against data port (userId bound by caller, not from model params)
  const observation = await runner(templateId, params, userId);

  return { type: "observation", observation };
}

// ─── reviewed query templates ──────────────────────────────────────────────

/**
 * food_lookup — Look up nutrition data for a single food by its catalog food ID.
 *
 * The model selects this template and provides a food_id (from the resolver).
 * The executor looks up the food in the local catalog and returns per-portion
 * nutrition values scaled to the requested portion size.
 *
 * Numeric columns are unit-bearing: kcal, protein_g, fat_g, carbs_g, portion_g.
 * Model arithmetic is forbidden — all derived values (portion scaling) happen
 * server-side in the runner.
 */
export const FOOD_LOOKUP_TEMPLATE: QueryTemplate = {
  id: "food_lookup",
  description:
    "Look up nutrition data for a single food by its catalog food ID. " +
    "Returns per-portion kcal, protein, fat, carbs, and allergen tags.",
  parameters: [
    {
      name: "food_id",
      type: "string",
      required: true,
      description:
        "Catalog food ID from the food resolver (e.g. 'food-chicken-breast-001'). " +
        "The model must obtain this from a prior resolver call; it cannot invent food IDs.",
    },
    {
      name: "portion_g",
      type: "number",
      required: false,
      description:
        "Portion size in grams. Defaults to 100g. Nutrition values are scaled linearly.",
    },
  ],
  resultSchema: [
    {
      name: "food_id",
      type: "string",
      description: "Catalog food ID (stable, from the seed catalog).",
    },
    {
      name: "food_name",
      type: "string",
      description: "Canonical food name from the catalog.",
    },
    {
      name: "portion_g",
      type: "number",
      unit: "g",
      description: "Portion size in grams used for scaling.",
    },
    {
      name: "kcal",
      type: "number",
      unit: "kcal",
      description: "Calories per portion.",
    },
    {
      name: "protein_g",
      type: "number",
      unit: "g",
      description: "Protein per portion in grams.",
    },
    {
      name: "fat_g",
      type: "number",
      unit: "g",
      description: "Total fat per portion in grams.",
    },
    {
      name: "carbs_g",
      type: "number",
      unit: "g",
      description: "Total carbohydrates per portion in grams.",
    },
    {
      name: "allergen_tags",
      type: "string",
      description:
        "Comma-separated FDA big-9 allergen tags. Empty string means no allergens.",
    },
  ],
};
