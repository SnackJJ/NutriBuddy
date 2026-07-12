import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseQueryRunner } from "../src/lib/sqlQueryRunner";
import { createCatalog, SEED_FOODS } from "../src/catalog/catalog";
import {
  MAX_OBSERVATION_ROWS,
  DAILY_TOTALS_TEMPLATE,
} from "../src/catalog/queryCatalog";

const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

interface RpcCall {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

function fakeRpcClient(result: {
  data: unknown[] | null;
  error: { message: string } | null;
}): { client: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(result);
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const catalog = createCatalog(SEED_FOODS);

describe("createSupabaseQueryRunner (issue #64)", () => {
  it.each([
    ["meal_summary", "query_meal_summary", { date_from: "2026-07-01", date_to: "2026-07-07" }],
    ["daily_totals", "query_daily_totals", { date_from: "2026-07-01", date_to: "2026-07-07" }],
    ["weekly_totals", "query_weekly_totals", { date_from: "2026-07-01", date_to: "2026-07-14" }],
    ["daily_average", "query_daily_average", { date_from: "2026-07-01", date_to: "2026-07-07" }],
    [
      "range_comparison",
      "query_range_comparison",
      {
        range1_from: "2026-06-24",
        range1_to: "2026-06-30",
        range2_from: "2026-07-01",
        range2_to: "2026-07-07",
      },
    ],
    [
      "top_k_by_nutrient",
      "query_top_k_by_nutrient",
      { date_from: "2026-07-01", date_to: "2026-07-07", nutrient: "protein", k: 5 },
    ],
  ])(
    "%s calls %s with template params and never a user id",
    async (templateId, expectedFn, params) => {
      const { client, calls } = fakeRpcClient({ data: [], error: null });
      const runner = createSupabaseQueryRunner(client, catalog);

      const observation = await runner(templateId, params, TEST_USER);

      expect(calls).toHaveLength(1);
      expect(calls[0].fn).toBe(expectedFn);
      expect(calls[0].args).toEqual(params);
      // Identity binds via auth.uid() in SQL — the runner must not send it
      expect(JSON.stringify(calls[0].args)).not.toContain(TEST_USER);
      expect(observation.templateId).toBe(templateId);
      expect(observation.rows).toEqual([]);
      expect(observation.truncated).toBe(false);
    },
  );

  it("detects the SQL row cap sentinel row and sets truncated", async () => {
    const rows = Array.from({ length: MAX_OBSERVATION_ROWS + 1 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      total_kcal: 100 + i,
    }));
    const { client } = fakeRpcClient({ data: rows, error: null });
    const runner = createSupabaseQueryRunner(client, catalog);

    const observation = await runner(
      "daily_totals",
      { date_from: "2026-06-01", date_to: "2026-06-30" },
      TEST_USER,
    );

    expect(observation.truncated).toBe(true);
    expect(observation.rows).toHaveLength(MAX_OBSERVATION_ROWS);
    expect(observation.rowCount).toBe(MAX_OBSERVATION_ROWS);
    expect(observation.columns).toBe(DAILY_TOTALS_TEMPLATE.resultSchema);
  });

  it("delegates food_lookup to the in-process catalog without touching SQL", async () => {
    const { client, calls } = fakeRpcClient({ data: [], error: null });
    const runner = createSupabaseQueryRunner(client, catalog);

    const observation = await runner(
      "food_lookup",
      { food_id: "food-shrimp-001", portion_g: 100 },
      TEST_USER,
    );

    expect(calls).toHaveLength(0);
    expect(observation.rows[0].food_name).toBe("shrimp");
  });

  it("fails loud on an RPC error, naming the template", async () => {
    const { client } = fakeRpcClient({
      data: null,
      error: { message: "statement timeout" },
    });
    const runner = createSupabaseQueryRunner(client, catalog);

    await expect(
      runner(
        "daily_totals",
        { date_from: "2026-07-01", date_to: "2026-07-07" },
        TEST_USER,
      ),
    ).rejects.toThrow(/daily_totals failed: statement timeout/);
  });

  it("rejects unknown template ids", async () => {
    const { client } = fakeRpcClient({ data: [], error: null });
    const runner = createSupabaseQueryRunner(client, catalog);

    await expect(runner("drop_tables", {}, TEST_USER)).rejects.toThrow(
      /Unknown template/,
    );
  });
});
