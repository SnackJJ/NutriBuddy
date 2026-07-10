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

/** A minimal meal record for query-runner aggregation (M1 in-memory path). */
export interface MealRecord {
  readonly userId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly loggedAt: string; // ISO 8601
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
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

function requiredParamError(param: ParamDef): ValidationError {
  return {
    param: param.name,
    message: `Required parameter "${param.name}" is missing.`,
  };
}

function validateStringParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return null;
  }

  return {
    param: param.name,
    message: `Parameter "${param.name}" must be a non-empty string.`,
  };
}

function validateNumberParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      param: param.name,
      message: `Parameter "${param.name}" must be a finite number.`,
    };
  }

  if (value <= 0) {
    return {
      param: param.name,
      message: `Parameter "${param.name}" must be a positive number.`,
    };
  }

  return null;
}

function validateEnumParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  if (typeof value !== "string") {
    return {
      param: param.name,
      message: `Parameter "${param.name}" must be a string (enum).`,
    };
  }

  if (!param.enumValues || param.enumValues.length === 0) {
    return {
      param: param.name,
      message: `Parameter "${param.name}" has no defined enum values.`,
    };
  }

  if (param.enumValues.includes(value)) {
    return null;
  }

  return {
    param: param.name,
    message:
      `Parameter "${param.name}" value "${value}" is not in the allowed enum: ` +
      `[${param.enumValues.join(", ")}].`,
  };
}

function validateDateParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  if (typeof value !== "string") {
    return {
      param: param.name,
      message: `Parameter "${param.name}" must be a string (ISO 8601 date).`,
    };
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRegex.test(value)) {
    return null;
  }

  return {
    param: param.name,
    message: `Parameter "${param.name}" must be a valid ISO 8601 date (YYYY-MM-DD).`,
  };
}

function validateParam(
  param: ParamDef,
  value: unknown,
): ValidationError | null {
  if (!isPresent(value)) {
    return param.required ? requiredParamError(param) : null;
  }

  switch (param.type) {
    case "string":
      return validateStringParam(param, value);
    case "number":
      return validateNumberParam(param, value);
    case "enum":
      return validateEnumParam(param, value);
    case "date":
      return validateDateParam(param, value);
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

  for (const param of template.parameters) {
    const error = validateParam(param, params[param.name]);
    if (error) {
      errors.push(error);
    }
  }

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
  const template = catalog.templates.get(templateId);
  if (!template) {
    return makeErrorResult(
      templateId,
      `Unknown query template "${templateId}". Available templates: ` +
        catalog.templateList.map((t) => t.id).join(", "),
      catalog,
    );
  }

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

  const observation = await runner(templateId, params, userId);

  return { type: "observation", observation };
}

// ─── observation rendering and capping ──────────────────────────────────────

/** Default max rows in the canonical observation text sent to the model. */
export const MAX_OBSERVATION_ROWS = 25;

/** Default max bytes in the canonical observation text sent to the model. */
export const MAX_OBSERVATION_BYTES = 4096;

const OBSERVATION_TRACE_NOTICE = "full data available in session trace";

function omittedRowsNotice(omittedRows: number): string {
  return `[${omittedRows} row(s) omitted — ${OBSERVATION_TRACE_NOTICE}]`;
}

/**
 * Render a single observation row as a canonical text line.
 * Columns are rendered as "name: value unit" for the model to read.
 */
export function renderObservationRow(
  row: ObservationRow,
  columns: readonly ColumnDef[],
): string {
  const parts: string[] = [];
  for (const col of columns) {
    const value = row[col.name];
    if (value === undefined || value === null) {
      continue;
    }
    const unit = col.unit ? ` ${col.unit}` : "";
    parts.push(`${col.name}: ${String(value)}${unit}`);
  }
  return parts.join(" | ");
}

/** Result of rendering an observation for model context. */
export interface RenderedObservation {
  /** Canonical text rendering (may be truncated). */
  readonly text: string;
  /** True when the rendering was truncated (rows or bytes capped). */
  readonly truncated: boolean;
  /** Number of rows rendered (≤ observation.rowCount). */
  readonly renderedRows: number;
}

/**
 * Render an observation as canonical text for model context.
 *
 * Applies top-K row cap and byte ceiling. When truncated, includes a notice
 * so the model knows it's seeing a subset. Full fidelity is preserved in the
 * session trace via the tracer.
 */
export function renderObservationText(
  obs: Observation,
  maxRows: number = MAX_OBSERVATION_ROWS,
  maxBytes: number = MAX_OBSERVATION_BYTES,
): RenderedObservation {
  const header = `[query result: ${obs.templateId}]`;
  const cappedRows = Math.min(obs.rows.length, maxRows);
  const renderedRows: string[] = [header];

  const truncatedByRows = maxRows < obs.rows.length;

  for (let i = 0; i < cappedRows; i++) {
    const line = renderObservationRow(obs.rows[i], obs.columns);
    if (i === 0 && line.length > maxBytes) {
      const short = line.slice(0, maxBytes - 3) + "...";
      renderedRows.push(
        `[row 1 of ${obs.rowCount} truncated at ${maxBytes}B] ${short}`,
      );
      return {
        text: renderedRows.join("\n"),
        truncated: true,
        renderedRows: 1,
      };
    }

    const candidate = [...renderedRows, line].join("\n");
    if (candidate.length > maxBytes) {
      const omitted = obs.rowCount - i;
      renderedRows.push(omittedRowsNotice(omitted));
      return {
        text: renderedRows.join("\n"),
        truncated: true,
        renderedRows: i,
      };
    }

    renderedRows.push(line);
  }

  if (truncatedByRows) {
    const omitted = obs.rowCount - cappedRows;
    renderedRows.push(omittedRowsNotice(omitted));
  }

  return {
    text: renderedRows.join("\n"),
    truncated: truncatedByRows || (obs.truncated && obs.rowCount > 0),
    renderedRows: cappedRows,
  };
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

/**
 * meal_summary — Summarise all meals within a date range, aggregated by meal type.
 *
 * Groups meals into breakfast / lunch / dinner / snack buckets and returns
 * per-bucket totals for kcal and macros. The model cannot sum raw meal rows;
 * aggregation happens server-side and lands as observation columns.
 */
export const MEAL_SUMMARY_TEMPLATE: QueryTemplate = {
  id: "meal_summary",
  description:
    "Summarise all meals within a date range, aggregated by meal type " +
    "(breakfast, lunch, dinner, snack). Returns per-meal-type totals for " +
    "kcal, protein, fat, carbs, and meal count.",
  parameters: [
    {
      name: "date_from",
      type: "date",
      required: true,
      description:
        "Start date (YYYY-MM-DD, inclusive). Only meals logged on or after " +
        "this date are included.",
    },
    {
      name: "date_to",
      type: "date",
      required: true,
      description:
        "End date (YYYY-MM-DD, inclusive). Only meals logged on or before " +
        "this date are included.",
    },
  ],
  resultSchema: [
    {
      name: "meal_type",
      type: "string",
      description:
        "Meal type: breakfast, lunch, dinner, or snack.",
    },
    {
      name: "meal_count",
      type: "number",
      description: "Number of meals of this type in the range.",
    },
    {
      name: "total_kcal",
      type: "number",
      unit: "kcal",
      description: "Total calories for this meal type across the range.",
    },
    {
      name: "total_protein_g",
      type: "number",
      unit: "g",
      description: "Total protein for this meal type across the range.",
    },
    {
      name: "total_fat_g",
      type: "number",
      unit: "g",
      description: "Total fat for this meal type across the range.",
    },
    {
      name: "total_carbs_g",
      type: "number",
      unit: "g",
      description: "Total carbs for this meal type across the range.",
    },
  ],
};

/**
 * daily_totals — Daily nutrition totals for each day within a date range.
 *
 * Returns one row per calendar day with summed kcal, protein, fat, carbs,
 * and a meal count. Days with zero meals are omitted.
 */
export const DAILY_TOTALS_TEMPLATE: QueryTemplate = {
  id: "daily_totals",
  description:
    "Daily nutrition totals for each day within a date range. Returns one " +
    "row per day with summed kcal, protein, fat, carbs, and meal count. " +
    "Days with no meals are omitted.",
  parameters: [
    {
      name: "date_from",
      type: "date",
      required: true,
      description:
        "Start date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "date_to",
      type: "date",
      required: true,
      description:
        "End date (YYYY-MM-DD, inclusive).",
    },
  ],
  resultSchema: [
    {
      name: "date",
      type: "date",
      description: "Calendar date (YYYY-MM-DD).",
    },
    {
      name: "total_kcal",
      type: "number",
      unit: "kcal",
      description: "Total calories for the day.",
    },
    {
      name: "total_protein_g",
      type: "number",
      unit: "g",
      description: "Total protein for the day.",
    },
    {
      name: "total_fat_g",
      type: "number",
      unit: "g",
      description: "Total fat for the day.",
    },
    {
      name: "total_carbs_g",
      type: "number",
      unit: "g",
      description: "Total carbs for the day.",
    },
    {
      name: "meal_count",
      type: "number",
      description: "Number of meals logged on this day.",
    },
  ],
};

/**
 * weekly_totals — Weekly nutrition totals, grouped by ISO week.
 *
 * Returns one row per ISO week (Monday–Sunday) that contains at least one meal.
 * day_count measures how many distinct calendar days had meals within the week.
 */
export const WEEKLY_TOTALS_TEMPLATE: QueryTemplate = {
  id: "weekly_totals",
  description:
    "Weekly nutrition totals, grouped by ISO week (Monday to Sunday). " +
    "Returns one row per week with summed kcal, protein, fat, carbs, " +
    "meal count, and the number of distinct days with meals.",
  parameters: [
    {
      name: "date_from",
      type: "date",
      required: true,
      description:
        "Start date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "date_to",
      type: "date",
      required: true,
      description:
        "End date (YYYY-MM-DD, inclusive).",
    },
  ],
  resultSchema: [
    {
      name: "week_start",
      type: "date",
      description: "Monday of the ISO week (YYYY-MM-DD).",
    },
    {
      name: "total_kcal",
      type: "number",
      unit: "kcal",
      description: "Total calories for the week.",
    },
    {
      name: "total_protein_g",
      type: "number",
      unit: "g",
      description: "Total protein for the week.",
    },
    {
      name: "total_fat_g",
      type: "number",
      unit: "g",
      description: "Total fat for the week.",
    },
    {
      name: "total_carbs_g",
      type: "number",
      unit: "g",
      description: "Total carbs for the week.",
    },
    {
      name: "meal_count",
      type: "number",
      description: "Number of meals logged in the week.",
    },
    {
      name: "day_count",
      type: "number",
      description:
        "Number of distinct calendar days with at least one meal in the week.",
    },
  ],
};

/**
 * daily_average — Average daily nutrition over a date range.
 *
 * Divides total intake by the number of days in the range (inclusive), so days
 * without meals pull the average down. Also reports how many days actually had
 * meals, so the model can contextualise the average.
 */
export const DAILY_AVERAGE_TEMPLATE: QueryTemplate = {
  id: "daily_average",
  description:
    "Average daily nutrition over a date range. Computes total intake " +
    "divided by the number of days in the range (inclusive). Also reports " +
    "how many days had at least one meal so the model can contextualise " +
    "the average.",
  parameters: [
    {
      name: "date_from",
      type: "date",
      required: true,
      description:
        "Start date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "date_to",
      type: "date",
      required: true,
      description:
        "End date (YYYY-MM-DD, inclusive).",
    },
  ],
  resultSchema: [
    {
      name: "avg_kcal",
      type: "number",
      unit: "kcal",
      description:
        "Average daily calories over the range (total / total days).",
    },
    {
      name: "avg_protein_g",
      type: "number",
      unit: "g",
      description:
        "Average daily protein over the range (total / total days).",
    },
    {
      name: "avg_fat_g",
      type: "number",
      unit: "g",
      description:
        "Average daily fat over the range (total / total days).",
    },
    {
      name: "avg_carbs_g",
      type: "number",
      unit: "g",
      description:
        "Average daily carbs over the range (total / total days).",
    },
    {
      name: "days_with_meals",
      type: "number",
      description: "Number of days with at least one meal logged.",
    },
    {
      name: "total_days",
      type: "number",
      description:
        "Total days in the range (inclusive), used as the denominator.",
    },
  ],
};

/**
 * range_comparison — Compare nutrition between two date ranges.
 *
 * Computes per-range daily averages and exposes the difference (range2 − range1)
 * as an observed column. The model must not compute the difference — it reads
 * the diff columns from the observation. This is the canonical example of the
 * no-arithmetic contract.
 */
export const RANGE_COMPARISON_TEMPLATE: QueryTemplate = {
  id: "range_comparison",
  description:
    "Compare nutrition between two date ranges. Returns per-range daily " +
    "averages and the difference (range2 minus range1) as observed columns. " +
    "The model must read the diff column — it must NEVER compute the " +
    "difference itself.",
  parameters: [
    {
      name: "range1_from",
      type: "date",
      required: true,
      description:
        "First range start date (YYYY-MM-DD, inclusive). Typically the " +
        "earlier period (e.g. 'last week').",
    },
    {
      name: "range1_to",
      type: "date",
      required: true,
      description:
        "First range end date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "range2_from",
      type: "date",
      required: true,
      description:
        "Second range start date (YYYY-MM-DD, inclusive). Typically the " +
        "later period (e.g. 'this week').",
    },
    {
      name: "range2_to",
      type: "date",
      required: true,
      description:
        "Second range end date (YYYY-MM-DD, inclusive).",
    },
  ],
  resultSchema: [
    {
      name: "range1_avg_kcal",
      type: "number",
      unit: "kcal",
      description: "Range 1 average daily calories.",
    },
    {
      name: "range1_avg_protein_g",
      type: "number",
      unit: "g",
      description: "Range 1 average daily protein.",
    },
    {
      name: "range1_avg_fat_g",
      type: "number",
      unit: "g",
      description: "Range 1 average daily fat.",
    },
    {
      name: "range1_avg_carbs_g",
      type: "number",
      unit: "g",
      description: "Range 1 average daily carbs.",
    },
    {
      name: "range2_avg_kcal",
      type: "number",
      unit: "kcal",
      description: "Range 2 average daily calories.",
    },
    {
      name: "range2_avg_protein_g",
      type: "number",
      unit: "g",
      description: "Range 2 average daily protein.",
    },
    {
      name: "range2_avg_fat_g",
      type: "number",
      unit: "g",
      description: "Range 2 average daily fat.",
    },
    {
      name: "range2_avg_carbs_g",
      type: "number",
      unit: "g",
      description: "Range 2 average daily carbs.",
    },
    {
      name: "diff_kcal",
      type: "number",
      unit: "kcal",
      description:
        "Difference in average daily calories (range2 minus range1). " +
        "Positive = range 2 is higher.",
    },
    {
      name: "diff_protein_g",
      type: "number",
      unit: "g",
      description:
        "Difference in average daily protein (range2 minus range1).",
    },
    {
      name: "diff_fat_g",
      type: "number",
      unit: "g",
      description:
        "Difference in average daily fat (range2 minus range1).",
    },
    {
      name: "diff_carbs_g",
      type: "number",
      unit: "g",
      description:
        "Difference in average daily carbs (range2 minus range1).",
    },
    {
      name: "range1_days",
      type: "number",
      description: "Number of days in range 1 (inclusive).",
    },
    {
      name: "range2_days",
      type: "number",
      description: "Number of days in range 2 (inclusive).",
    },
  ],
};

/**
 * top_k_by_nutrient — Top-k foods ranked by total contribution of a nutrient.
 *
 * Aggregates all meals within the date range by food name, ranks by the
 * specified nutrient's total contribution descending, and returns the top k.
 * Returns fewer rows when fewer distinct foods were eaten.
 */
export const TOP_K_BY_NUTRIENT_TEMPLATE: QueryTemplate = {
  id: "top_k_by_nutrient",
  description:
    "Top-k foods ranked by total contribution of a specified nutrient " +
    "within a date range. Returns exactly k rows (fewer if fewer distinct " +
    "foods were eaten), ranked descending by the chosen nutrient.",
  parameters: [
    {
      name: "date_from",
      type: "date",
      required: true,
      description:
        "Start date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "date_to",
      type: "date",
      required: true,
      description:
        "End date (YYYY-MM-DD, inclusive).",
    },
    {
      name: "nutrient",
      type: "enum",
      required: true,
      enumValues: ["kcal", "protein", "fat", "carbs"],
      description:
        "Nutrient to rank by. Must be one of: kcal, protein, fat, carbs.",
    },
    {
      name: "k",
      type: "number",
      required: true,
      description:
        "Number of top foods to return. Must be between 1 and 20 inclusive.",
    },
  ],
  resultSchema: [
    {
      name: "rank",
      type: "number",
      description: "Rank position (1 = highest contribution).",
    },
    {
      name: "food_name",
      type: "string",
      description: "Food name from the meal log.",
    },
    {
      name: "total_kcal",
      type: "number",
      unit: "kcal",
      description: "Total calories from this food in the range.",
    },
    {
      name: "total_protein_g",
      type: "number",
      unit: "g",
      description: "Total protein from this food in the range.",
    },
    {
      name: "total_fat_g",
      type: "number",
      unit: "g",
      description: "Total fat from this food in the range.",
    },
    {
      name: "total_carbs_g",
      type: "number",
      unit: "g",
      description: "Total carbs from this food in the range.",
    },
    {
      name: "total_portion_g",
      type: "number",
      unit: "g",
      description:
        "Total portion size across all meals of this food in the range.",
    },
    {
      name: "meal_count",
      type: "number",
      description: "Number of meals containing this food in the range.",
    },
  ],
};

/** All seven reviewed query templates in catalog registration order. */
export const ALL_QUERY_TEMPLATES: readonly QueryTemplate[] = [
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
];
