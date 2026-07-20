// query_catalog tool handler (issue #46 / PRD v2 §3.2 / ADD Phase 1).
// Structural Phase 5: template SQL / in-memory runner live in src/catalog;
// this module only owns the agent tool boundary (schema + ToolOutcome mapping).

import type { ToolHandler, ToolSchema } from "./types";
import type {
  Observation,
  QueryCatalog,
  QueryRunner,
  RenderedObservation,
} from "../catalog/queryCatalog";
import {
  executeQuery,
  renderObservationText,
} from "../catalog/queryCatalog";
import { FoodNotFoundError } from "../catalog/inMemoryQueryRunner";
import type { Tracer } from "./tracer";
import type { HandlerOutcome, JsonValue } from "./toolOutcome";

// ─── Constants ────────────────────────────────────────────────────────────

export const QUERY_CATALOG_TOOL = "query_catalog";

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

// ─── Dependency injection ─────────────────────────────────────────────────

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

function errorResponse(
  templateId: string,
  message: string,
  availableTemplates: readonly string[] = [],
): HandlerOutcome {
  const data: JsonValue = {
    type: "error",
    templateId,
    message,
    availableTemplates: [...availableTemplates],
  };
  return { kind: "typed_error", message, data };
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

function observationOutcome(
  observation: Observation,
  rendered: RenderedObservation,
): HandlerOutcome {
  const capped = capObservationForModel(observation, rendered);
  const data: JsonValue = {
    type: "observation",
    text: rendered.text,
    observation: capped as unknown as JsonValue,
  };
  return { kind: "ok", data, observation: capped };
}

// ─── Tool factory ─────────────────────────────────────────────────────────

/**
 * Create the query_catalog tool handler.
 * Ground-truth templates + runners live in `src/catalog` (Phase 5).
 */
export function createQueryCatalogHandler(
  deps: QueryCatalogHandlerDeps,
): ToolHandler {
  const { queryCatalog, runner, userId, tracer } = deps;
  const available = queryCatalog.templateList.map((t) => t.id);

  return async (
    args: Readonly<Record<string, unknown>>,
  ): Promise<HandlerOutcome> => {
    const templateId = args.template_id;
    if (typeof templateId !== "string" || templateId.trim().length === 0) {
      return errorResponse(
        typeof templateId === "string" ? templateId : "",
        "Missing or invalid template_id: must be a non-empty string. " +
          "Available templates: " +
          availableTemplateText(queryCatalog),
        available,
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
        return observationOutcome(result.observation, rendered);
      }

      return {
        kind: "typed_error",
        message: result.message,
        data: {
          type: "error",
          templateId: result.templateId,
          message: result.message,
          availableTemplates: [...result.availableTemplates],
        },
      };
    } catch (err: unknown) {
      if (err instanceof FoodNotFoundError) {
        return errorResponse(templateId, err.message, available);
      }
      throw err;
    }
  };
}

/** @deprecated Prefer `import { createInMemoryQueryRunner } from "../catalog"` */
export { createInMemoryQueryRunner, FoodNotFoundError } from "../catalog/inMemoryQueryRunner";
