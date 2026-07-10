// query_catalog 工具处理器（issue #46 / PRD v2 §3.2 / ADD Phase 1）。
//
// The model selects a reviewed template and supplies typed params; deterministic
// code validates and executes the template, then returns unit-bearing
// observations. Nutrition numbers come from observations, not model arithmetic.

import type { ToolHandler, ToolSchema } from "./types";
import type {
  Observation,
  QueryCatalog,
  QueryResult,
  QueryRunner,
  RenderedObservation,
  ColumnDef,
  MealRecord,
} from "../catalog/queryCatalog";
import {
  executeQuery,
  FOOD_LOOKUP_TEMPLATE,
  renderObservationText,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
} from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";
import type { Tracer } from "./tracer";

// ─── 常量 ─────────────────────────────────────────────────────────────────

export const QUERY_CATALOG_TOOL = "query_catalog";
const FOOD_LOOKUP_TEMPLATE_ID = FOOD_LOOKUP_TEMPLATE.id;
const DEFAULT_PORTION_G = 100;
const MS_PER_DAY = 86_400_000;
const MEAL_TYPE_ORDER = ["breakfast", "lunch", "dinner", "snack"] as const;

const TEMPLATE_IDS = {
  food_lookup: FOOD_LOOKUP_TEMPLATE_ID,
  meal_summary: MEAL_SUMMARY_TEMPLATE.id,
  daily_totals: DAILY_TOTALS_TEMPLATE.id,
  weekly_totals: WEEKLY_TOTALS_TEMPLATE.id,
  daily_average: DAILY_AVERAGE_TEMPLATE.id,
  range_comparison: RANGE_COMPARISON_TEMPLATE.id,
  top_k_by_nutrient: TOP_K_BY_NUTRIENT_TEMPLATE.id,
} as const;

type QueryCatalogError = Extract<QueryResult, { readonly type: "error" }>;

// ─── OpenAI Function-Calling Schema ────────────────────────────────────────

export const QUERY_CATALOG_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: QUERY_CATALOG_TOOL,
    description:
      "Execute a reviewed query template from the QUERY TEMPLATE CATALOG. " +
      "Select a template by its id and provide the typed parameters declared " +
      "in the template signature. The harness validates parameters against the " +
      "template definition, executes the query against the data port, and " +
      "returns a schema-declared observation with unit-bearing numeric columns. " +
      "All nutrition numbers come from observations — do NOT do your own math.",
    parameters: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description:
            "The query template ID to execute. Must match one of the template " +
            "ids listed in the QUERY TEMPLATE CATALOG section of the system prompt. " +
            "Example: 'food_lookup'.",
        },
      },
      required: ["template_id"],
    },
  },
};

// ─── 依赖注入 ─────────────────────────────────────────────────────────────

export interface QueryCatalogHandlerDeps {
  /** Reviewed query template catalog (immutable container). */
  readonly queryCatalog: QueryCatalog;
  /** Data port that executes templates (in-memory in M1, Supabase in M2). */
  readonly runner: QueryRunner;
  /** Authenticated user identity bound by the caller, not model-fillable. */
  readonly userId: string;
  /** Optional tracer for recording full-fidelity observations (issue #51). */
  readonly tracer?: Tracer;
}

// ─── Handler helpers ──────────────────────────────────────────────────────

function availableTemplateText(queryCatalog: QueryCatalog): string {
  return queryCatalog.templateList.map((template) => template.id).join(", ");
}

function errorResponse(templateId: string, message: string): string {
  const error: QueryCatalogError = {
    type: "error",
    templateId,
    message,
    availableTemplates: [],
  };

  return JSON.stringify(error);
}

function templateParams(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "template_id") {
      params[key] = value;
    }
  }

  return params;
}

function recordObservationTrace(
  tracer: Tracer | undefined,
  observation: Observation,
  rendered: RenderedObservation,
): void {
  tracer?.record({
    // Tool handlers are step-agnostic; loop tool_call traces carry the dispatch step.
    step: 0,
    type: "observation",
    payload: JSON.stringify({
      observation,
      truncated: rendered.truncated,
      renderedRows: rendered.renderedRows,
    }),
  });
}

/**
 * Cap the observation that enters model context (issue #57 / ADD §Context).
 *
 * The rendering caps (top-k rows, byte ceiling) must bound what the model
 * sees, so the tool-result observation carries only the rendered rows with
 * the truncation flag set. Full fidelity flows to the session trace via
 * recordObservationTrace; rowCount keeps the pre-cap total.
 */
function capObservationForModel(
  observation: Observation,
  rendered: RenderedObservation,
): Observation {
  if (!rendered.truncated) {
    return observation;
  }

  return {
    ...observation,
    rows: observation.rows.slice(0, rendered.renderedRows),
    truncated: true,
  };
}

function observationResponse(
  observation: Observation,
  rendered: RenderedObservation,
): {
  readonly type: "observation";
  readonly text: string;
  readonly observation: Observation;
} {
  return {
    type: "observation",
    text: rendered.text,
    observation: capObservationForModel(observation, rendered),
  };
}

// ─── 工具工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 query_catalog 工具处理器。
 *
 * 依赖全部可注入以便单测不触网；对应的 function-calling schema 导出为
 * QUERY_CATALOG_SCHEMA。
 *
 * userId 由调用方绑定（认证会话），模型不可提供或覆盖。
 */
export function createQueryCatalogHandler(
  deps: QueryCatalogHandlerDeps,
): ToolHandler {
  const { queryCatalog, runner, userId, tracer } = deps;

  return async (args: Readonly<Record<string, unknown>>): Promise<string> => {
    const templateId = args.template_id;
    if (typeof templateId !== "string" || templateId.trim().length === 0) {
      return errorResponse(
        typeof templateId === "string" ? templateId : "",
        "Missing or invalid template_id: must be a non-empty string. " +
          "Available templates: " +
          availableTemplateText(queryCatalog),
      );
    }

    try {
      const result = await executeQuery(
        queryCatalog,
        templateId,
        templateParams(args),
        userId,
        runner,
      );

      if (result.type === "observation") {
        const rendered = renderObservationText(result.observation);
        recordObservationTrace(tracer, result.observation, rendered);

        return JSON.stringify(
          observationResponse(result.observation, rendered),
        );
      }

      return JSON.stringify(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(templateId, `Query execution failed: ${message}`);
    }
  };
}

// ─── In-Memory Query Runner ────────────────────────────────────────────────

// ── helpers ──────────────────────────────────────────────────────────────

/** Parse an ISO 8601 date or datetime string to a Date at noon UTC. */
function parseUtcNoonDate(dateStr: string): Date {
  const datePart = dateStr.slice(0, 10);
  return new Date(datePart + "T12:00:00Z");
}

/** Return the date portion of an ISO 8601 string as YYYY-MM-DD. */
function dateKey(isoStr: string): string {
  return isoStr.slice(0, 10);
}

/** Count calendar days between two YYYY-MM-DD dates, inclusive. */
function daysInclusive(from: string, to: string): number {
  const dFrom = parseUtcNoonDate(from).getTime();
  const dTo = parseUtcNoonDate(to).getTime();
  return Math.max(0, Math.floor((dTo - dFrom) / MS_PER_DAY) + 1);
}

/** Return the Monday of the ISO week for an ISO date or datetime string. */
function isoWeekMonday(dateStr: string): string {
  const d = parseUtcNoonDate(dateStr);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  // ISO: Monday = day 1. shift: Sun(0)→-6, Mon(1)→0, ... Sat(6)→5
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function filterMeals(
  meals: readonly MealRecord[],
  userId: string,
  dateFrom: string,
  dateTo: string,
): MealRecord[] {
  return meals.filter(
    (m) =>
      m.userId === userId &&
      m.loggedAt.slice(0, 10) >= dateFrom &&
      m.loggedAt.slice(0, 10) <= dateTo,
  );
}

function round1dp(value: number): number {
  return Math.round(value * 10) / 10;
}

interface MealAggregate {
  totalKcal: number;
  totalProteinG: number;
  totalFatG: number;
  totalCarbsG: number;
  count: number;
}

function sumMeals(meals: readonly MealRecord[]): MealAggregate {
  return meals.reduce<MealAggregate>(
    (acc, m) => ({
      totalKcal: acc.totalKcal + m.kcal,
      totalProteinG: acc.totalProteinG + m.proteinG,
      totalFatG: acc.totalFatG + m.fatG,
      totalCarbsG: acc.totalCarbsG + m.carbsG,
      count: acc.count + 1,
    }),
    { totalKcal: 0, totalProteinG: 0, totalFatG: 0, totalCarbsG: 0, count: 0 },
  );
}

function sumMealGroups(groups: Iterable<readonly MealRecord[]>): MealAggregate {
  let aggregate: MealAggregate = {
    totalKcal: 0,
    totalProteinG: 0,
    totalFatG: 0,
    totalCarbsG: 0,
    count: 0,
  };

  for (const group of groups) {
    const groupAggregate = sumMeals(group);
    aggregate = {
      totalKcal: aggregate.totalKcal + groupAggregate.totalKcal,
      totalProteinG: aggregate.totalProteinG + groupAggregate.totalProteinG,
      totalFatG: aggregate.totalFatG + groupAggregate.totalFatG,
      totalCarbsG: aggregate.totalCarbsG + groupAggregate.totalCarbsG,
      count: aggregate.count + groupAggregate.count,
    };
  }

  return aggregate;
}

function groupMealsBy(
  meals: readonly MealRecord[],
  keyForMeal: (meal: MealRecord) => string,
): Map<string, MealRecord[]> {
  const grouped = new Map<string, MealRecord[]>();
  for (const meal of meals) {
    const key = keyForMeal(meal);
    const group = grouped.get(key);
    if (group) {
      group.push(meal);
    } else {
      grouped.set(key, [meal]);
    }
  }

  return grouped;
}

function mealTotalsRow(agg: MealAggregate): Record<string, number> {
  return {
    total_kcal: round1dp(agg.totalKcal),
    total_protein_g: round1dp(agg.totalProteinG),
    total_fat_g: round1dp(agg.totalFatG),
    total_carbs_g: round1dp(agg.totalCarbsG),
  };
}

function makeObservation(
  templateId: string,
  columns: readonly ColumnDef[],
  rows: Record<string, unknown>[],
): Observation {
  return {
    templateId,
    columns,
    rows,
    rowCount: rows.length,
    truncated: false,
  };
}

// ── per-template handlers ────────────────────────────────────────────────

function runFoodLookup(
  catalog: Catalog,
  params: Record<string, unknown>,
): Observation {
  const foodId = String(params.food_id);
  const portionG =
    typeof params.portion_g === "number" && params.portion_g > 0
      ? params.portion_g
      : DEFAULT_PORTION_G;

  const food = catalog.allFoods.find((f) => f.id === foodId);
  if (!food) {
    throw new Error(`Food not found in catalog: ${foodId}`);
  }

  const scale = portionG / 100;
  const round = (per100gValue: number) => round1dp(per100gValue * scale);

  return makeObservation(
    FOOD_LOOKUP_TEMPLATE_ID,
    FOOD_LOOKUP_TEMPLATE.resultSchema,
    [
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
  );
}

function runMealSummary(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byType = groupMealsBy(filtered, (meal) => meal.mealType);

  const rows = MEAL_TYPE_ORDER.flatMap((mealType) => {
    const mealsForType = byType.get(mealType);
    if (!mealsForType) {
      return [];
    }

    const agg = sumMeals(mealsForType);
    return [
      {
        meal_type: mealType,
        meal_count: agg.count,
        ...mealTotalsRow(agg),
      },
    ];
  });

  return makeObservation(
    MEAL_SUMMARY_TEMPLATE.id,
    MEAL_SUMMARY_TEMPLATE.resultSchema,
    rows,
  );
}

function runDailyTotals(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byDate = groupMealsBy(filtered, (meal) => dateKey(meal.loggedAt));

  const sortedDates = [...byDate.keys()].sort();
  const rows = sortedDates.map((date) => {
    const agg = sumMeals(byDate.get(date)!);
    return {
      date,
      ...mealTotalsRow(agg),
      meal_count: agg.count,
    };
  });

  return makeObservation(
    DAILY_TOTALS_TEMPLATE.id,
    DAILY_TOTALS_TEMPLATE.resultSchema,
    rows,
  );
}

function runWeeklyTotals(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byWeek = new Map<string, { meals: MealRecord[]; days: Set<string> }>();
  for (const meal of filtered) {
    const weekMonday = isoWeekMonday(meal.loggedAt);
    const entry = byWeek.get(weekMonday) ?? { meals: [], days: new Set() };
    entry.meals.push(meal);
    entry.days.add(dateKey(meal.loggedAt));
    byWeek.set(weekMonday, entry);
  }

  const sortedWeeks = [...byWeek.keys()].sort();
  const rows = sortedWeeks.map((weekStart) => {
    const entry = byWeek.get(weekStart)!;
    const agg = sumMeals(entry.meals);
    return {
      week_start: weekStart,
      ...mealTotalsRow(agg),
      meal_count: agg.count,
      day_count: entry.days.size,
    };
  });

  return makeObservation(
    WEEKLY_TOTALS_TEMPLATE.id,
    WEEKLY_TOTALS_TEMPLATE.resultSchema,
    rows,
  );
}

function runDailyAverage(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);
  const byDate = groupMealsBy(filtered, (meal) => dateKey(meal.loggedAt));
  const totals = sumMealGroups(byDate.values());
  const totalDays = daysInclusive(dateFrom, dateTo);

  return makeObservation(
    DAILY_AVERAGE_TEMPLATE.id,
    DAILY_AVERAGE_TEMPLATE.resultSchema,
    [
      {
        avg_kcal: round1dp(totals.totalKcal / totalDays),
        avg_protein_g: round1dp(totals.totalProteinG / totalDays),
        avg_fat_g: round1dp(totals.totalFatG / totalDays),
        avg_carbs_g: round1dp(totals.totalCarbsG / totalDays),
        days_with_meals: byDate.size,
        total_days: totalDays,
      },
    ],
  );
}

function computeRangeAvg(
  meals: readonly MealRecord[],
  userId: string,
  dateFrom: string,
  dateTo: string,
): {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  days: number;
} {
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);
  const totals = sumMeals(filtered);
  const totalDays = daysInclusive(dateFrom, dateTo);

  return {
    kcal: totalDays > 0 ? totals.totalKcal / totalDays : 0,
    proteinG: totalDays > 0 ? totals.totalProteinG / totalDays : 0,
    fatG: totalDays > 0 ? totals.totalFatG / totalDays : 0,
    carbsG: totalDays > 0 ? totals.totalCarbsG / totalDays : 0,
    days: totalDays,
  };
}

function runRangeComparison(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const r1From = String(params.range1_from);
  const r1To = String(params.range1_to);
  const r2From = String(params.range2_from);
  const r2To = String(params.range2_to);

  const r1 = computeRangeAvg(meals, userId, r1From, r1To);
  const r2 = computeRangeAvg(meals, userId, r2From, r2To);

  return makeObservation(
    RANGE_COMPARISON_TEMPLATE.id,
    RANGE_COMPARISON_TEMPLATE.resultSchema,
    [
      {
        range1_avg_kcal: round1dp(r1.kcal),
        range1_avg_protein_g: round1dp(r1.proteinG),
        range1_avg_fat_g: round1dp(r1.fatG),
        range1_avg_carbs_g: round1dp(r1.carbsG),
        range2_avg_kcal: round1dp(r2.kcal),
        range2_avg_protein_g: round1dp(r2.proteinG),
        range2_avg_fat_g: round1dp(r2.fatG),
        range2_avg_carbs_g: round1dp(r2.carbsG),
        diff_kcal: round1dp(r2.kcal - r1.kcal),
        diff_protein_g: round1dp(r2.proteinG - r1.proteinG),
        diff_fat_g: round1dp(r2.fatG - r1.fatG),
        diff_carbs_g: round1dp(r2.carbsG - r1.carbsG),
        range1_days: r1.days,
        range2_days: r2.days,
      },
    ],
  );
}

function nutrientValueFor(nutrient: string): (meal: MealRecord) => number {
  switch (nutrient) {
    case "kcal":
      return (meal) => meal.kcal;
    case "protein":
      return (meal) => meal.proteinG;
    case "fat":
      return (meal) => meal.fatG;
    default:
      return (meal) => meal.carbsG;
  }
}

function runTopKByNutrient(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const nutrient = String(params.nutrient);
  const k = Number(params.k);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byFood = groupMealsBy(filtered, (meal) => meal.foodName.toLowerCase());
  const nutrientValue = nutrientValueFor(nutrient);

  const entries = [...byFood.entries()]
    .map(([_key, foodMeals]) => {
      const agg = sumMeals(foodMeals);
      const totalPortionG = foodMeals.reduce(
        (sum, meal) => sum + meal.portionG,
        0,
      );
      const nutrientTotal = foodMeals.reduce(
        (sum, meal) => sum + nutrientValue(meal),
        0,
      );
      return {
        foodName: foodMeals[0].foodName,
        agg,
        totalPortionG,
        nutrientTotal,
      };
    })
    .sort((a, b) => b.nutrientTotal - a.nutrientTotal)
    .slice(0, k)
    .map((e, i) => ({
      rank: i + 1,
      food_name: e.foodName,
      total_kcal: round1dp(e.agg.totalKcal),
      total_protein_g: round1dp(e.agg.totalProteinG),
      total_fat_g: round1dp(e.agg.totalFatG),
      total_carbs_g: round1dp(e.agg.totalCarbsG),
      total_portion_g: round1dp(e.totalPortionG),
      meal_count: e.agg.count,
    }));

  return makeObservation(
    TOP_K_BY_NUTRIENT_TEMPLATE.id,
    TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema,
    entries,
  );
}

/**
 * Create an in-memory query runner for all seven reviewed templates.
 *
 * Templates 1 (food_lookup) resolves against the local Catalog. Templates
 * 2–7 aggregate meal-log data; when `meals` is undefined or empty the
 * results will be empty but structurally correct (zero rows / zero totals).
 *
 * In production a SQL-backed runner replaces this; the in-memory runner
 * serves M1 testing and CI (zero network, deterministic).
 */
export function createInMemoryQueryRunner(
  catalog: Catalog,
  meals?: readonly MealRecord[],
): QueryRunner {
  return async (
    templateId: string,
    params: Record<string, unknown>,
    userId: string,
  ) => {
    const effectiveMeals = meals ?? [];

    switch (templateId) {
      case TEMPLATE_IDS.food_lookup:
        return runFoodLookup(catalog, params);

      case TEMPLATE_IDS.meal_summary:
        return runMealSummary(effectiveMeals, userId, params);

      case TEMPLATE_IDS.daily_totals:
        return runDailyTotals(effectiveMeals, userId, params);

      case TEMPLATE_IDS.weekly_totals:
        return runWeeklyTotals(effectiveMeals, userId, params);

      case TEMPLATE_IDS.daily_average:
        return runDailyAverage(effectiveMeals, userId, params);

      case TEMPLATE_IDS.range_comparison:
        return runRangeComparison(effectiveMeals, userId, params);

      case TEMPLATE_IDS.top_k_by_nutrient:
        return runTopKByNutrient(effectiveMeals, userId, params);

      default:
        throw new Error(`Unknown template: ${templateId}`);
    }
  };
}
