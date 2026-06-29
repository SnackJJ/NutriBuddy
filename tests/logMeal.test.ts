import { describe, it, expect, vi } from "vitest";
import {
  createLogMealHandler,
  LOG_MEAL_SCHEMA,
  type MealLogStore,
  type MealLogEntry,
} from "../src/harness/logMeal";
import type { GetFoodNutrition, NutritionData } from "../src/harness/foodNutrition";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_USER = "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c";

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

interface MemStoreState {
  entries: MealLogEntry[];
  nextId: number;
}

function memMealLogStore(state?: MemStoreState): {
  store: MealLogStore;
  state: MemStoreState;
} {
  const s = state ?? { entries: [], nextId: 1 };
  return {
    state: s,
    store: {
      async insert(params) {
        const entry: MealLogEntry = {
          id: s.nextId++,
          userId: params.userId,
          foodName: params.foodName,
          portionG: params.portionG,
          mealType: params.mealType,
          loggedAt: new Date("2026-06-26T12:00:00Z").toISOString(),
          kcal: params.kcal,
          proteinG: params.proteinG,
          fatG: params.fatG,
          carbsG: params.carbsG,
        };
        s.entries.push(entry);
        return entry;
      },
    },
  };
}

function throwingStore(message: string): MealLogStore {
  return {
    async insert() {
      throw new Error(message);
    },
  };
}

// ─── Handler Creation ─────────────────────────────────────────────────────────

describe("createLogMealHandler", () => {
  it("returns a function", () => {
    const { store } = memMealLogStore();
    const handler = createLogMealHandler({
      getFoodNutrition: fakeNutrition(),
      mealLogStore: store,
      userId: TEST_USER,
    });
    expect(typeof handler).toBe("function");
  });

  // ─── Input Validation ──────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects missing food_name", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects empty food_name", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "", portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects whitespace-only food_name", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "   ", portion_g: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("food_name");
    });

    it("rejects missing portion_g", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "chicken breast" });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects zero portion_g", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({ food_name: "chicken breast", portion_g: 0 });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("portion_g");
    });

    it("rejects negative portion_g", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
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
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
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
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
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
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
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
        expect(parsed.success).toBe(true);
      }
    });
  });

  // ─── Default meal_type ─────────────────────────────────────────────────

  describe("default meal_type", () => {
    it('defaults to "snack" when meal_type is omitted', async () => {
      const { store, state } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.meal.meal_type).toBe("snack");
      expect(state.entries[0].mealType).toBe("snack");
    });
  });

  // ─── Successful Meal Logging ────────────────────────────────────────────

  describe("successful logging", () => {
    it("logs a meal and returns confirmation + nutrition summary", async () => {
      const { store, state } = memMealLogStore();
      const nutrition = fakeNutrition();
      const handler = createLogMealHandler({
        getFoodNutrition: nutrition,
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("200g chicken breast");
      expect(parsed.message).toContain("lunch");
      expect(parsed.meal.food_name).toBe("chicken breast");
      expect(parsed.meal.portion_g).toBe(200);
      expect(parsed.meal.meal_type).toBe("lunch");
      expect(parsed.meal.logged_at).toBeDefined();
      expect(parsed.nutrition_summary.kcal).toBe(330);
      expect(parsed.nutrition_summary.protein_g).toBe(62);
      expect(parsed.nutrition_summary.fat_g).toBe(7.2);
      expect(parsed.nutrition_summary.carbs_g).toBe(0);

      // Verify store was called
      expect(state.entries.length).toBe(1);
      expect(state.entries[0].userId).toBe(TEST_USER);
      expect(state.entries[0].foodName).toBe("chicken breast");
      expect(state.entries[0].portionG).toBe(200);
      expect(state.entries[0].mealType).toBe("lunch");
      expect(state.entries[0].kcal).toBe(330);
    });

    it("trims whitespace from food_name", async () => {
      const { store, state } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "  chicken breast  ",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.meal.food_name).toBe("chicken breast");
    });

    it("calls getFoodNutrition with correct arguments", async () => {
      const { store } = memMealLogStore();
      const nutrition = fakeNutrition();
      const handler = createLogMealHandler({
        getFoodNutrition: nutrition,
        mealLogStore: store,
        userId: TEST_USER,
      });

      await handler({ food_name: "chicken breast", portion_g: 350 });

      expect(nutrition).toHaveBeenCalledWith("chicken breast", 350);
    });

    it("returns a unique meal id", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const r1 = JSON.parse(
        await handler({ food_name: "chicken breast", portion_g: 200 }),
      );
      const r2 = JSON.parse(
        await handler({ food_name: "rice", portion_g: 150 }),
      );

      expect(r1.meal.id).not.toBe(r2.meal.id);
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns error when nutrition lookup fails", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: throwingNutrition("Food not found in database"),
        mealLogStore: store,
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

    it("returns error when store insert fails", async () => {
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: throwingStore("DB connection failed"),
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("failed to log meal");
      expect(parsed.error).toContain("DB connection failed");
    });

    it("does not insert to store when nutrition lookup fails", async () => {
      const { store, state } = memMealLogStore();
      // Wrap so we can track calls
      const insertSpy = vi.fn(store.insert);
      const handler = createLogMealHandler({
        getFoodNutrition: throwingNutrition("not found"),
        mealLogStore: { ...store, insert: insertSpy },
        userId: TEST_USER,
      });

      await handler({ food_name: "bad food", portion_g: 100 });
      expect(insertSpy).not.toHaveBeenCalled();
      expect(state.entries.length).toBe(0);
    });
  });

  // ─── Response Format ────────────────────────────────────────────────────

  describe("response format", () => {
    it("returns valid JSON", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
      });

      expect(() => JSON.parse(result)).not.toThrow();
    });

    it("error responses contain an error key", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({});
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it("success responses contain success, message, meal, nutrition_summary", async () => {
      const { store } = memMealLogStore();
      const handler = createLogMealHandler({
        getFoodNutrition: fakeNutrition(),
        mealLogStore: store,
        userId: TEST_USER,
      });

      const result = await handler({
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "dinner",
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(typeof parsed.message).toBe("string");
      expect(parsed.meal).toBeDefined();
      expect(parsed.nutrition_summary).toBeDefined();
      expect(typeof parsed.nutrition_summary.kcal).toBe("number");
      expect(typeof parsed.nutrition_summary.protein_g).toBe("number");
      expect(typeof parsed.nutrition_summary.fat_g).toBe("number");
      expect(typeof parsed.nutrition_summary.carbs_g).toBe("number");
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
});
