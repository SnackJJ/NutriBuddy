import { describe, it, expect } from "vitest";
import { createSupabaseProposalStore } from "../src/lib/proposalStore";
import type { ProposalInput } from "../src/harness/logMeal";

// ─── Fake Supabase client for deterministic testing ────────────────────

interface FakeQueryState {
  inserted: Array<{ table: string; row: Record<string, unknown> }>;
  selectResult: unknown;
  singleResult: unknown;
  error: Error | null;
  lastEqCol: string;
  lastEqVal: unknown;
  lastEqCol2: string;
  lastEqVal2: unknown;
}

/**
 * Build a fake Supabase client whose from().insert/select/update return
 * chained objects that mimic Supabase's `{ data, error }` return pattern.
 * Supabase never throws — errors are always returned as `{ data: null, error }`.
 */
function fakeSupabaseClient(): {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  client: any;
  state: FakeQueryState;
} {
  const state: FakeQueryState = {
    inserted: [],
    selectResult: null,
    singleResult: null,
    error: null,
    lastEqCol: "",
    lastEqVal: undefined,
    lastEqCol2: "",
    lastEqVal2: undefined,
  };

  // Helper: return { data, error } compatible with Supabase, where error is
  // an Error-like object (or null). Throwing is NOT how Supabase signals
  // errors — it returns them.
  function dbResult<T>(data: T): { data: T | null; error: Error | null } {
    if (state.error) {
      return { data: null, error: state.error };
    }
    return { data, error: null };
  }

  function chain() {
    return {
      eq(col: string, val: unknown) {
        state.lastEqCol = col;
        state.lastEqVal = val;
        return {
          eq(col2: string, val2: unknown) {
            state.lastEqCol2 = col2;
            state.lastEqVal2 = val2;
            return {
              select() {
                return {
                  single() {
                    return dbResult(state.singleResult as never);
                  },
                };
              },
              maybeSingle() {
                return dbResult(state.selectResult as never);
              },
            };
          },
          maybeSingle() {
            return dbResult(state.selectResult as never);
          },
        };
      },
    };
  }

  const client = {
    from: (table: string) => ({
      insert(row: Record<string, unknown>) {
        state.inserted.push({ table, row });
        const saved = { ...row };
        return {
          select() {
            return {
              single() {
                return dbResult(saved as never);
              },
              maybeSingle() {
                return dbResult(state.selectResult as never);
              },
            };
          },
        };
      },
      select: () => chain(),
      update: (_row: Record<string, unknown>) => ({
        eq(col: string, val: unknown) {
          state.lastEqCol = col;
          state.lastEqVal = val;
          return {
            eq(col2: string, val2: unknown) {
              state.lastEqCol2 = col2;
              state.lastEqVal2 = val2;
              return {
                select() {
                  return {
                    single() {
                      return dbResult(state.singleResult as never);
                    },
                  };
                },
              };
            },
          };
        },
      }),
    }),
  };

  return { client, state };
}

// ─── Test helpers ────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("createSupabaseProposalStore", () => {
  describe("store", () => {
    it("stores a proposal and returns a Proposal with generated id and status 'proposed'", async () => {
      const { client, state } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const input = makeProposalInput();
      const proposal = await store.store(input);

      expect(proposal.id).toMatch(/^proposal-/);
      expect(proposal.userId).toBe(TEST_USER);
      expect(proposal.foodId).toBe("food-chicken-breast-001");
      expect(proposal.foodName).toBe("chicken breast");
      expect(proposal.canonicalName).toBe("chicken breast");
      expect(proposal.portionG).toBe(200);
      expect(proposal.mealType).toBe("lunch");
      expect(proposal.kcal).toBe(330);
      expect(proposal.proteinG).toBe(62);
      expect(proposal.fatG).toBe(7.2);
      expect(proposal.carbsG).toBe(0);
      expect(proposal.nutritionSource).toBe("usda-sr-legacy-2026-07-v1");
      expect(proposal.matchType).toBe("exact");
      expect(proposal.allergenTags).toEqual([]);
      expect(proposal.status).toBe("proposed");
      expect(proposal.createdAt).toBe(FIXED_NOW);

      // Verify the row was inserted into the "proposals" table
      expect(state.inserted.length).toBe(1);
      expect(state.inserted[0].table).toBe("proposals");
    });

    it("generates unique ids for each call", async () => {
      const { client } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const p1 = await store.store(makeProposalInput());
      const p2 = await store.store(
        makeProposalInput({ foodName: "salmon" }),
      );

      expect(p1.id).not.toBe(p2.id);
    });

    it("stores all fields including allergen tags and match type", async () => {
      const { client, state } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const input = makeProposalInput({
        matchType: "fuzzy",
        allergenTags: ["fish", "shellfish"],
      });
      const proposal = await store.store(input);

      expect(proposal.matchType).toBe("fuzzy");
      expect(proposal.allergenTags).toEqual(["fish", "shellfish"]);

      // Verify the inserted row has the right data
      const inserted = state.inserted[0].row;
      expect(inserted.match_type).toBe("fuzzy");
      expect(inserted.allergen_tags).toEqual(["fish", "shellfish"]);
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
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      // Pre-seed the fake result
      state.selectResult = {
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
      };

      const proposal = await store.get("proposal-abc");

      expect(proposal).toBeDefined();
      expect(proposal!.id).toBe("proposal-abc");
      expect(proposal!.userId).toBe(TEST_USER);
      expect(proposal!.status).toBe("proposed");
    });

    it("returns undefined when proposal is not found", async () => {
      const { client, state } = fakeSupabaseClient();
      state.selectResult = null; // No result
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      const proposal = await store.get("nonexistent");

      expect(proposal).toBeUndefined();
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
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      // Simulate a committed row being returned
      state.singleResult = {
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
        status: "committed",
        created_at: FIXED_NOW,
      };

      const proposal = await store.commit("proposal-abc");

      expect(proposal.status).toBe("committed");
      // Verify the update was conditioned on status = "proposed"
      expect(state.lastEqCol).toBe("id");
      expect(state.lastEqVal).toBe("proposal-abc");
      expect(state.lastEqCol2).toBe("status");
      expect(state.lastEqVal2).toBe("proposed");
    });

    it("throws when the proposal is not in 'proposed' status", async () => {
      const { client, state } = fakeSupabaseClient();
      state.singleResult = null; // No row matched (already committed/rejected)
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
    it("declines a proposal by updating status to 'rejected'", async () => {
      const { client, state } = fakeSupabaseClient();
      const store = createSupabaseProposalStore({
        client,
        now: () => FIXED_NOW,
      });

      state.singleResult = {
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
        status: "rejected",
        created_at: FIXED_NOW,
      };

      const proposal = await store.decline("proposal-abc");

      expect(proposal.status).toBe("rejected");
      // Verify the update was conditioned on status = "proposed"
      expect(state.lastEqCol).toBe("id");
      expect(state.lastEqVal).toBe("proposal-abc");
      expect(state.lastEqCol2).toBe("status");
      expect(state.lastEqVal2).toBe("proposed");
    });

    it("throws when the proposal is not in 'proposed' status", async () => {
      const { client, state } = fakeSupabaseClient();
      state.singleResult = null;
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
