// query_catalog 工具处理器（issue #46 / PRD v2 §3.2 / ADD Phase 1 / review §五 P0-3）。
//
// 将 reviewed query template catalog（当前仅 food_lookup）暴露为模型可调用的工具。
// 模型选择 template_id 并提供类型化参数；确定性代码校验参数、绑定用户身份、通过
// 注入的数据端口执行，返回 schema 声明的 observation（单位标注的数值列）。
//
// 营养数字来自 observations，不是模型算术。模板边界保证畸形查询不可表示。
//
// In-memory QueryRunner 在 M1 运行在本地 catalog 上（createInMemoryQueryRunner）；
// M2 的 SQL executor 替换为 Supabase SELECT-only 查询。

import type { ToolHandler, ToolSchema } from "./types";
import type { QueryCatalog, QueryRunner } from "../catalog/queryCatalog";
import { executeQuery, FOOD_LOOKUP_TEMPLATE } from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";

// ─── 常量 ─────────────────────────────────────────────────────────────────

export const QUERY_CATALOG_TOOL = "query_catalog";

// ─── OpenAI Function-Calling Schema ────────────────────────────────────────

/**
 * query_catalog 的 OpenAI function-calling 工具定义。
 *
 * 模型从 pinned region 的 [QUERY TEMPLATE CATALOG] 区段获知可用模板及参数；
 * `template_id` 是唯一必填字段，其余参数由模板自行声明。
 * Handler 层通过 executeQuery() 做模板级参数校验，因此此 schema 仅声明
 * template_id，不做额外约束。
 */
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

// ─── 响应构建 ─────────────────────────────────────────────────────────────

function errorResponse(templateId: string, message: string): string {
  return JSON.stringify({
    type: "error",
    templateId,
    message,
    availableTemplates: [],
  });
}

// ─── 工具工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 query_catalog 工具处理器。
 *
 * 依赖全部可注入以便单测不触网；对应的 function-calling schema 导出为
 * QUERY_CATALOG_SCHEMA。
 *
 * 处理器流程：
 *   1. 从 args 提取 template_id（必填）
 *   2. 剥离 template_id，余下作为模板参数
 *   3. 调用 executeQuery()（模板校验 → 参数校验 → runner 执行）
 *   4. 返回 QueryResult（observation 或 typed error）
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
          queryCatalog.templateList.map((t) => t.id).join(", "),
      );
    }

    // Strip template_id — remaining keys are template parameters
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key !== "template_id") {
        params[key] = value;
      }
    }

    try {
      const result = await executeQuery(
        queryCatalog,
        templateId,
        params,
        userId,
        runner,
      );
      return JSON.stringify(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(
        templateId,
        `Query execution failed: ${message}`,
      );
    }
  };
}

// ─── In-Memory Query Runner ────────────────────────────────────────────────

/**
 * Create an in-memory QueryRunner backed by the local food catalog.
 *
 * M1: runs against the in-process catalog — no network, no SQL.
 * M2: replaces with a Supabase SELECT-only SQL executor.
 *
 * Supports template ids:
 *   - "food_lookup": looks up a food by its catalog food_id, scales
 *     per-100g nutrition values to the requested portion_g (default 100g).
 *
 * @param catalog - the local food catalog (from createCatalog(SEED_FOODS))
 */
export function createInMemoryQueryRunner(catalog: Catalog): QueryRunner {
  return async (
    templateId: string,
    params: Record<string, unknown>,
    _userId: string,
  ) => {
    if (templateId !== "food_lookup") {
      // executeQuery already validates the template exists, so this is a
      // defensive guard for runner-internal dispatch.
      throw new Error(`Unknown template: ${templateId}`);
    }

    const foodId = String(params.food_id);
    const portionG =
      typeof params.portion_g === "number" && params.portion_g > 0
        ? params.portion_g
        : 100;

    const food = catalog.allFoods.find((f) => f.id === foodId);
    if (!food) {
      throw new Error(`Food not found in catalog: ${foodId}`);
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
