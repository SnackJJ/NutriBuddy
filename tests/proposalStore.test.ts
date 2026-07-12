import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseProposalStore } from "../src/lib/proposalStore";
import type { ProposalInput } from "../src/harness/logMeal";

type DbRow = Record<string, unknown>;

interface ProposalDbRow extends DbRow {
  readonly id: string;
  readonly user_id: string;
  readonly food_id: string;
  readonly food_name: string;
  readonly canonical_name: string;
  readonly portion_g: number;
  readonly meal_type: string;
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly nutrition_source: string;
  readonly match_type: string;
  readonly allergen_tags: string[];
  readonly status: string;
  readonly created_at: string;
}

interface QueryResult<T> {
  readonly data: T | null;
  readonly error: Error | null;
}

interface ResultQuery {
  single(): QueryResult<DbRow>;
  maybeSingle(): QueryResult<DbRow>;
}

interface FilterQuery {
  eq(column: string, value: unknown): FilterQuery;
  maybeSingle(): QueryResult<DbRow>;
  select(): ResultQuery;
}

interface TableQuery {
  insert(row: DbRow): { select(): ResultQuery };
  select(columns?: string): FilterQuery;
  update(row: DbRow): FilterQuery;
}

interface FakeSupabaseClient {
  from(table: string): TableQuery;
}

interface FakeQueryState {
  readonly inserted: Array<{ table: string; row: DbRow }>;
  readonly updated: Array<{ table: string; row: DbRow }>;
  readonly filters: Array<{ column: string; value: unknown }>;
  lookupRow: DbRow | null;
  transitionRow: DbRow | null;
  error: Error | null;
}

function fakeSupabaseClient(): {
  client: SupabaseClient;
  state: FakeQueryState;
} {
  const state: FakeQueryState = {
    inserted: [],
    updated: [],
    filters: [],
    lookupRow: null,
    transitionRow: null,
    error: null,
  };

  function dbResult<T extends DbRow>(data: T | null): QueryResult<T> {
    if (state.error) {
      return { data: null, error: state.error };
    }

    return { data, error: null };
  }

  function resultQuery(getRow: () => DbRow | null): ResultQuery {
    return {
      single: () => dbResult(getRow()),
      maybeSingle: () => dbResult(getRow()),
    };
  }

  function filterQuery(getRow: () => DbRow | null): FilterQuery {
    const query: FilterQuery = {
      eq(column, value) {
        state.filters.push({ column, value });
        return query;
      },
      maybeSingle: () => dbResult(getRow()),
      select: () => resultQuery(getRow),
    };

    return query;
  }

  const client: FakeSupabaseClient = {
    from: (table) => ({
      insert(row) {
        const saved = { ...row };
        state.inserted.push({ table, row: saved });
        return {
          select: () => resultQuery(() => saved),
        };
      },
      select: () => filterQuery(() => state.lookupRow),
      update(row) {
        state.updated.push({ table, row });
        return filterQuery(() => state.transitionRow);
      },
    }),
  };

  return { client: client as unknown as SupabaseClient, state };
}

const FIXED_NOW = "2026-07-10T12:00:00.000Z";
const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

function makeProposalInput(
  overrides: Partial<ProposalInput> = {},
): ProposalInput {
  return {
    userId: TEST_USER,
    foodId: "food-chicken-breast-001",
    foodName: "chicken breast",
    canonicalName: "chicken breast",
    portionG: 200,
    mealType: "lunch",
    kcal: 330,
    proteinG: 62,
    fatG: 7.2,
    carbsG: 0,
    nutritionSource: "usda-sr-legacy-2026-07-v1",
    matchType: "exact",
    allergenTags: [],
    ...overrides,
  };
}

function proposalRow(overrides: Partial<ProposalDbRow> = {}): ProposalDbRow {
  return {
    id: "proposal-abc",
    user_id: TEST_USER,
    food_id: "food-chicken-breast-001",
    food_name: "chicken breast",
    canonical_name: "chicken breast",
    portion_g: 200,
    meal_type: "lunch",
    kcal: 330,
    protein_g: 62,
    fat_g: 7.2,
    carbs_g: 0,
    nutrition_source: "usda-sr-legacy-2026-07-v1",
    match_type: "exact",
    allergen_tags: [],
    status: "proposed",
    created_at: FIXED_NOW,
    ...overrides,
  };
}

describe("createSupabaseProposalStore", () => {
  describe("store", () => {
    it("stores a proposal and returns a Proposal with generated id and status 'proposed'", async () => {
      const { client, state } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.store(makeProposalInput());

      expect(proposal).toMatchObject({
        id: expect.stringMatching(/^proposal-/),
        userId: TEST_USER,
        foodId: "food-chicken-breast-001",
        foodName: "chicken breast",
        canonicalName: "chicken breast",
        portionG: 200,
        mealType: "lunch",
        kcal: 330,
        proteinG: 62,
        fatG: 7.2,
        carbsG: 0,
        nutritionSource: "usda-sr-legacy-2026-07-v1",
        matchType: "exact",
        allergenTags: [],
        status: "proposed",
        createdAt: FIXED_NOW,
      });
      expect(state.inserted).toHaveLength(1);
      expect(state.inserted[0]).toMatchObject({
        table: "proposals",
        row: { user_id: TEST_USER, status: "proposed" },
      });
    });

    it("generates unique ids for each call", async () => {
      const { client } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const p1 = await store.store(makeProposalInput());
      const p2 = await store.store(makeProposalInput({ foodName: "salmon" }));

      expect(p1.id).not.toBe(p2.id);
    });

    it("stores all fields including allergen tags and match type", async () => {
      const { client, state } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.store(
        makeProposalInput({
          matchType: "fuzzy",
          allergenTags: ["fish", "shellfish"],
        }),
      );

      expect(proposal.matchType).toBe("fuzzy");
      expect(proposal.allergenTags).toEqual(["fish", "shellfish"]);
      expect(state.inserted[0].row).toMatchObject({
        match_type: "fuzzy",
        allergen_tags: ["fish", "shellfish"],
      });
    });

    it("throws when the Supabase insert fails", async () => {
      const { client, state } = fakeSupabaseClient();
      state.error = new Error("Connection refused");
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.store(makeProposalInput())).rejects.toThrow(
        "Failed to store proposal: Connection refused",
      );
    });
  });

  describe("get", () => {
    it("returns a proposal when found", async () => {
      const { client, state } = fakeSupabaseClient();
      state.lookupRow = proposalRow();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.get("proposal-abc");

      expect(proposal).toMatchObject({
        id: "proposal-abc",
        userId: TEST_USER,
        status: "proposed",
      });
      expect(state.filters).toEqual([{ column: "id", value: "proposal-abc" }]);
    });

    it("returns undefined when proposal is not found", async () => {
      const { client } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.get("nonexistent")).resolves.toBeUndefined();
    });

    it("throws when Supabase query fails", async () => {
      const { client, state } = fakeSupabaseClient();
      state.error = new Error("DB connection failed");
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.get("proposal-123")).rejects.toThrow(
        "Failed to get proposal: DB connection failed",
      );
    });
  });

  describe("commit", () => {
    it("commits a proposal by updating status to 'committed'", async () => {
      const { client, state } = fakeSupabaseClient();
      state.transitionRow = proposalRow({ status: "committed" });
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.commit("proposal-abc");

      expect(proposal.status).toBe("committed");
      expect(state.updated).toEqual([
        { table: "proposals", row: { status: "committed" } },
      ]);
      expect(state.filters).toEqual([
        { column: "id", value: "proposal-abc" },
        { column: "status", value: "proposed" },
      ]);
    });

    it("throws when the proposal is not in 'proposed' status", async () => {
      const { client } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.commit("proposal-abc")).rejects.toThrow(
        'Proposal proposal-abc not found or not in "proposed" status',
      );
    });

    it("throws on Supabase error", async () => {
      const { client, state } = fakeSupabaseClient();
      state.error = new Error("Connection refused");
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.commit("proposal-123")).rejects.toThrow(
        "Failed to commit proposal proposal-123: Connection refused",
      );
    });
  });

  describe("decline", () => {
    it("declines a proposal by updating status to 'voided'", async () => {
      const { client, state } = fakeSupabaseClient();
      state.transitionRow = proposalRow({ status: "voided" });
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.decline("proposal-abc");

      expect(proposal.status).toBe("voided");
      expect(state.updated).toEqual([
        { table: "proposals", row: { status: "voided" } },
      ]);
      expect(state.filters).toEqual([
        { column: "id", value: "proposal-abc" },
        { column: "status", value: "proposed" },
      ]);
    });

    it("throws when the proposal is not in 'proposed' status", async () => {
      const { client } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.decline("proposal-abc")).rejects.toThrow(
        'Proposal proposal-abc not found or not in "proposed" status',
      );
    });

    it("throws on Supabase error", async () => {
      const { client, state } = fakeSupabaseClient();
      state.error = new Error("Connection refused");
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      await expect(store.decline("proposal-123")).rejects.toThrow(
        "Failed to decline proposal proposal-123: Connection refused",
      );
    });
  });
});
