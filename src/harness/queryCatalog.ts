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
} from "../catalog/queryCatalog";
import {
  executeQuery,
  FOOD_LOOKUP_TEMPLATE,
  renderObservationText,
} from "../catalog/queryCatalog";
import type { Catalog } from "../catalog/catalog";
import type { Tracer } from "./tracer";

// ─── 常量 ─────────────────────────────────────────────────────────────────

export const QUERY_CATALOG_TOOL = "query_catalog";
const FOOD_LOOKUP_TEMPLATE_ID = FOOD_LOOKUP_TEMPLATE.id;
const DEFAULT_PORTION_G = 100;

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
    observation,
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

export function createInMemoryQueryRunner(catalog: Catalog): QueryRunner {
  return async (
    templateId: string,
    params: Record<string, unknown>,
    _userId: string,
  ) => {
    if (templateId !== FOOD_LOOKUP_TEMPLATE_ID) {
      // executeQuery already validates the template exists, so this is a
      // defensive guard for runner-internal dispatch.
      throw new Error(`Unknown template: ${templateId}`);
    }

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
    const round = (per100gValue: number) =>
      Math.round(per100gValue * scale * 10) / 10;

    return {
      templateId: FOOD_LOOKUP_TEMPLATE_ID,
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
