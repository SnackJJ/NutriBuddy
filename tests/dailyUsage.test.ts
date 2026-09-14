// Daily usage aggregation tests (S3 / RFC 0010 §3.3 — issue #98).
//
// The fake client stands in for PostgREST the way tests/supabaseTraceStore.test.ts
// does: what is being asserted is the query the reader builds (one user's rows
// since the UTC day start, ordered by the same columns as the index) and how it
// adds up what comes back. What the real `turns` rows contain is migration
// 0011's business, and how the day is bounded in UTC is the gate's.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DailyUsageReadError,
  createSupabaseDailyUsageReader,
} from "../src/lib/dailyUsage";

interface RecordedQuery {
  readonly table: string;
  readonly columns: unknown;
  readonly options: unknown;
  readonly filters: ReadonlyArray<readonly [string, unknown]>;
  readonly orders: ReadonlyArray<readonly [string, unknown]>;
  readonly range: readonly [number, number];
}

interface FakeClient {
  readonly client: SupabaseClient;
  readonly queries: RecordedQuery[];
  pagesRead(): number;
}

/**
 * A PostgREST-shaped fake.
 *
 * `serverCap` is the project's `max_rows`: the fake returns at most that many
 * rows per request no matter what range was asked for, which is the situation a
 * reader that trusted a short page would get wrong.
 */
function fakeTurnsClient(input: {
  readonly rows: ReadonlyArray<{ cost_usd: unknown }>;
  readonly count?: number | null;
  readonly error?: { message: string } | null;
  readonly serverCap?: number;
  /** A client that ignores `range` entirely — see the non-convergence test. */
  readonly ignoreRange?: boolean;
}): FakeClient {
  const queries: RecordedQuery[] = [];
  const serverCap = input.serverCap ?? 1000;

  const client = {
    from(table: string) {
      const query = {
        table,
        columns: undefined as unknown,
        options: undefined as unknown,
        filters: [] as Array<readonly [string, unknown]>,
        orders: [] as Array<readonly [string, unknown]>,
        range: [0, 0] as readonly [number, number],
      };

      const builder = {
        select(columns: unknown, options: unknown) {
          query.columns = columns;
          query.options = options;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push([column, value]);
          return builder;
        },
        gte(column: string, value: unknown) {
          query.filters.push([column, value]);
          return builder;
        },
        order(column: string, options: unknown) {
          query.orders.push([column, options]);
          return builder;
        },
        range(from: number, to: number) {
          query.range = [from, to];
          queries.push(query);

          if (input.error) {
            return Promise.resolve({
              data: null,
              error: input.error,
              count: null,
            });
          }

          const requested = to - from + 1;
          const size = Math.min(requested, serverCap);
          const data = input.ignoreRange
            ? input.rows.slice(0, size)
            : input.rows.slice(from, from + size);
          const count =
            input.count === undefined ? input.rows.length : input.count;
          return Promise.resolve({ data, error: null, count });
        },
      };

      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, queries, pagesRead: () => queries.length };
}

const DAY_START = new Date("2026-07-26T00:00:00.000Z");

describe("createSupabaseDailyUsageReader (#98)", () => {
  it("counts the day's turns and sums their cost", async () => {
    const fake = fakeTurnsClient({
      rows: [{ cost_usd: "0.0012" }, { cost_usd: 0.003 }, { cost_usd: 0.0005 }],
    });
    const usage = await createSupabaseDailyUsageReader(
      fake.client,
    ).readDailyUsage("user-1", DAY_START);

    expect(usage.turns).toBe(3);
    expect(usage.costUsd).toBeCloseTo(0.0047, 10);
  });

  it("counts a turn whose cost is not known yet as one turn and zero dollars", async () => {
    // A running or crashed turn has a `turns` row and a NULL `cost_usd`: 0011
    // fills the cost on `turn_end`. The row still counts — RFC 0010 §5 counts
    // every turn of the day, failed ones included.
    const fake = fakeTurnsClient({
      rows: [{ cost_usd: null }, { cost_usd: "0.002" }],
    });
    const usage = await createSupabaseDailyUsageReader(
      fake.client,
    ).readDailyUsage("user-1", DAY_START);

    expect(usage.turns).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.002, 10);
  });

  it("returns zero for a day with no turns", async () => {
    const fake = fakeTurnsClient({ rows: [] });
    const usage = await createSupabaseDailyUsageReader(
      fake.client,
    ).readDailyUsage("user-1", DAY_START);
    expect(usage).toEqual({ turns: 0, costUsd: 0 });
  });

  it("queries one user's rows since the UTC day start, in index order", async () => {
    const fake = fakeTurnsClient({ rows: [] });
    await createSupabaseDailyUsageReader(fake.client).readDailyUsage(
      "user-1",
      DAY_START,
    );

    const [query] = fake.queries;
    expect(query.table).toBe("turns");
    expect(query.columns).toBe("cost_usd");
    expect(query.options).toEqual({ count: "exact" });
    // (user_id, started_at) is `turns_user_time_idx` from migration 0011 — the
    // filter is what keeps this an index range scan rather than a table scan,
    // and the explicit user_id is also what RLS checks.
    expect(query.filters).toEqual([
      ["user_id", "user-1"],
      ["started_at", "2026-07-26T00:00:00.000Z"],
    ]);
    // `started_at` alone is not unique, so the page needs a total order.
    expect(query.orders).toEqual([
      ["started_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("pages until the reported count is read when the server cap is lower", async () => {
    // Five rows, two per response: a reader that treated a short page as the end
    // would sum two rows and call it the day. The count is the database's, so
    // the total is still exact.
    const rows = [
      { cost_usd: 0.001 },
      { cost_usd: 0.001 },
      { cost_usd: 0.001 },
      { cost_usd: 0.001 },
      { cost_usd: 0.001 },
    ];
    const fake = fakeTurnsClient({ rows, serverCap: 2 });
    const usage = await createSupabaseDailyUsageReader(
      fake.client,
    ).readDailyUsage("user-1", DAY_START);

    expect(usage.turns).toBe(5);
    expect(usage.costUsd).toBeCloseTo(0.005, 10);
    expect(fake.pagesRead()).toBe(3);
    expect(fake.queries.map((query) => query.range)).toEqual([
      [0, 999],
      [2, 1001],
      [4, 1003],
    ]);
  });

  it("takes the turn count from the database, not from the rows it read", async () => {
    // Defensive but cheap: `count` is the number the gate will compare against
    // the limit, so it must not depend on what one page happened to contain.
    const fake = fakeTurnsClient({ rows: [{ cost_usd: 0.001 }], count: 41 });
    const usage = await createSupabaseDailyUsageReader(
      fake.client,
    ).readDailyUsage("user-1", DAY_START);
    expect(usage.turns).toBe(41);
  });

  it("throws so the gate can fail closed when the read fails", async () => {
    const fake = fakeTurnsClient({
      rows: [],
      error: { message: "connection refused" },
    });
    await expect(
      createSupabaseDailyUsageReader(fake.client).readDailyUsage(
        "user-1",
        DAY_START,
      ),
    ).rejects.toBeInstanceOf(DailyUsageReadError);
  });

  it("refuses to report a partial sum when the read never converges", async () => {
    // A client that keeps returning a full page and no count cannot be trusted
    // to have finished; reporting the rows read so far would under-count cost,
    // which is worse than the 503 the gate turns this into.
    const rows = Array.from({ length: 1000 }, () => ({ cost_usd: 0.001 }));
    const fake = fakeTurnsClient({ rows, count: null, ignoreRange: true });
    await expect(
      createSupabaseDailyUsageReader(fake.client).readDailyUsage(
        "user-1",
        DAY_START,
      ),
    ).rejects.toThrow(/partial sum/);
  });
});
