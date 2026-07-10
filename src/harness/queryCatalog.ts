// query_catalog 工具处理器（issue #46 / PRD v2 §3.2 / ADD Phase 1）。
//
// The model selects a reviewed template and supplies typed params; deterministic
// code validates and executes the template, then returns unit-bearing
// observations. Nutrition numbers come from observations, not model arithmetic.

import type { ToolHandler, ToolSchema } from "./types";
import type {
  QueryCatalog,
  QueryResult,
  QueryRunner,
  Observation,
  MealRecord,
} from "../catalog/queryCatalog";
import {
  executeQuery,
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
} from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";

// ─── 常量 ─────────────────────────────────────────────────────────────────

export const QUERY_CATALOG_TOOL = "query_catalog";
const FOOD_LOOKUP_TEMPLATE_ID = FOOD_LOOKUP_TEMPLATE.id;
const DEFAULT_PORTION_G = 100;

const TEMPLATE_IDS = {
  food_lookup: FOOD_LOOKUP_TEMPLATE_ID,
  meal_summary: MEAL_SUMMARY_TEMPLATE.id,
  daily_totals: DAILY_TOTALS_TEMPLATE.id,
  weekly_totals: WEEKLY_TOTALS_TEMPLATE.id,
  daily_average: DAILY_AVERAGE_TEMPLATE.id,
  range_comparison: RANGE_COMPARISON_TEMPLATE.id,
  top_k_by_nutrient: TOP_K_BY_NUTRIENT_TEMPLATE.id,
} as const;

const KNOWN_TEMPLATE_IDS = new Set(Object.values(TEMPLATE_IDS));

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
  const { queryCatalog, runner, userId } = deps;

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
      return JSON.stringify(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(templateId, `Query execution failed: ${message}`);
    }
  };
}

// ─── In-Memory Query Runner ────────────────────────────────────────────────

// ── helpers ──────────────────────────────────────────────────────────────

function round1dp(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Parse an ISO 8601 date or datetime string to a Date at noon UTC. */
function parseDate(dateStr: string): Date {
  // If already a full datetime, extract just the date portion
  const datePart = dateStr.slice(0, 10);
  return new Date(datePart + "T12:00:00Z");
}

/** Return the date portion of an ISO 8601 string as YYYY-MM-DD. */
function dateKey(isoStr: string): string {
  return isoStr.slice(0, 10);
}

/** Count calendar days between two YYYY-MM-DD dates, inclusive. */
function daysInclusive(from: string, to: string): number {
  const msPerDay = 86_400_000;
  const dFrom = parseDate(from).getTime();
  const dTo = parseDate(to).getTime();
  return Math.max(0, Math.floor((dTo - dFrom) / msPerDay) + 1);
}

/** Return the Monday of the ISO week for an ISO date or datetime string. */
function isoWeekMonday(dateStr: string): string {
  const d = parseDate(dateStr);
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

interface MealAggregate {
  totalKcal: number;
  totalProteinG: number;
  totalFatG: number;
  totalCarbsG: number;
  count: number;
}

function sumMeals(meals: MealRecord[]): MealAggregate {
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

function makeObservation(
  templateId: string,
  columns: ReadonlyArray<{
    name: string; type: "number" | "string" | "date" | "boolean";
    unit?: string; description: string;
  }>,
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

  return makeObservation(FOOD_LOOKUP_TEMPLATE_ID, FOOD_LOOKUP_TEMPLATE.resultSchema, [
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
  ]);
}

function runMealSummary(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byType = new Map<string, MealRecord[]>();
  for (const m of filtered) {
    const list = byType.get(m.mealType) ?? [];
    list.push(m);
    byType.set(m.mealType, list);
  }

  const mealTypes = ["breakfast", "lunch", "dinner", "snack"];
  const rows = mealTypes
    .filter((mt) => byType.has(mt))
    .map((mt) => {
      const agg = sumMeals(byType.get(mt)!);
      return {
        meal_type: mt,
        meal_count: agg.count,
        total_kcal: round1dp(agg.totalKcal),
        total_protein_g: round1dp(agg.totalProteinG),
        total_fat_g: round1dp(agg.totalFatG),
        total_carbs_g: round1dp(agg.totalCarbsG),
      };
    });

  return makeObservation(MEAL_SUMMARY_TEMPLATE.id, MEAL_SUMMARY_TEMPLATE.resultSchema, rows);
}

function runDailyTotals(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byDate = new Map<string, MealRecord[]>();
  for (const m of filtered) {
    const dk = dateKey(m.loggedAt);
    const list = byDate.get(dk) ?? [];
    list.push(m);
    byDate.set(dk, list);
  }

  const sortedDates = [...byDate.keys()].sort();
  const rows = sortedDates.map((d) => {
    const agg = sumMeals(byDate.get(d)!);
    return {
      date: d,
      total_kcal: round1dp(agg.totalKcal),
      total_protein_g: round1dp(agg.totalProteinG),
      total_fat_g: round1dp(agg.totalFatG),
      total_carbs_g: round1dp(agg.totalCarbsG),
      meal_count: agg.count,
    };
  });

  return makeObservation(DAILY_TOTALS_TEMPLATE.id, DAILY_TOTALS_TEMPLATE.resultSchema, rows);
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
  for (const m of filtered) {
    const weekMonday = isoWeekMonday(m.loggedAt);
    const entry = byWeek.get(weekMonday) ?? { meals: [], days: new Set() };
    entry.meals.push(m);
    entry.days.add(dateKey(m.loggedAt));
    byWeek.set(weekMonday, entry);
  }

  const sortedWeeks = [...byWeek.keys()].sort();
  const rows = sortedWeeks.map((w) => {
    const entry = byWeek.get(w)!;
    const agg = sumMeals(entry.meals);
    return {
      week_start: w,
      total_kcal: round1dp(agg.totalKcal),
      total_protein_g: round1dp(agg.totalProteinG),
      total_fat_g: round1dp(agg.totalFatG),
      total_carbs_g: round1dp(agg.totalCarbsG),
      meal_count: agg.count,
      day_count: entry.days.size,
    };
  });

  return makeObservation(WEEKLY_TOTALS_TEMPLATE.id, WEEKLY_TOTALS_TEMPLATE.resultSchema, rows);
}

function runDailyAverage(
  meals: readonly MealRecord[],
  userId: string,
  params: Record<string, unknown>,
): Observation {
  const dateFrom = String(params.date_from);
  const dateTo = String(params.date_to);
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);

  const byDate = new Map<string, MealRecord[]>();
  for (const m of filtered) {
    const dk = dateKey(m.loggedAt);
    const list = byDate.get(dk) ?? [];
    list.push(m);
    byDate.set(dk, list);
  }

  const totalDays = daysInclusive(dateFrom, dateTo);
  const daysWithMeals = byDate.size;

  let totalKcal = 0;
  let totalProteinG = 0;
  let totalFatG = 0;
  let totalCarbsG = 0;
  for (const mealsOfDay of byDate.values()) {
    for (const m of mealsOfDay) {
      totalKcal += m.kcal;
      totalProteinG += m.proteinG;
      totalFatG += m.fatG;
      totalCarbsG += m.carbsG;
    }
  }

  return makeObservation(DAILY_AVERAGE_TEMPLATE.id, DAILY_AVERAGE_TEMPLATE.resultSchema, [
    {
      avg_kcal: round1dp(totalKcal / totalDays),
      avg_protein_g: round1dp(totalProteinG / totalDays),
      avg_fat_g: round1dp(totalFatG / totalDays),
      avg_carbs_g: round1dp(totalCarbsG / totalDays),
      days_with_meals: daysWithMeals,
      total_days: totalDays,
    },
  ]);
}

function computeRangeAvg(
  meals: readonly MealRecord[],
  userId: string,
  dateFrom: string,
  dateTo: string,
): { kcal: number; proteinG: number; fatG: number; carbsG: number; days: number } {
  const filtered = filterMeals(meals, userId, dateFrom, dateTo);
  const totalDays = daysInclusive(dateFrom, dateTo);
  let kcal = 0;
  let proteinG = 0;
  let fatG = 0;
  let carbsG = 0;
  for (const m of filtered) {
    kcal += m.kcal;
    proteinG += m.proteinG;
    fatG += m.fatG;
    carbsG += m.carbsG;
  }
  return {
    kcal: totalDays > 0 ? kcal / totalDays : 0,
    proteinG: totalDays > 0 ? proteinG / totalDays : 0,
    fatG: totalDays > 0 ? fatG / totalDays : 0,
    carbsG: totalDays > 0 ? carbsG / totalDays : 0,
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

  return makeObservation(RANGE_COMPARISON_TEMPLATE.id, RANGE_COMPARISON_TEMPLATE.resultSchema, [
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
  ]);
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

  const byFood = new Map<string, { meals: MealRecord[] }>();
  for (const m of filtered) {
    const key = m.foodName.toLowerCase();
    const entry = byFood.get(key) ?? { meals: [] };
    entry.meals.push(m);
    byFood.set(key, entry);
  }

  const nutrientKey: (m: MealRecord) => number =
    nutrient === "kcal" ? ((m) => m.kcal) :
    nutrient === "protein" ? ((m) => m.proteinG) :
    nutrient === "fat" ? ((m) => m.fatG) :
    ((m) => m.carbsG);

  const entries = [...byFood.entries()]
    .map(([_key, entry]) => {
      const agg = sumMeals(entry.meals);
      const totalPortionG = entry.meals.reduce((s, m) => s + m.portionG, 0);
      const nutrientTotal = entry.meals.reduce((s, m) => s + nutrientKey(m), 0);
      return { foodName: entry.meals[0].foodName, agg, totalPortionG, nutrientTotal };
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

  return makeObservation(TOP_K_BY_NUTRIENT_TEMPLATE.id, TOP_K_BY_NUTRIENT_TEMPLATE.resultSchema, entries);
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
