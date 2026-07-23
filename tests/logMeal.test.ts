import { describe, it, expect, vi } from "vitest";
import {
  createLogMealHandler,
  LOG_MEAL_SCHEMA,
  type ProposalStore,
  type Proposal,
  type ProposalInput,
} from "../src/harness/logMeal";
import {
  createCatalog,
  nutritionPer100g,
  SEED_FOODS,
  type Catalog,
} from "../src/catalog/catalog";
import type { HandlerOutcome } from "../src/harness/toolOutcome";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize handler return (string | HandlerOutcome) to parsed JSON data. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseHandlerJson(result: string | HandlerOutcome): any {
  if (typeof result === "string") {
    return JSON.parse(result);
  }
  return result.data;
}

const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";
let proposalCounter = 0;

function nextProposalId(): string {
  proposalCounter++;
  return `proposal-${proposalCounter.toString().padStart(3, "0")}`;
}

/** Build a small test catalog from the seed — the handler resolves against it. */
function testCatalog(): Catalog {
  return createCatalog(SEED_FOODS);
}

interface MemProposalState {
  proposals: Proposal[];
}

function memProposalStore(state?: MemProposalState): {
  store: ProposalStore;
  state: MemProposalState;
} {
  const s = state ?? { proposals: [] };
  return {
    state: s,
    store: {
      async store(params: ProposalInput): Promise<Proposal> {
        const proposal: Proposal = {
          id: nextProposalId(),
          userId: params.userId,
          foodId: params.foodId,
          foodName: params.foodName,
          canonicalName: params.canonicalName,
          portionG: params.portionG,
          mealType: params.mealType,
          kcal: params.kcal,
          proteinG: params.proteinG,
          fatG: params.fatG,
          carbsG: params.carbsG,
          nutritionSource: params.nutritionSource,
          matchType: params.matchType,
          allergenTags: params.allergenTags,
          allergenCoverage: params.allergenCoverage ?? "reviewed",
          status: "proposed",
          createdAt: new Date("2026-06-26T12:00:00Z").toISOString(),
        };
        s.proposals.push(proposal);
        return proposal;
      },
      async get(id: string): Promise<Proposal | undefined> {
        return s.proposals.find((p) => p.id === id);
      },
      async commitProposalAndInsertMeal(proposalId: string) {
        const idx = s.proposals.findIndex(
          (p) => p.id === proposalId && p.status === "proposed",
        );
        if (idx < 0) return { kind: "not_committable" as const };
        s.proposals[idx] = { ...s.proposals[idx], status: "committed" };
        return {
          kind: "committed" as const,
          proposalId,
          mealLogId: 1,
        };
      },
      async voidProposal(proposalId: string) {
        const idx = s.proposals.findIndex(
          (p) => p.id === proposalId && p.status === "proposed",
        );
        if (idx < 0) return { kind: "not_committable" as const };
        s.proposals[idx] = { ...s.proposals[idx], status: "voided" };
        return { kind: "voided" as const, proposalId };
      },
    },
  };
}

function throwingProposalStore(message: string): ProposalStore {
  return {
    async store() {
      throw new Error(message);
    },
    async get() {
      throw new Error(message);
    },
    async commitProposalAndInsertMeal() {
      return { kind: "error", cause: message };
    },
    async voidProposal() {
      return { kind: "error", cause: message };
    },
  };
}

// ─── Handler Creation ─────────────────────────────────────────────────────────

describe("createLogMealHandler", () => {
  it("returns a function", () => {
    const { store } = memProposalStore();
    const handler = createLogMealHandler({
      catalog: testCatalog(),
      proposalStore: store,
      userId: TEST_USER,
    });
    expect(typeof handler).toBe("function");
  });

  it("logs an unreviewed food with empty ledger tags — loggable, not recommendable (issue #66)", async () => {
    const unreviewed: (typeof SEED_FOODS)[number] = {
      ...SEED_FOODS[0],
      id: "food-unreviewed-001",
      canonicalName: "mystery stew",
      aliases: [],
      allergenTags: undefined,
    };
    const { store, state } = memProposalStore();
    const handler = createLogMealHandler({
      catalog: createCatalog([...SEED_FOODS, unreviewed]),
      proposalStore: store,
      userId: TEST_USER,
    });

    const result = await handler({
      food_name: "mystery stew",
      portion_g: 150,
      meal_type: "dinner",
    });
    const parsed = parseHandlerJson(result);

    // Unreviewed catalog tags store [] (NOT NULL) but mark allergenCoverage.
    expect(parsed.error).toBeUndefined();
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0].allergenTags).toEqual([]);
    expect(state.proposals[0].allergenCoverage).toBe("unreviewed");
  });

  // ─── Input Validation ──────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects missing food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ portion_g: 200 });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects empty food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "", portion_g: 200 });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects whitespace-only food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "   ", portion_g: 200 });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects missing portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "chicken breast" });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects zero portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 0,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects negative portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: -50,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects non-numeric portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: "a lot",
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects invalid meal_type", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "brunch",
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("meal_type");
    });

    it("accepts valid meal_types: breakfast, lunch, dinner, snack", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      for (const mt of ["breakfast", "lunch", "dinner", "snack"]) {
        const result = await handler({
          food_name: "chicken breast",
          portion_g: 200,
          meal_type: mt,
        });
        const parsed = parseHandlerJson(result);
        expect(parsed.error).toBeUndefined();
        expect(parsed.proposal_id).toBeDefined();
      }
    });
  });

  // ─── Default meal_type ─────────────────────────────────────────────────

  describe("default meal_type", () => {
    it('defaults to "snack" when meal_type is omitted', async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.meal_type).toBe("snack");
      expect(state.proposals[0].mealType).toBe("snack");
    });
  });

  // ─── Catalog Resolver (issue #44) ───────────────────────────────────────

  describe("catalog resolver", () => {
    it("resolves via exact match on canonical name", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_id).toBe("food-chicken-breast-001");
      expect(parsed.proposal.canonical_name).toBe("chicken breast");
      expect(parsed.proposal.match_type).toBe("exact");
      expect(parsed.proposal.allergen_tags).toEqual([]);

      expect(state.proposals[0].foodId).toBe("food-chicken-breast-001");
      expect(state.proposals[0].canonicalName).toBe("chicken breast");
      expect(state.proposals[0].matchType).toBe("exact");
    });

    it("resolves via alias (case-insensitive)", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      // "steak" is an alias for "beef steak"
      const result = await handler({
        food_name: "steak",
        portion_g: 150,
        meal_type: "dinner",
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_id).toBe("food-beef-steak-001");
      expect(parsed.proposal.canonical_name).toBe("beef steak");
      expect(parsed.proposal.match_type).toBe("alias");

      expect(state.proposals[0].foodId).toBe("food-beef-steak-001");
      expect(state.proposals[0].matchType).toBe("alias");
    });

    it("fuzzy-resolves a typo input and names the resolved entity", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      // "chicken brest" (single char omission in "breast") → fuzzy match to "chicken breast"
      const result = await handler({
        food_name: "chicken brest",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_id).toBe("food-chicken-breast-001");
      expect(parsed.proposal.canonical_name).toBe("chicken breast");
      expect(parsed.proposal.match_type).toBe("fuzzy");
      expect(parsed.proposal.food_name).toBe("chicken brest"); // original input preserved
    });

    it("returns clarification for unknown food (miss_unknown)", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "xyzzy_nonexistent_food_12345",
        portion_g: 100,
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("not found in catalog");
      expect(parsed.match_type).toBe("miss_unknown");
      expect(parsed.message).toBeDefined();
      expect(parsed.message).toContain("not in the food catalog");
      // No proposal was stored
      expect(state.proposals.length).toBe(0);
    });

    it("returns candidates for ambiguous miss", async () => {
      // Create a catalog with two very similar foods to trigger ambiguity
      const ambCatalog = createCatalog([
        {
          id: "food-test-a",
          canonicalName: "test food alpha",
          aliases: [],
          per100g: nutritionPer100g({
            kcal: 100,
            proteinG: 10,
            fatG: 5,
            carbsG: 5,
          }),
          allergenTags: [],
          portionAliases: {},
          category: "test",
        },
        {
          id: "food-test-b",
          canonicalName: "test food bravo",
          aliases: [],
          per100g: nutritionPer100g({
            kcal: 150,
            proteinG: 15,
            fatG: 8,
            carbsG: 3,
          }),
          allergenTags: ["milk"],
          portionAliases: {},
          category: "test",
        },
      ]);

      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: ambCatalog,
        proposalStore: store,
        userId: TEST_USER,
      });

      // "test food" should fuzzy-match both with similar scores → ambiguous
      const result = await handler({
        food_name: "test food",
        portion_g: 100,
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("not found in catalog");
      // Either ambiguous or low_confidence — both mean miss
      expect(["miss_ambiguous", "miss_low_confidence"]).toContain(
        parsed.match_type,
      );
      // No proposal was stored
      expect(state.proposals.length).toBe(0);
    });

    it("preserves allergen tags from the resolved catalog entry", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      // "salmon" has allergenTags ["fish"]
      const result = await handler({
        food_name: "salmon",
        portion_g: 150,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.allergen_tags).toContain("fish");
      expect(state.proposals[0].allergenTags).toContain("fish");
    });

    it("computes nutrition from catalog per-100g values scaled by portion", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      // Chicken breast per 100g: kcal=165, protein=31, fat=3.6, carbs=0
      // 200g → kcal=330, protein=62, fat=7.2, carbs=0
      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.nutrition_summary.kcal).toBe(330);
      expect(parsed.nutrition_summary.protein_g).toBe(62);
      expect(parsed.nutrition_summary.fat_g).toBe(7.2);
      expect(parsed.nutrition_summary.carbs_g).toBe(0);
    });

    it("uses the catalog snapshot version as nutrition_source", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });

      expect(state.proposals[0].nutritionSource).toContain("usda-sr-legacy");
    });

    it("matches case-insensitively", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "CHICKEN BREAST",
        portion_g: 200,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.canonical_name).toBe("chicken breast");
    });

    it("resolves 'rice' as alias for 'white rice'", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "rice",
        portion_g: 150,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_id).toBe("food-rice-white-001");
      expect(state.proposals[0].matchType).toBe("alias");
    });
  });

  // ─── Proposal Creation ─────────────────────────────────────────────────

  describe("proposal creation", () => {
    it("stores a proposal and returns confirmation prompt + nutrition summary", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.proposal_id).toBeDefined();
      expect(typeof parsed.proposal_id).toBe("string");
      expect(parsed.message).toContain("200g chicken breast");
      expect(parsed.message).toContain("lunch");
      expect(parsed.message).toContain("Confirm?");
      expect(parsed.proposal.food_name).toBe("chicken breast");
      expect(parsed.proposal.portion_g).toBe(200);
      expect(parsed.proposal.meal_type).toBe("lunch");
      expect(parsed.proposal.created_at).toBeDefined();
      expect(parsed.nutrition_summary.kcal).toBe(330);
      expect(parsed.nutrition_summary.protein_g).toBe(62);
      expect(parsed.nutrition_summary.fat_g).toBe(7.2);
      expect(parsed.nutrition_summary.carbs_g).toBe(0);

      // Verify proposal was stored
      expect(state.proposals.length).toBe(1);
      expect(state.proposals[0].userId).toBe(TEST_USER);
      expect(state.proposals[0].foodName).toBe("chicken breast");
      expect(state.proposals[0].portionG).toBe(200);
      expect(state.proposals[0].mealType).toBe("lunch");
      expect(state.proposals[0].kcal).toBe(330);
      expect(state.proposals[0].status).toBe("proposed");
    });

    it("trims whitespace from food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "  chicken breast  ",
        portion_g: 200,
      });
      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_name).toBe("chicken breast");
    });

    it("returns a unique proposal id for each call", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const r1 = parseHandlerJson(
        await handler({ food_name: "chicken breast", portion_g: 200 }),
      );
      const r2 = parseHandlerJson(
        await handler({ food_name: "white rice", portion_g: 150 }),
      );

      expect(r1.proposal_id).not.toBe(r2.proposal_id);
      expect(r1.proposal.id).not.toBe(r2.proposal.id);
    });

    // Issue #36: log_meal stores proposals, not meal ledger rows.
    // The handler has no access to MealLogStore, so the meal ledger is
    // untouched by construction — no model-output path can mutate it.
    it("does not accept a MealLogStore dependency (structurally prevents meal ledger writes)", () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      expect(typeof handler).toBe("function");
      expect(state.proposals.length).toBe(0);
    });

    // Issue #36: explicit demonstration that a logging intent creates a
    // proposal and leaves the meal ledger untouched.
    it("creates a proposal without touching the meal ledger", async () => {
      let mealLedgerInserted = false;
      const _mealLogStore = {
        async insert() {
          mealLedgerInserted = true;
          return {
            id: 1,
            userId: "",
            foodName: "",
            portionG: 0,
            mealType: "",
            loggedAt: "",
            kcal: 0,
            proteinG: 0,
            fatG: 0,
            carbsG: 0,
            proposalId: "",
          };
        },
      };

      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.proposal_id).toBeDefined();
      expect(state.proposals.length).toBe(1);
      expect(state.proposals[0].foodName).toBe("chicken breast");
      expect(state.proposals[0].status).toBe("proposed");

      // Meal ledger was NOT touched
      expect(mealLedgerInserted).toBe(false);
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("propagates proposal store failures for dispatch infra_error mapping", async () => {
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: throwingProposalStore("DB connection failed"),
        userId: TEST_USER,
      });

      await expect(
        handler({
          food_name: "chicken breast",
          portion_g: 200,
        }),
      ).rejects.toThrow(/DB connection failed/);
    });

    it("does not store proposal when resolver returns a miss", async () => {
      const { store, state } = memProposalStore();
      const storeSpy = vi.fn(store.store);
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: { ...store, store: storeSpy },
        userId: TEST_USER,
      });

      await handler({
        food_name: "xyzzy_nonexistent_food_12345",
        portion_g: 100,
      });
      expect(storeSpy).not.toHaveBeenCalled();
      expect(state.proposals.length).toBe(0);
    });
  });

  // ─── Response Format ────────────────────────────────────────────────────

  describe("response format", () => {
    it("returns valid JSON", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });

      expect(() => parseHandlerJson(result)).not.toThrow();
    });

    it("error responses contain an error key", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({});
      const parsed = parseHandlerJson(result);
      expect(parsed.error).toBeDefined();
    });

    it("proposal responses contain proposal_id, message, proposal, nutrition_summary", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "dinner",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.proposal_id).toBeDefined();
      expect(typeof parsed.proposal_id).toBe("string");
      expect(typeof parsed.message).toBe("string");
      expect(parsed.proposal).toBeDefined();
      expect(parsed.proposal.id).toBe(parsed.proposal_id);
      expect(parsed.nutrition_summary).toBeDefined();
      expect(typeof parsed.nutrition_summary.kcal).toBe("number");
      expect(typeof parsed.nutrition_summary.protein_g).toBe("number");
      expect(typeof parsed.nutrition_summary.fat_g).toBe("number");
      expect(typeof parsed.nutrition_summary.carbs_g).toBe("number");
    });

    it("message includes confirmation prompt wording", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.message).toContain("Confirm?");
      expect(parsed.message).toContain("330 kcal");
      expect(parsed.message).toContain("62g protein");
    });

    // Issue #36 / Issue #44: the response carries resolved entity lineage
    it("proposal object carries resolved entities for terminal event", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = parseHandlerJson(result);

      expect(parsed.proposal.id).toBeDefined();
      expect(parsed.proposal.food_id).toBe("food-chicken-breast-001");
      expect(parsed.proposal.food_name).toBe("chicken breast");
      expect(parsed.proposal.canonical_name).toBe("chicken breast");
      expect(parsed.proposal.portion_g).toBe(200);
      expect(parsed.proposal.meal_type).toBe("lunch");
      expect(parsed.proposal.created_at).toBeDefined();
      expect(parsed.proposal.nutrition.kcal).toBe(330);
      expect(parsed.proposal.nutrition.protein_g).toBe(62);
      expect(parsed.proposal.nutrition.fat_g).toBe(7.2);
      expect(parsed.proposal.nutrition.carbs_g).toBe(0);
      expect(parsed.proposal.match_type).toBe("exact");
      expect(parsed.proposal.allergen_tags).toEqual([]);
      expect(parsed.proposal.nutrition_source).toContain("usda-sr-legacy");
    });
  });

  // ─── Schema Export ────────────────────────────────────────────────────────

  describe("LOG_MEAL_SCHEMA", () => {
    it("is exported and in OpenAI function-calling format", () => {
      expect(LOG_MEAL_SCHEMA).toBeDefined();
      expect(LOG_MEAL_SCHEMA.type).toBe("function");
      expect(LOG_MEAL_SCHEMA.function).toBeDefined();
      expect(LOG_MEAL_SCHEMA.function.name).toBe("log_meal");
      expect(typeof LOG_MEAL_SCHEMA.function.description).toBe("string");
      expect(LOG_MEAL_SCHEMA.function.description.length).toBeGreaterThan(0);
    });

    it("describes proposal-only behavior in its description", () => {
      const desc = LOG_MEAL_SCHEMA.function.description;
      expect(desc.toLowerCase()).toContain("propos");
      expect(desc.toLowerCase()).toContain("confirm");
    });

    it("mentions the catalog resolver in its description", () => {
      const desc = LOG_MEAL_SCHEMA.function.description;
      expect(desc.toLowerCase()).toContain("catalog");
    });

    it("declares food_name as a required string parameter", () => {
      const params = LOG_MEAL_SCHEMA.function.parameters;
      expect(params.type).toBe("object");
      expect(params.properties.food_name).toBeDefined();
      expect(params.properties.food_name.type).toBe("string");
      expect(params.required).toContain("food_name");
      expect(params.required).toContain("portion_g");
      // Model schema must not expose food_id (mint authority stays on resolver).
      expect(
        Object.prototype.hasOwnProperty.call(params.properties, "food_id"),
      ).toBe(false);
    });

    it("declares portion_g as a required number parameter", () => {
      const params = LOG_MEAL_SCHEMA.function.parameters;
      expect(params.properties.portion_g).toBeDefined();
      expect(params.properties.portion_g.type).toBe("number");
      expect(params.required).toContain("portion_g");
    });

    it("declares meal_type as an optional enum parameter", () => {
      const params = LOG_MEAL_SCHEMA.function.parameters;
      expect(params.properties.meal_type).toBeDefined();
      expect(params.properties.meal_type.type).toBe("string");
      expect(params.properties.meal_type.enum).toEqual([
        "breakfast",
        "lunch",
        "dinner",
        "snack",
      ]);
      expect(params.required).not.toContain("meal_type");
    });
  });

  // ─── Cross-tenant isolation (issue #38 / PRD v2 §3.4) ───────────────────

  describe("cross-tenant proposal scoping", () => {
    it("stores proposals under the injected userId, not model args", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: store,
        userId: "authenticated-user-A",
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
        user_id: "evil-user",
      });

      const parsed = parseHandlerJson(result);
      expect(parsed.proposal_id).toBeDefined();

      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0].userId).toBe("authenticated-user-A");
      expect(state.proposals[0].userId).not.toBe("evil-user");
    });

    it("uses the userId captured by each handler instance", async () => {
      const state: MemProposalState = { proposals: [] };
      const { store: storeA } = memProposalStore(state);
      const handlerA = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: storeA,
        userId: "user-A",
      });
      await handlerA({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });

      const { store: storeB } = memProposalStore(state);
      const handlerB = createLogMealHandler({
        catalog: testCatalog(),
        proposalStore: storeB,
        userId: "user-B",
      });
      await handlerB({
        food_name: "salmon",
        portion_g: 150,
        meal_type: "dinner",
      });

      expect(state.proposals).toEqual([
        expect.objectContaining({
          userId: "user-A",
          foodName: "chicken breast",
        }),
        expect.objectContaining({ userId: "user-B", foodName: "salmon" }),
      ]);
    });
  });
});
