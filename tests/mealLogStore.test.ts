import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listUserMealRecords } from "../src/lib/mealLogStore";

type DbRow = Record<string, unknown>;

/** Minimal fake for the `from(...).select("*").eq(...)` read chain. */
function fakeListClient(result: { data: DbRow[] | null; error: Error | null }): {
  client: SupabaseClient;
  filters: Array<{ column: string; value: unknown }>;
} {
  const filters: Array<{ column: string; value: unknown }> = [];
  const client = {
    from: () => ({
      select: () => ({
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return Promise.resolve(result);
        },
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, filters };
}

const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

function mealLogRow(overrides: DbRow = {}): DbRow {
  return {
    id: 1,
    user_id: TEST_USER,
    food_name: "chicken breast",
    portion_g: 200,
    meal_type: "lunch",
    logged_at: "2026-07-10T12:00:00.000Z",
    kcal: 330,
    protein_g: 62,
    fat_g: 7.2,
    carbs_g: 0,
    proposal_id: "proposal-abc",
    food_id: "food-chicken-breast-001",
    match_type: "exact",
    allergen_tags: [],
    created_at: "2026-07-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("listUserMealRecords (issue #55)", () => {
  it("scopes the query to the given user and maps rows to MealRecords", async () => {
    const { client, filters } = fakeListClient({
      data: [mealLogRow(), mealLogRow({ id: 2, food_name: "shrimp", kcal: 85 })],
      error: null,
    });

    const records = await listUserMealRecords(client, TEST_USER);

    expect(filters).toEqual([{ column: "user_id", value: TEST_USER }]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      userId: TEST_USER,
      foodName: "chicken breast",
      portionG: 200,
      mealType: "lunch",
      loggedAt: "2026-07-10T12:00:00.000Z",
      kcal: 330,
      proteinG: 62,
      fatG: 7.2,
      carbsG: 0,
    });
    expect(records[1].foodName).toBe("shrimp");
  });

  it("returns an empty array when the user has no rows", async () => {
    const { client } = fakeListClient({ data: [], error: null });

    const records = await listUserMealRecords(client, TEST_USER);

    expect(records).toEqual([]);
  });

  it("fails loud on a query error", async () => {
    const { client } = fakeListClient({
      data: null,
      error: new Error("connection refused"),
    });

    await expect(listUserMealRecords(client, TEST_USER)).rejects.toThrow(
      /Failed to list meal logs: connection refused/,
    );
  });
});
