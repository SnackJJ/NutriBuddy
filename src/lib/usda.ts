// USDA FoodData Central API client + get_food_nutrition tool (issue #12 / PRD §4)。
//
// UsdaClient：DI-friendly REST 客户端，遵循与 DeepSeekAdapter 相同的 DI 约定。
// 调用 USDA /fdc/v1/foods/search，把 14 种 USDA nutrient ID 映射到类型安全的
// FoodNutrition 结构，按调用方指定的 portion_g 缩放（以 100g 为基准）。
//
// createGetFoodNutritionTool：产出 ToolHandler，供 Loop 的 tools Map 使用。
// 成功返回 JSON-serialised FoodNutrition；失败返回可读错误字符串——绝不抛异常，
// 确保失败的工具调用不会把 Loop 拖垮。
//
// Schema：GET_FOOD_NUTRITION_SCHEMA 符合 OpenAI function-calling 格式。
//
// ── Ingestion adapter (issue #42 / ADD §Data Pipeline) ────────────────────────
//
// mapToCatalogFood maps a USDA FoodNutrition result into the canonical
// CatalogFood shape — the single nutrition data form the agent maintains
// regardless of source. Allergen tags are empty (fail-closed: untagged foods
// are loggable but never recommendable). Aliases are derived from the food
// description where possible.
//
// createCatalogSnapshot assembles a versioned snapshot envelope suitable for
// serialisation. The ingestion script (src/ingest/usda.ts) uses UsdaClient
// to fetch foods offline, maps them through this adapter, and writes the
// resulting catalog snapshot as JSON. The runtime never calls USDA.

import type { CatalogFood } from "../catalog/catalog";

const DEFAULT_BASE_URL = "https://api.nal.usda.gov/fdc/v1";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface UsdaClientOptions {
  /** 显式 key；缺省时从 env.USDA_API_KEY 读。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** 注入环境（测试用）；默认 process.env。 */
  readonly env?: Record<string, string | undefined>;
  /** 注入 fetch（测试用）；默认全局 fetch。 */
  readonly fetchImpl?: FetchImpl;
}

/** 结构化营养数据——M1 覆盖宏量 + 常见微量营养素。 */
export interface FoodNutrition {
  readonly food_name: string;
  readonly portion_g: number;
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly fiber_g: number;
  readonly sugars_g: number;
  readonly saturated_fat_g: number;
  readonly cholesterol_mg: number;
  readonly sodium_mg: number;
  readonly calcium_mg: number;
  readonly iron_mg: number;
  readonly potassium_mg: number;
  readonly vitamin_c_mg: number;
  readonly vitamin_d_mcg: number;
}

/** USDA nutrient ID → FoodNutrition 字段映射。只映射 M1 需要的 14 种。 */
const NUTRIENT_MAP: Record<number, keyof FoodNutrition> = {
  1008: "kcal", // Energy
  1003: "protein_g", // Protein
  1004: "fat_g", // Total lipid (fat)
  1005: "carbs_g", // Carbohydrate, by difference
  1079: "fiber_g", // Fiber, total dietary
  2000: "sugars_g", // Sugars, total including NLEA
  1258: "saturated_fat_g", // Fatty acids, total saturated
  1253: "cholesterol_mg", // Cholesterol
  1093: "sodium_mg", // Sodium, Na
  1087: "calcium_mg", // Calcium, Ca
  1089: "iron_mg", // Iron, Fe
  1092: "potassium_mg", // Potassium, K
  1162: "vitamin_c_mg", // Vitamin C, total ascorbic acid
  1114: "vitamin_d_mcg", // Vitamin D (D2 + D3)
};

interface UsdaSearchFood {
  description?: string;
  foodNutrients?: Array<{
    nutrientId?: number;
    value?: number | null;
  }>;
}

interface UsdaSearchResponse {
  foods?: UsdaSearchFood[];
}

function emptyFoodNutrition(
  food_name: string,
  portion_g: number,
): FoodNutrition {
  return {
    food_name,
    portion_g,
    kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    fiber_g: 0,
    sugars_g: 0,
    saturated_fat_g: 0,
    cholesterol_mg: 0,
    sodium_mg: 0,
    calcium_mg: 0,
    iron_mg: 0,
    potassium_mg: 0,
    vitamin_c_mg: 0,
    vitamin_d_mcg: 0,
  };
}

/**
 * USDA FoodData Central API client — OFFLINE INGESTION ONLY (issue #42).
 *
 * This client fetches nutrition data from USDA FoodData Central for ingestion.
 * It is NOT a runtime dependency: the runtime reads from the local catalog
 * produced by the ingestion pipeline (src/ingest/usda.ts).
 *
 * DI-friendly (injectable fetch + env) for deterministic testing.
 */
export class UsdaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: UsdaClientOptions = {}) {
    const env = options.env ?? process.env;
    const apiKey = options.apiKey ?? env.USDA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "缺少 USDA_API_KEY：请在环境变量中配置 USDA FoodData Central 密钥（参考 .env.local.example）。",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      env.USDA_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * 按食物名称查询营养数据。
   *
   * @param foodName - 食物名称（英文）
   * @param portionG - 食用份量（克），默认 100g；
   *   USDA 返回每 100g 值，本方法按 portionG/100 缩放。
   * @returns FoodNutrition 对象；未匹配到食物时返回 null。
   * @throws 网络或 API 错误时抛出。
   */
  async getFoodNutrition(
    foodName: string,
    portionG = 100,
  ): Promise<FoodNutrition | null> {
    const url = `${this.baseUrl}/foods/search?api_key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: foodName,
        dataType: ["Foundation", "SR Legacy"],
        pageSize: 5,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`USDA 请求失败 (${res.status}): ${detail}`);
    }

    let data: UsdaSearchResponse;
    try {
      data = (await res.json()) as UsdaSearchResponse;
    } catch (e) {
      throw new Error(`USDA 返回无法解析的响应: ${String(e)}`);
    }

    const foods = data.foods;
    if (!foods || foods.length === 0) {
      return null;
    }

    const food = foods[0];
    const foodNameResult = food.description ?? foodName;
    const scale = portionG / 100;
    const result = emptyFoodNutrition(foodNameResult, portionG);

    const nutrients = food.foodNutrients ?? [];
    for (const n of nutrients) {
      const id = n.nutrientId;
      if (id === undefined) continue;
      const field = NUTRIENT_MAP[id];
      if (!field) continue;
      const rawValue = n.value;
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) continue;
      // Cast through unknown: FoodNutrition → Record<string, number> for
      // dynamic key access (field keys are guaranteed by NUTRIENT_MAP).
      // eslint-disable-next-line
      (result as unknown as Record<string, number>)[field] = rawValue * scale;
    }

    return result;
  }
}

// --- Tool handler ---

/** ToolHandler —— Loop tools Map 兼容的最小接口（ToolRegistry #7 未完工前的占位）。 */
export interface ToolHandler {
  readonly schema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** get_food_nutrition 的 OpenAI function-calling schema。 */
export const GET_FOOD_NUTRITION_SCHEMA = {
  type: "function",
  function: {
    name: "get_food_nutrition",
    description:
      "查询食物的完整营养数据（宏量+微量营养素）。调用 USDA FoodData Central API，返回每份食物的营养成分，包括卡路里、蛋白质、脂肪、碳水、纤维、维生素和矿物质。",
    parameters: {
      type: "object",
      properties: {
        food_name: {
          type: "string",
          description:
            "食物名称（英文），例如 'apple'、'chicken breast'、'broccoli'",
        },
        portion_g: {
          type: "number",
          description:
            "食用份量（克），默认 100g。营养值以 100g 为基准，按份量等比缩放。",
        },
      },
      required: ["food_name"],
    },
  },
};

/**
 * ⚠ DEPRECATED — superseded by the local catalog + resolver (issue #42).
 *
 * Creates a get_food_nutrition tool handler that calls the USDA API.
 * This is kept for test backward compat only; runtime code should use the
 * typed query catalog (food_lookup template) against the local catalog.
 * The USDA client is now an offline ingestion adapter.
 *
 * 创建 get_food_nutrition 工具处理器。
 *
 * 返回的 ToolHandler 绝不抛异常——所有错误（输入校验、API 失败、无匹配）
 * 都转为可读的错误字符串，确保 Loop 不会因单次工具调用失败而崩溃。
 */
export function createGetFoodNutritionTool(client: UsdaClient): ToolHandler {
  return {
    schema: GET_FOOD_NUTRITION_SCHEMA,

    async execute(args: Record<string, unknown>): Promise<string> {
      const foodName = args.food_name;
      if (typeof foodName !== "string" || foodName.trim() === "") {
        return "错误：food_name 不能为空。请提供要查询的食物名称。";
      }

      let portionG = 100;
      if (args.portion_g !== undefined) {
        const p = Number(args.portion_g);
        if (!Number.isFinite(p) || p <= 0) {
          return "错误：portion_g 必须是正数。";
        }
        portionG = p;
      }

      const trimmedName = foodName.trim();
      try {
        const result = await client.getFoodNutrition(trimmedName, portionG);
        if (!result) {
          return `未找到匹配 "${trimmedName}" 的食物。请尝试更具体的名称。`;
        }
        return JSON.stringify(result);
      } catch (e) {
        return `USDA 查询失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

// ─── Snapshot ingestion adapter (issue #42 / ADD §Data Pipeline) ─────────────

/** Sanitise a food description into a stable, URL-safe id fragment. */
function sanitizeForId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Generate a stable catalog food ID from a food name and index. */
export function generateFoodId(name: string, index: number): string {
  const fragment = sanitizeForId(name);
  const padded = String(index).padStart(3, "0");
  return `food-usda-${fragment}-${padded}`;
}

/** Common food name normalisations for alias derivation. */
function deriveAliases(foodName: string): readonly string[] {
  const aliases: string[] = [];
  const lower = foodName.toLowerCase().trim();

  // Strip comma-separated qualifiers to produce shorter aliases.
  // e.g. "Apples, raw, with skin" → "apples raw", "apples"
  if (lower.includes(",")) {
    const parts = lower.split(",").map((p) => p.trim());
    if (parts[0]) {
      aliases.push(parts[0]);
    }
    // Two-part combo descriptions
    if (parts.length >= 2 && parts[0] && parts[1]) {
      aliases.push(`${parts[0]} ${parts[1]}`);
    }
  }

  return aliases;
}

/**
 * Map a USDA FoodNutrition result into the canonical CatalogFood shape.
 *
 * Allergen tags are empty (fail-closed): untagged foods are loggable but
 * never recommendable. Tag review happens separately; this adapter never
 * auto-tags allergens.
 *
 * @param food - the USDA FoodNutrition result (per-100g values)
 * @param index - position in the ingestion batch, for stable id generation
 * @param category - optional food category; defaults to "general"
 */
export function mapToCatalogFood(
  food: FoodNutrition,
  index: number,
  category = "general",
): CatalogFood {
  return {
    id: generateFoodId(food.food_name, index),
    canonicalName: food.food_name.toLowerCase(),
    aliases: deriveAliases(food.food_name),
    per100g: {
      kcal: food.kcal,
      proteinG: food.protein_g,
      fatG: food.fat_g,
      carbsG: food.carbs_g,
      fiberG: food.fiber_g,
      sugarsG: food.sugars_g,
      saturatedFatG: food.saturated_fat_g,
      cholesterolMg: food.cholesterol_mg,
      sodiumMg: food.sodium_mg,
      calciumMg: food.calcium_mg,
      ironMg: food.iron_mg,
      potassiumMg: food.potassium_mg,
      vitaminCMg: food.vitamin_c_mg,
      vitaminDMcg: food.vitamin_d_mcg,
    },
    allergenTags: [],
    portionAliases: {},
    category,
  };
}

/**
 * A versioned snapshot of ingested foods from USDA FoodData Central.
 * The version stamp flows into resolver results so traces reproduce
 * against their data (ADD §Data Pipeline).
 */
export interface CatalogSnapshot {
  /** Snapshot version stamp (ISO date-based). */
  readonly version: string;
  /** ISO 8601 timestamp of generation. */
  readonly generatedAt: string;
  /** Data source identifier. */
  readonly source: string;
  /** Ingested CatalogFood entries. */
  readonly foods: readonly CatalogFood[];
}

/** Create a versioned catalog snapshot from ingested food entries. */
export function createCatalogSnapshot(
  foods: readonly CatalogFood[],
  generatedAt: Date = new Date(),
): CatalogSnapshot {
  const dateStamp = generatedAt.toISOString().slice(0, 10);
  return {
    version: `usda-snapshot-${dateStamp}`,
    generatedAt: generatedAt.toISOString(),
    source: "USDA FoodData Central",
    foods,
  };
}
