// Recipe nutrition computation (RFC 0005 / ADR 0003).
// Recipes never carry nutrition numbers from the model — only ingredient refs + grams.

export interface MacroPer100g {
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
}

export interface RecipeIngredientInput {
  readonly foodId: string;
  readonly foodName: string;
  readonly grams: number;
  readonly per100g: MacroPer100g;
  /** When true, finalization must block until resolved or removed. */
  readonly unresolved?: boolean;
}

export interface RecipeComputeResult {
  readonly ok: true;
  readonly per100g: MacroPer100g;
  readonly ingredientTotalG: number;
  readonly finishedWeightG: number;
}

export interface RecipeComputeBlocked {
  readonly ok: false;
  readonly reason: string;
  readonly unresolvedNames: readonly string[];
}

/**
 * Sum ingredient nutrition and divide by finished dish weight.
 * Unresolved ingredients block finalization (joint decision D7c).
 */
export function computeRecipePer100g(
  ingredients: readonly RecipeIngredientInput[],
  finishedWeightG: number,
): RecipeComputeResult | RecipeComputeBlocked {
  const unresolved = ingredients.filter(
    (i) => i.unresolved || i.grams <= 0 || !Number.isFinite(i.grams),
  );
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: "Unresolved or invalid ingredients block finalization",
      unresolvedNames: unresolved.map((i) => i.foodName),
    };
  }
  if (!Number.isFinite(finishedWeightG) || finishedWeightG <= 0) {
    return {
      ok: false,
      reason: "Finished weight must be a positive number of grams",
      unresolvedNames: [],
    };
  }
  if (ingredients.length === 0) {
    return {
      ok: false,
      reason: "Recipe needs at least one ingredient",
      unresolvedNames: [],
    };
  }

  let kcal = 0;
  let proteinG = 0;
  let fatG = 0;
  let carbsG = 0;
  let ingredientTotalG = 0;

  for (const i of ingredients) {
    const factor = i.grams / 100;
    kcal += i.per100g.kcal * factor;
    proteinG += i.per100g.proteinG * factor;
    fatG += i.per100g.fatG * factor;
    carbsG += i.per100g.carbsG * factor;
    ingredientTotalG += i.grams;
  }

  const scale = 100 / finishedWeightG;
  return {
    ok: true,
    ingredientTotalG,
    finishedWeightG,
    per100g: {
      kcal: round1(kcal * scale),
      proteinG: round1(proteinG * scale),
      fatG: round1(fatG * scale),
      carbsG: round1(carbsG * scale),
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
