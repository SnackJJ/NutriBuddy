// get_food_nutrition：根据食物名称 + 份量返回营养数据（issue #12 占位接口）。
//
// ⚠ DEPRECATED — superseded by the local catalog + resolver (issue #42).
//
// This stub is kept for backward compat in tests that exercise the log_meal
// tool without wiring a full catalog. New runtime code should use the typed
// query catalog (food_lookup template) against the local catalog, never this
// stub or the USDA API directly.
//
// The USDA FoodData Central client (src/lib/usda.ts) is now an offline
// ingestion adapter; mapToCatalogFood + ingestFoods produce CatalogFood
// entries consumed by the resolver at runtime. No runtime code calls USDA.
//
// 数据来源：USDA FoodData Central (SR Legacy)，每 100g 数值。

/** 单种食物的营养数据（已按指定份量计算）。 */
export interface NutritionData {
  readonly foodName: string;
  readonly portionG: number;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
  /** 数据来源标识（如 "USDA FoodData Central"）。 */
  readonly source: string;
}

/** 获取营养数据的函数签名。可注入 log_meal / 单测。 */
export type GetFoodNutrition = (
  foodName: string,
  portionG: number,
) => Promise<NutritionData>;

// ─── 内置 stub（每 100g 营养值，issue #12 会替换为 USDA API）──────────────

interface NutritionPer100g {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

const STUB_DB = new Map<string, NutritionPer100g>([
  // ── 肉类 ──
  ["chicken breast", { kcal: 165, protein: 31, fat: 3.6, carbs: 0 }],
  ["chicken thigh", { kcal: 209, protein: 26, fat: 11, carbs: 0 }],
  ["chicken", { kcal: 239, protein: 27, fat: 14, carbs: 0 }],
  ["beef", { kcal: 250, protein: 26, fat: 15, carbs: 0 }],
  ["beef steak", { kcal: 271, protein: 25, fat: 19, carbs: 0 }],
  ["pork", { kcal: 242, protein: 27, fat: 14, carbs: 0 }],
  ["pork chop", { kcal: 231, protein: 25, fat: 14, carbs: 0 }],
  ["turkey breast", { kcal: 135, protein: 30, fat: 0.7, carbs: 0 }],
  // ── 鱼类 ──
  ["salmon", { kcal: 208, protein: 20, fat: 13, carbs: 0 }],
  ["tuna", { kcal: 132, protein: 28, fat: 1.3, carbs: 0 }],
  ["shrimp", { kcal: 85, protein: 20, fat: 0.5, carbs: 0 }],
  ["cod", { kcal: 82, protein: 18, fat: 0.7, carbs: 0 }],
  // ── 谷物 / 主食 ──
  ["rice", { kcal: 130, protein: 2.7, fat: 0.3, carbs: 28 }],
  ["white rice", { kcal: 130, protein: 2.7, fat: 0.3, carbs: 28 }],
  ["brown rice", { kcal: 123, protein: 2.7, fat: 1, carbs: 26 }],
  ["bread", { kcal: 265, protein: 9, fat: 3.2, carbs: 49 }],
  ["white bread", { kcal: 265, protein: 9, fat: 3.2, carbs: 49 }],
  ["whole wheat bread", { kcal: 247, protein: 13, fat: 3.4, carbs: 41 }],
  ["pasta", { kcal: 131, protein: 5, fat: 1.1, carbs: 25 }],
  ["oatmeal", { kcal: 71, protein: 2.5, fat: 1.5, carbs: 12 }],
  ["noodles", { kcal: 138, protein: 4.5, fat: 2.1, carbs: 25 }],
  // ── 蔬菜 ──
  ["broccoli", { kcal: 34, protein: 2.8, fat: 0.4, carbs: 7 }],
  ["spinach", { kcal: 23, protein: 2.9, fat: 0.4, carbs: 3.6 }],
  ["carrot", { kcal: 41, protein: 0.9, fat: 0.2, carbs: 10 }],
  ["tomato", { kcal: 18, protein: 0.9, fat: 0.2, carbs: 3.9 }],
  ["potato", { kcal: 77, protein: 2, fat: 0.1, carbs: 17 }],
  ["sweet potato", { kcal: 86, protein: 1.6, fat: 0.1, carbs: 20 }],
  ["lettuce", { kcal: 15, protein: 1.4, fat: 0.2, carbs: 2.9 }],
  // ── 蛋奶 ──
  ["egg", { kcal: 155, protein: 13, fat: 11, carbs: 1.1 }],
  ["milk", { kcal: 61, protein: 3.2, fat: 3.3, carbs: 4.8 }],
  ["whole milk", { kcal: 61, protein: 3.2, fat: 3.3, carbs: 4.8 }],
  ["skim milk", { kcal: 34, protein: 3.4, fat: 0.1, carbs: 5 }],
  ["cheese", { kcal: 402, protein: 25, fat: 33, carbs: 1.3 }],
  ["yogurt", { kcal: 63, protein: 5.3, fat: 1.6, carbs: 7 }],
  ["greek yogurt", { kcal: 97, protein: 9, fat: 5, carbs: 3.6 }],
  // ── 水果 ──
  ["banana", { kcal: 89, protein: 1.1, fat: 0.3, carbs: 23 }],
  ["apple", { kcal: 52, protein: 0.3, fat: 0.2, carbs: 14 }],
  ["orange", { kcal: 47, protein: 0.9, fat: 0.1, carbs: 12 }],
  ["strawberry", { kcal: 32, protein: 0.7, fat: 0.3, carbs: 7.7 }],
  ["blueberry", { kcal: 57, protein: 0.7, fat: 0.3, carbs: 14 }],
  // ── 豆类 / 坚果 ──
  ["tofu", { kcal: 76, protein: 8, fat: 4.8, carbs: 1.9 }],
  ["peanut butter", { kcal: 588, protein: 25, fat: 50, carbs: 20 }],
  ["almond", { kcal: 579, protein: 21, fat: 50, carbs: 22 }],
  ["walnut", { kcal: 654, protein: 15, fat: 65, carbs: 14 }],
  // ── 饮品 ──
  ["orange juice", { kcal: 45, protein: 0.7, fat: 0.2, carbs: 10 }],
  ["coffee", { kcal: 2, protein: 0.1, fat: 0, carbs: 0 }],
]);

/** 归一食物名：去首尾空白 + 全小写，提高匹配率。 */
function normalizeFood(food: string): string {
  return food.trim().toLowerCase();
}

/**
 * 查找内置 stub 食物营养，按份量线性缩放。
 * 未命中时拋 Error 提示该食物暂不支持（issue #12 USDA API 上线后会大幅扩展）。
 */
async function stubGetFoodNutrition(
  foodName: string,
  portionG: number,
): Promise<NutritionData> {
  const key = normalizeFood(foodName);
  const per100 = STUB_DB.get(key);
  if (!per100) {
    throw new Error(
      `Nutrition data not found for "${foodName}". ` +
        "Try a more specific name (e.g. 'chicken breast' instead of 'chicken'), " +
        "or check the food is in the built-in database.",
    );
  }

  const scale = portionG / 100;
  const round = (v: number) => Math.round(v * scale * 10) / 10;

  return {
    foodName: key,
    portionG,
    kcal: round(per100.kcal),
    proteinG: round(per100.protein),
    fatG: round(per100.fat),
    carbsG: round(per100.carbs),
    source: "USDA FoodData Central (built-in stub)",
  };
}

/** 创建 get_food_nutrition 函数。当前为内置 stub；issue #12 将换为 USDA API。 */
export function createGetFoodNutrition(): GetFoodNutrition {
  return stubGetFoodNutrition;
}
