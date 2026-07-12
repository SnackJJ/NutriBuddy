// SQL-backed QueryRunner (issue #64 / ADD §Tools).
//
// Executes the reviewed query template functions from migration 0008 via
// Supabase RPC. The functions are SECURITY DEFINER owned by the SELECT-only
// role nutribuddy_query_ro, carry a per-function statement_timeout, and bind
// the user id inside SQL via auth.uid() — the runner never sends a user id,
// so neither the model nor this code can reference another user's rows.
// Pass the session-scoped client (issue #62) so auth.uid() resolves.
//
// food_lookup reads the in-process food catalog, not Postgres — it delegates
// to the in-memory runner.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Catalog } from "../catalog/catalog";
import {
  MAX_OBSERVATION_ROWS,
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
  type QueryRunner,
  type QueryTemplate,
} from "../catalog/queryCatalog";
import { createInMemoryQueryRunner } from "../harness/queryCatalog";

type RpcArgs = Record<string, string | number>;

interface SqlTemplateSpec {
  /** Postgres function name from migration 0008. */
  readonly fn: string;
  readonly template: QueryTemplate;
  /** Map validated template params to RPC arguments. Never includes a user id. */
  readonly args: (params: Record<string, unknown>) => RpcArgs;
}

function dateRangeArgs(params: Record<string, unknown>): RpcArgs {
  return {
    date_from: String(params.date_from),
    date_to: String(params.date_to),
  };
}

const SQL_TEMPLATES: Readonly<Record<string, SqlTemplateSpec>> = {
  [MEAL_SUMMARY_TEMPLATE.id]: {
    fn: "query_meal_summary",
    template: MEAL_SUMMARY_TEMPLATE,
    args: dateRangeArgs,
  },
  [DAILY_TOTALS_TEMPLATE.id]: {
    fn: "query_daily_totals",
    template: DAILY_TOTALS_TEMPLATE,
    args: dateRangeArgs,
  },
  [WEEKLY_TOTALS_TEMPLATE.id]: {
    fn: "query_weekly_totals",
    template: WEEKLY_TOTALS_TEMPLATE,
    args: dateRangeArgs,
  },
  [DAILY_AVERAGE_TEMPLATE.id]: {
    fn: "query_daily_average",
    template: DAILY_AVERAGE_TEMPLATE,
    args: dateRangeArgs,
  },
  [RANGE_COMPARISON_TEMPLATE.id]: {
    fn: "query_range_comparison",
    template: RANGE_COMPARISON_TEMPLATE,
    args: (params) => ({
      range1_from: String(params.range1_from),
      range1_to: String(params.range1_to),
      range2_from: String(params.range2_from),
      range2_to: String(params.range2_to),
    }),
  },
  [TOP_K_BY_NUTRIENT_TEMPLATE.id]: {
    fn: "query_top_k_by_nutrient",
    template: TOP_K_BY_NUTRIENT_TEMPLATE,
    args: (params) => ({
      ...dateRangeArgs(params),
      nutrient: String(params.nutrient),
      k: Number(params.k),
    }),
  },
};

/**
 * Production QueryRunner: reviewed SQL under the SELECT-only role.
 *
 * The row cap lives in SQL (LIMIT MAX_OBSERVATION_ROWS + 1); the extra
 * row is detected here, dropped, and surfaced as `truncated` on the
 * observation. The `userId` runner argument is intentionally unused —
 * identity binds from the session JWT inside SQL.
 */
export function createSupabaseQueryRunner(
  client: SupabaseClient,
  catalog: Catalog,
): QueryRunner {
  const memoryFallback = createInMemoryQueryRunner(catalog);

  return async (templateId, params, userId) => {
    if (templateId === FOOD_LOOKUP_TEMPLATE.id) {
      return memoryFallback(templateId, params, userId);
    }

    const spec = SQL_TEMPLATES[templateId];
    if (!spec) {
      throw new Error(`Unknown template: ${templateId}`);
    }

    const { data, error } = await client.rpc(spec.fn, spec.args(params));

    if (error) {
      throw new Error(
        `Query template ${templateId} failed: ${error.message}`,
      );
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    const truncated = rows.length > MAX_OBSERVATION_ROWS;
    const capped = truncated ? rows.slice(0, MAX_OBSERVATION_ROWS) : rows;

    return {
      templateId,
      columns: spec.template.resultSchema,
      rows: capped,
      rowCount: capped.length,
      truncated,
    };
  };
}
