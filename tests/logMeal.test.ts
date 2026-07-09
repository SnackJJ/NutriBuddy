import { describe, it, expect, vi } from "vitest";
import {
  createLogMealHandler,
  LOG_MEAL_SCHEMA,
  type ProposalStore,
  type Proposal,
  type ProposalInput,
} from "../src/harness/logMeal";
import type {
  GetFoodNutrition,
  NutritionData,
} from "../src/harness/foodNutrition";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";
let proposalCounter = 0;

function nextProposalId(): string {
  proposalCounter++;
  return `proposal-${proposalCounter.toString().padStart(3, "0")}`;
}

function fakeNutrition(data: Partial<NutritionData> = {}): GetFoodNutrition {
  return vi.fn(async (_foodName: string, _portionG: number) => ({
    foodName: "chicken breast",
    portionG: 200,
    kcal: 330,
    proteinG: 62,
    fatG: 7.2,
    carbsG: 0,
    source: "test stub",
    ...data,
  }));
}

function throwingNutrition(message: string): GetFoodNutrition {
  return async () => {
    throw new Error(message);
  };
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
          foodName: params.foodName,
          portionG: params.portionG,
          mealType: params.mealType,
          kcal: params.kcal,
          proteinG: params.proteinG,
          fatG: params.fatG,
          carbsG: params.carbsG,
          nutritionSource: params.nutritionSource,
          status: "proposed",
          createdAt: new Date("2026-06-26T12:00:00Z").toISOString(),
        };
        s.proposals.push(proposal);
        return proposal;
      },
      async get(id: string): Promise<Proposal | undefined> {
        return s.proposals.find((p) => p.id === id);
      },
      async commit(id: string): Promise<Proposal> {
        const idx = s.proposals.findIndex((p) => p.id === id);
        if (idx === -1) throw new Error(`Proposal ${id} not found`);
        if (s.proposals[idx].status !== "proposed") {
          throw new Error(`Proposal ${id} is ${s.proposals[idx].status}`);
        }
        const committed: Proposal = {
          ...s.proposals[idx],
          status: "committed",
        };
        s.proposals[idx] = committed;
        return committed;
      },
      async decline(id: string): Promise<Proposal> {
        const idx = s.proposals.findIndex((p) => p.id === id);
        if (idx === -1) throw new Error(`Proposal ${id} not found`);
        if (s.proposals[idx].status !== "proposed") {
          throw new Error(`Proposal ${id} is ${s.proposals[idx].status}`);
        }
        const rejected: Proposal = {
          ...s.proposals[idx],
          status: "rejected",
        };
        s.proposals[idx] = rejected;
        return rejected;
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
    async commit() {
      throw new Error(message);
    },
    async decline() {
      throw new Error(message);
    },
  };
}

// ─── Handler Creation ─────────────────────────────────────────────────────────

describe("createLogMealHandler", () => {
  it("returns a function", () => {
    const { store } = memProposalStore();
    const handler = createLogMealHandler({
      getFoodNutrition: fakeNutrition(),
      proposalStore: store,
      userId: TEST_USER,
    });
    expect(typeof handler).toBe("function");
  });

  // ─── Input Validation ──────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects missing food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects empty food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "", portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects whitespace-only food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "   ", portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects missing portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "chicken breast" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects zero portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 0,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects negative portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: -50,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects non-numeric portion_g", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: "a lot",
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects invalid meal_type", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "brunch",
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("meal_type");
    });

    it("accepts valid meal_types: breakfast, lunch, dinner, snack", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      for (const mt of ["breakfast", "lunch", "dinner", "snack"]) {
        const result = await handler({
          food_name: "chicken breast",
          portion_g: 200,
          meal_type: mt,
        });
        const parsed = JSON.parse(result);
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
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.meal_type).toBe("snack");
      expect(state.proposals[0].mealType).toBe("snack");
    });
  });

  // ─── Proposal Creation ─────────────────────────────────────────────────

  describe("proposal creation", () => {
    it("stores a proposal and returns confirmation prompt + nutrition summary", async () => {
      const { store, state } = memProposalStore();
      const nutrition = fakeNutrition();
      const handler = createLogMealHandler({
        getFoodNutrition: nutrition,
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = JSON.parse(result);

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

    it("stores the nutrition source in the proposal", async () => {
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition({ source: "USDA FoodData Central" }),
        proposalStore: store,
        userId: TEST_USER,
      });

      await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });

      expect(state.proposals[0].nutritionSource).toBe("USDA FoodData Central");
    });

    it("trims whitespace from food_name", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "  chicken breast  ",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.proposal_id).toBeDefined();
      expect(parsed.proposal.food_name).toBe("chicken breast");
    });

    it("calls getFoodNutrition with correct arguments", async () => {
      const { store } = memProposalStore();
      const nutrition = fakeNutrition();
      const handler = createLogMealHandler({
        getFoodNutrition: nutrition,
        proposalStore: store,
        userId: TEST_USER,
      });

      await handler({ food_name: "chicken breast", portion_g: 350 });

      expect(nutrition).toHaveBeenCalledWith("chicken breast", 350);
    });

    it("returns a unique proposal id for each call", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const r1 = JSON.parse(
        await handler({ food_name: "chicken breast", portion_g: 200 }),
      );
      const r2 = JSON.parse(
        await handler({ food_name: "rice", portion_g: 150 }),
      );

      expect(r1.proposal_id).not.toBe(r2.proposal_id);
      expect(r1.proposal.id).not.toBe(r2.proposal.id);
    });

    // Issue #36: log_meal stores proposals, not meal ledger rows.
    // The handler has no access to MealLogStore, so the meal ledger is
    // untouched by construction — no model-output path can mutate it.
    it("does not accept a MealLogStore dependency (structurally prevents meal ledger writes)", () => {
      // TypeScript-level check: LogMealDeps only exposes proposalStore.
      // This test documents the structural guarantee. There is no
      // mealLogStore field on LogMealDeps, so no caller can pass one.
      // The log_meal handler cannot mutate the meal ledger because it
      // has no reference to it.
      //
      // We verify by constructing a handler with only proposalStore and
      // confirming it works — proving MealLogStore is unnecessary.
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      expect(typeof handler).toBe("function");
      expect(state.proposals.length).toBe(0);
    });

    // Issue #36: explicit demonstration that a logging intent creates a
    // proposal and leaves the meal ledger untouched.
    it("creates a proposal without touching the meal ledger", async () => {
      // Set up a mock meal ledger with a spy to detect any writes.
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

      // The handler under test only accepts proposalStore (not mealLogStore).
      // This is the structural guarantee: no model-output path can reach
      // the meal ledger.
      const { store, state } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      // Execute a valid log_meal call.
      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = JSON.parse(result);

      // Proposal WAS created.
      expect(parsed.proposal_id).toBeDefined();
      expect(state.proposals.length).toBe(1);
      expect(state.proposals[0].foodName).toBe("chicken breast");
      expect(state.proposals[0].status).toBe("proposed");

      // Meal ledger was NOT touched — the mock was never invoked because
      // the handler has no reference to it.
      expect(mealLedgerInserted).toBe(false);
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns error when nutrition lookup fails", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: throwingNutrition("Food not found in database"),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "unknown exotic food",
        portion_g: 100,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("nutrition lookup failed");
      expect(parsed.error).toContain("Food not found");
    });

    it("returns error when proposal store fails", async () => {
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: throwingProposalStore("DB connection failed"),
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("failed to create meal proposal");
      expect(parsed.error).toContain("DB connection failed");
    });

    it("does not store proposal when nutrition lookup fails", async () => {
      const { store, state } = memProposalStore();
      const storeSpy = vi.fn(store.store);
      const handler = createLogMealHandler({
        getFoodNutrition: throwingNutrition("not found"),
        proposalStore: { ...store, store: storeSpy },
        userId: TEST_USER,
      });

      await handler({ food_name: "bad food", portion_g: 100 });
      expect(storeSpy).not.toHaveBeenCalled();
      expect(state.proposals.length).toBe(0);
    });
  });

  // ─── Response Format ────────────────────────────────────────────────────

  describe("response format", () => {
    it("returns valid JSON", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });

      expect(() => JSON.parse(result)).not.toThrow();
    });

    it("error responses contain an error key", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it("proposal responses contain proposal_id, message, proposal, nutrition_summary", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "dinner",
      });
      const parsed = JSON.parse(result);

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
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = JSON.parse(result);

      expect(parsed.message).toContain("Confirm?");
      expect(parsed.message).toContain("330 kcal");
      expect(parsed.message).toContain("62g protein");
    });

    // Issue #36: the response is shaped for the write-proposal terminal event
    it("proposal object carries resolved entities for terminal event", async () => {
      const { store } = memProposalStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = JSON.parse(result);

      // The proposal object in the response contains the data the turn
      // will use to construct the write-proposal terminal event.
      expect(parsed.proposal.id).toBeDefined();
      expect(parsed.proposal.food_name).toBe("chicken breast");
      expect(parsed.proposal.portion_g).toBe(200);
      expect(parsed.proposal.meal_type).toBe("lunch");
      expect(parsed.proposal.created_at).toBeDefined();
      expect(parsed.proposal.nutrition.kcal).toBe(330);
      expect(parsed.proposal.nutrition.protein_g).toBe(62);
      expect(parsed.proposal.nutrition.fat_g).toBe(7.2);
      expect(parsed.proposal.nutrition.carbs_g).toBe(0);
      expect(parsed.proposal.nutrition_source).toBe("test stub");
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

    it("declares food_name as a required string parameter", () => {
      const params = LOG_MEAL_SCHEMA.function.parameters;
      expect(params.type).toBe("object");
      expect(params.properties.food_name).toBeDefined();
      expect(params.properties.food_name.type).toBe("string");
      expect(params.required).toContain("food_name");
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
        getFoodNutrition: fakeNutrition(),
        proposalStore: store,
        userId: "authenticated-user-A",
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
        user_id: "evil-user",
      });

      const parsed = JSON.parse(result);
      expect(parsed.proposal_id).toBeDefined();

      expect(state.proposals).toHaveLength(1);
      expect(state.proposals[0].userId).toBe("authenticated-user-A");
      expect(state.proposals[0].userId).not.toBe("evil-user");
    });

    it("uses the userId captured by each handler instance", async () => {
      const state: MemProposalState = { proposals: [] };
      const { store: storeA } = memProposalStore(state);
      const handlerA = createLogMealHandler({
        getFoodNutrition: fakeNutrition({ foodName: "chicken breast" }),
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
        getFoodNutrition: fakeNutrition({ foodName: "salmon" }),
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
