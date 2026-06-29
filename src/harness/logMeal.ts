// log_meal 工具处理器（issue #14 / PRD v2 §3.1「ToolRegistry」）。
//
// 记录用户的一餐到 Supabase：接受食物名称 + 份量 + 用餐时间，调用
// get_food_nutrition 获取营养数据，存入 meal_logs 表，返回确认消息 + 营养摘要。
//
// 所有副作用依赖（营养查询 / 存储）皆可注入，单测不触网。

import type { ToolHandler } from "./types";
import type { GetFoodNutrition } from "./foodNutrition";

// ─── 常量 ─────────────────────────────────────────────────────────────────

const VALID_MEAL_TYPES = new Set([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
]);

const DEFAULT_MEAL_TYPE = "snack";

// ─── 存储端口 ─────────────────────────────────────────────────────────────

/** 一条已持久化的饮食记录。 */
export interface MealLogEntry {
  readonly id: number;
  readonly userId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly loggedAt: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
}

/** 插入餐食记录所需的参数（不含 id / loggedAt，由 store 生成）。 */
export interface MealLogInsert {
  readonly userId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
}

/** 餐食存储端口。可注入 Supabase 实现或单测 mock。 */
export interface MealLogStore {
  insert(params: MealLogInsert): Promise<MealLogEntry>;
}

// ─── 工具依赖 ─────────────────────────────────────────────────────────────

export interface LogMealDeps {
  /** 营养数据查询（可注入内置 stub 或 USDA API）。 */
  readonly getFoodNutrition: GetFoodNutrition;
  /** 餐食持久化存储。 */
  readonly mealLogStore: MealLogStore;
  /** 当前用户 ID（由调用方注入，不暴露给模型）。 */
  readonly userId: string;
}

// ─── 参数校验 ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
}

function parseArgs(args: Readonly<Record<string, unknown>>): ParsedArgs | string {
  const foodName = args.food_name;
  if (typeof foodName !== "string" || foodName.trim().length === 0) {
    return "missing or invalid food_name: must be a non-empty string";
  }

  const portionG = args.portion_g;
  if (typeof portionG !== "number" || !Number.isFinite(portionG) || portionG <= 0) {
    return "missing or invalid portion_g: must be a positive number (grams)";
  }

  let mealType = DEFAULT_MEAL_TYPE;
  if (args.meal_type !== undefined) {
    if (typeof args.meal_type !== "string" || !VALID_MEAL_TYPES.has(args.meal_type)) {
      return (
        `invalid meal_type "${String(args.meal_type)}": ` +
        `must be one of ${[...VALID_MEAL_TYPES].join(", ")}`
      );
    }
    mealType = args.meal_type;
  }

  return { foodName: foodName.trim(), portionG, mealType };
}

// ─── 响应构建 ─────────────────────────────────────────────────────────────

function successResponse(entry: MealLogEntry): string {
  return JSON.stringify({
    success: true,
    message: `Logged ${entry.portionG}g ${entry.foodName} for ${entry.mealType}.`,
    meal: {
      id: entry.id,
      food_name: entry.foodName,
      portion_g: entry.portionG,
      meal_type: entry.mealType,
      logged_at: entry.loggedAt,
      nutrition: {
        kcal: entry.kcal,
        protein_g: entry.proteinG,
        fat_g: entry.fatG,
        carbs_g: entry.carbsG,
      },
    },
    nutrition_summary: {
      kcal: entry.kcal,
      protein_g: entry.proteinG,
      fat_g: entry.fatG,
      carbs_g: entry.carbsG,
    },
  });
}

function errorResponse(message: string): string {
  return JSON.stringify({ error: message });
}

// ─── OpenAI Function-Calling Schema ────────────────────────────────────────

/** log_meal 的 OpenAI function-calling 工具定义。 */
export const LOG_MEAL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "log_meal",
    description:
      "Log a meal to the user's food diary. Provide food name, portion in grams, " +
      "and meal type (breakfast/lunch/dinner/snack). The tool automatically looks up " +
      "USDA nutrition data and stores the entry. Returns a confirmation message with " +
      "a nutrition summary (kcal, protein, fat, carbs).",
    parameters: {
      type: "object" as const,
      properties: {
        food_name: {
          type: "string",
          description:
            "Food name in English, e.g. 'chicken breast', 'rice', 'apple'. " +
            "For ambiguous food descriptions, call normalize_food first.",
        },
        portion_g: {
          type: "number",
          description: "Portion size in grams, must be > 0. E.g. 200 for 200g.",
        },
        meal_type: {
          type: "string",
          enum: ["breakfast", "lunch", "dinner", "snack"],
          description:
            "Meal type. Defaults to 'snack' if omitted.",
        },
      },
      required: ["food_name", "portion_g"],
    },
  },
};

// ─── 工具工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 log_meal 工具处理器。
 *
 * 返回的 ToolHandler 可注入 loop 的 tools Map：
 *   tools.set("log_meal", createLogMealHandler({ getFoodNutrition, mealLogStore, userId: "..." }))
 *
 * 模型调用格式：
 *   { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" }
 *
 * 返回 JSON 字符串（成功带营养摘要，失败带 error）。
 *
 * 对应的 function-calling schema 导出为 LOG_MEAL_SCHEMA。
 */
export function createLogMealHandler(deps: LogMealDeps): ToolHandler {
  const { getFoodNutrition, mealLogStore, userId } = deps;

  return async (args: Readonly<Record<string, unknown>>): Promise<string> => {
    try {
      const parsed = parseArgs(args);
      if (typeof parsed === "string") {
        return errorResponse(parsed);
      }

      let nutrition;
      try {
        nutrition = await getFoodNutrition(parsed.foodName, parsed.portionG);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`nutrition lookup failed: ${message}`);
      }

      const entry = await mealLogStore.insert({
        userId,
        foodName: nutrition.foodName,
        portionG: nutrition.portionG,
        mealType: parsed.mealType,
        kcal: nutrition.kcal,
        proteinG: nutrition.proteinG,
        fatG: nutrition.fatG,
        carbsG: nutrition.carbsG,
      });

      return successResponse(entry);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(`failed to log meal: ${message}`);
    }
  };
}
