// Local Food Catalog - curated seed from USDA FoodData Central (SR Legacy).
// Phase 1 tracer bullet: exact/alias/fuzzy resolver for ~40 common foods.
//
// The catalog is the gate: only the resolver can mint FoodRefs. Model-provided
// strings pass through the resolver cascade; the model cannot invent food ids.
//
// Schema-versioned snapshot identity flows into every ResolveResult so traces
// reproduce against their data.

export const CATALOG_SNAPSHOT_VERSION = "usda-sr-legacy-2026-07-v1";

// ─── types ─────────────────────────────────────────────────────────────────

/** Per-100g nutrition values from USDA SR Legacy with unit-bearing field names. */
export interface NutritionPer100g {
  /** Energy (kcal). */
  readonly kcal: number;
  /** Protein (g). */
  readonly proteinG: number;
  /** Total fat (g). */
  readonly fatG: number;
  /** Total carbohydrates (g). */
  readonly carbsG: number;
  /** Dietary fiber (g). */
  readonly fiberG: number;
  /** Total sugars (g). */
  readonly sugarsG: number;
  /** Saturated fat (g). */
  readonly saturatedFatG: number;
  /** Cholesterol (mg). */
  readonly cholesterolMg: number;
  /** Sodium (mg). */
  readonly sodiumMg: number;
  /** Calcium (mg). */
  readonly calciumMg: number;
  /** Iron (mg). */
  readonly ironMg: number;
  /** Potassium (mg). */
  readonly potassiumMg: number;
  /** Vitamin C (mg). */
  readonly vitaminCMg: number;
  /** Vitamin D (mcg). */
  readonly vitaminDMcg: number;
}

type MacroNutritionPer100g = Pick<
  NutritionPer100g,
  "kcal" | "proteinG" | "fatG" | "carbsG"
>;

type ExpandedNutritionPer100g = Omit<
  NutritionPer100g,
  keyof MacroNutritionPer100g
>;

export type NutritionPer100gInput = MacroNutritionPer100g &
  Partial<ExpandedNutritionPer100g>;

/**
 * Build a complete per-100g nutrition object from seed data.
 *
 * Missing expanded nutrients stay at zero until a reviewed snapshot supplies
 * them, matching the pre-ingestion catalog behavior.
 */
export function nutritionPer100g(
  nutrients: NutritionPer100gInput,
): NutritionPer100g {
  return {
    kcal: nutrients.kcal,
    proteinG: nutrients.proteinG,
    fatG: nutrients.fatG,
    carbsG: nutrients.carbsG,
    fiberG: nutrients.fiberG ?? 0,
    sugarsG: nutrients.sugarsG ?? 0,
    saturatedFatG: nutrients.saturatedFatG ?? 0,
    cholesterolMg: nutrients.cholesterolMg ?? 0,
    sodiumMg: nutrients.sodiumMg ?? 0,
    calciumMg: nutrients.calciumMg ?? 0,
    ironMg: nutrients.ironMg ?? 0,
    potassiumMg: nutrients.potassiumMg ?? 0,
    vitaminCMg: nutrients.vitaminCMg ?? 0,
    vitaminDMcg: nutrients.vitaminDMcg ?? 0,
  };
}

/** A single entry in the local food catalog. */
export interface CatalogFood {
  /** Stable, unique catalog id (e.g. "food-chicken-breast-001"). */
  readonly id: string;
  /** Canonical display name in lowercase (e.g. "chicken breast"). */
  readonly canonicalName: string;
  /** Alternative names the resolver maps to this entry (lowercase). */
  readonly aliases: readonly string[];
  /** Per-100g nutrition values from USDA SR Legacy. */
  readonly per100g: NutritionPer100g;
  /**
   * FDA big-9 allergen tags. Empty array = reviewed, no allergens.
   * undefined = tags not yet reviewed: loggable, not recommendable —
   * the output entity check fails closed on it (ADD §Gates check (a)).
   */
  readonly allergenTags?: readonly string[];
  /** Portion descriptions → estimated grams. */
  readonly portionAliases: Readonly<Record<string, number>>;
  /** Food category for grouping. */
  readonly category: string;
}

/** Match quality reported by the resolver. */
export type MatchType =
  | "exact"
  | "alias"
  | "fuzzy"
  | "miss_ambiguous"
  | "miss_low_confidence"
  | "miss_unknown";

/**
 * Stable food reference — ONLY minted by the resolver.
 * The model proposes strings; the resolver returns FoodRefs.
 */
export interface FoodRef {
  /** Stable catalog id from the seed. */
  readonly foodId: string;
  /** Canonical name from the catalog (not the model's string). */
  readonly canonicalName: string;
  /** Per-100g nutrition from the catalog. */
  readonly per100g: NutritionPer100g;
  /** FDA big-9 allergen tags from the catalog; undefined = not yet reviewed. */
  readonly allergenTags?: readonly string[];
  /** How the resolver matched this food. */
  readonly matchType: "exact" | "alias" | "fuzzy";
  /** Match score (1.0 for exact/alias; 0-1 for fuzzy). */
  readonly matchScore: number;
}

interface ResolveResultBase {
  /** Catalog snapshot identity for trace reproducibility. */
  readonly catalogSnapshotId: string;
  /** The original query string. */
  readonly input: string;
}

/** A successful resolver hit with a catalog-minted FoodRef. */
export interface ResolveHitResult extends ResolveResultBase {
  /** Match classification. */
  readonly matchType: FoodRef["matchType"];
  /** Resolved FoodRef. */
  readonly foodRef: FoodRef;
  /** Hit results never carry clarification candidates. */
  readonly candidates?: undefined;
}

/** A resolver miss that may carry clarification candidates. */
export interface ResolveMissResult extends ResolveResultBase {
  /** Match classification. */
  readonly matchType: Exclude<MatchType, FoodRef["matchType"]>;
  /** All miss types carry no resolved FoodRef. */
  readonly foodRef: null;
  /** Top-k candidates for ambiguous/low-confidence misses. */
  readonly candidates?: readonly FoodRef[];
}

/** The resolver's typed result for every lookup. */
export type ResolveResult = ResolveHitResult | ResolveMissResult;

// ─── catalog container ─────────────────────────────────────────────────────

/** An immutable catalog with lookup indexes. */
export interface Catalog {
  readonly snapshot: { readonly version: string; readonly foodCount: number };
  /** Canonical name (lowercase) → CatalogFood. */
  readonly foods: ReadonlyMap<string, CatalogFood>;
  /** Alias (lowercase) → canonical name (lowercase). */
  readonly aliasIndex: ReadonlyMap<string, string>;
  /** All foods as a flat list (for fuzzy scanning). */
  readonly allFoods: readonly CatalogFood[];
}

/**
 * Build a catalog from a list of food entries.
 *
 * The snapshot version is carried as data (issue #60): pass the ingestion
 * snapshot's version when loading from a file; defaults to the seed constant.
 */
export function createCatalog(
  foods: readonly CatalogFood[],
  version: string = CATALOG_SNAPSHOT_VERSION,
): Catalog {
  const foodMap = new Map<string, CatalogFood>();
  const aliasMap = new Map<string, string>();

  for (const food of foods) {
    const key = food.canonicalName.toLowerCase();
    foodMap.set(key, food);

    for (const alias of food.aliases) {
      aliasMap.set(alias.toLowerCase(), key);
    }
  }

  return {
    snapshot: {
      version,
      foodCount: foods.length,
    },
    foods: foodMap,
    aliasIndex: aliasMap,
    allFoods: foods,
  };
}

// ─── seed data ─────────────────────────────────────────────────────────────

/**
 * Curated local catalog seed (~40 foods).
 *
 * Data source: USDA FoodData Central (SR Legacy) per-100g values.
 * Allergen tags: FDA big-9 (milk, egg, peanut, tree_nut, soy, wheat, fish,
 * shellfish, sesame). Tags assigned conservatively based on common forms;
 * cross-contamination tagging is future work.
 *
 * Portion aliases: rough estimates for Western-diet serving sizes.
 * A dietitian-reviewed portion table is future work.
 */

export const SEED_FOODS: readonly CatalogFood[] = [
  // ── meat ───────────────────────────────────────────────────────────────
  {
    id: "food-chicken-breast-001",
    canonicalName: "chicken breast",
    aliases: [
      "boneless chicken breast",
      "skinless chicken breast",
      "hen breast",
    ],
    per100g: nutritionPer100g({
      kcal: 165,
      proteinG: 31,
      fatG: 3.6,
      carbsG: 0,
    }),
    allergenTags: [],
    portionAliases: { piece: 150, breast: 200, oz: 28, serving: 100 },
    category: "meat",
  },
  {
    id: "food-chicken-thigh-001",
    canonicalName: "chicken thigh",
    aliases: ["boneless chicken thigh", "skinless chicken thigh"],
    per100g: nutritionPer100g({ kcal: 209, proteinG: 26, fatG: 11, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { piece: 100, oz: 28, serving: 100 },
    category: "meat",
  },
  {
    id: "food-chicken-whole-001",
    canonicalName: "chicken",
    aliases: ["whole chicken", "roast chicken", "roasted chicken"],
    per100g: nutritionPer100g({ kcal: 239, proteinG: 27, fatG: 14, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { piece: 300, oz: 28, serving: 200 },
    category: "meat",
  },
  {
    id: "food-beef-001",
    canonicalName: "beef",
    aliases: ["beef meat", "red meat", "ground beef"],
    per100g: nutritionPer100g({ kcal: 250, proteinG: 26, fatG: 15, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { oz: 28, serving: 100, steak: 225, patty: 150 },
    category: "meat",
  },
  {
    id: "food-beef-steak-001",
    canonicalName: "beef steak",
    aliases: ["steak", "beef steak cut", "sirloin"],
    per100g: nutritionPer100g({ kcal: 271, proteinG: 25, fatG: 19, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { steak: 225, oz: 28, serving: 150 },
    category: "meat",
  },
  {
    id: "food-pork-001",
    canonicalName: "pork",
    aliases: ["pork meat", "pig meat"],
    per100g: nutritionPer100g({ kcal: 242, proteinG: 27, fatG: 14, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { oz: 28, serving: 100, chop: 170 },
    category: "meat",
  },
  {
    id: "food-pork-chop-001",
    canonicalName: "pork chop",
    aliases: ["pork chop cut", "loin chop"],
    per100g: nutritionPer100g({ kcal: 231, proteinG: 25, fatG: 14, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { chop: 170, piece: 170, oz: 28, serving: 150 },
    category: "meat",
  },
  {
    id: "food-turkey-breast-001",
    canonicalName: "turkey breast",
    aliases: ["turkey", "turkey breast meat", "deli turkey"],
    per100g: nutritionPer100g({
      kcal: 135,
      proteinG: 30,
      fatG: 0.7,
      carbsG: 0,
    }),
    allergenTags: [],
    portionAliases: { piece: 150, slice: 28, oz: 28, serving: 100 },
    category: "meat",
  },

  // ── seafood ────────────────────────────────────────────────────────────
  {
    id: "food-salmon-001",
    canonicalName: "salmon",
    aliases: ["atlantic salmon", "salmon fillet", "salmon fish"],
    per100g: nutritionPer100g({ kcal: 208, proteinG: 20, fatG: 13, carbsG: 0 }),
    allergenTags: ["fish"],
    portionAliases: { fillet: 170, piece: 170, oz: 28, serving: 100 },
    category: "seafood",
  },
  {
    id: "food-tuna-001",
    canonicalName: "tuna",
    aliases: ["tuna fish", "canned tuna", "tuna in water"],
    per100g: nutritionPer100g({
      kcal: 132,
      proteinG: 28,
      fatG: 1.3,
      carbsG: 0,
    }),
    allergenTags: ["fish"],
    portionAliases: { can: 140, oz: 28, serving: 100 },
    category: "seafood",
  },
  {
    id: "food-shrimp-001",
    canonicalName: "shrimp",
    aliases: ["prawn", "prawns", "shrimps"],
    per100g: nutritionPer100g({ kcal: 85, proteinG: 20, fatG: 0.5, carbsG: 0 }),
    allergenTags: ["shellfish"],
    portionAliases: { piece: 15, oz: 28, serving: 85 },
    category: "seafood",
  },
  {
    id: "food-cod-001",
    canonicalName: "cod",
    aliases: ["cod fish", "cod fillet", "atlantic cod"],
    per100g: nutritionPer100g({ kcal: 82, proteinG: 18, fatG: 0.7, carbsG: 0 }),
    allergenTags: ["fish"],
    portionAliases: { fillet: 180, piece: 180, oz: 28, serving: 100 },
    category: "seafood",
  },

  // ── grains ─────────────────────────────────────────────────────────────
  {
    id: "food-rice-white-001",
    canonicalName: "white rice",
    aliases: ["rice", "steamed rice", "cooked rice", "plain rice"],
    per100g: nutritionPer100g({
      kcal: 130,
      proteinG: 2.7,
      fatG: 0.3,
      carbsG: 28,
    }),
    allergenTags: [],
    portionAliases: { bowl: 200, cup: 180, serving: 150 },
    category: "grain",
  },
  {
    id: "food-rice-brown-001",
    canonicalName: "brown rice",
    aliases: ["whole grain rice", "unpolished rice"],
    per100g: nutritionPer100g({
      kcal: 123,
      proteinG: 2.7,
      fatG: 1,
      carbsG: 26,
    }),
    allergenTags: [],
    portionAliases: { bowl: 200, cup: 180, serving: 150 },
    category: "grain",
  },
  {
    id: "food-bread-white-001",
    canonicalName: "white bread",
    aliases: ["bread", "sandwich bread", "sliced bread"],
    per100g: nutritionPer100g({
      kcal: 265,
      proteinG: 9,
      fatG: 3.2,
      carbsG: 49,
    }),
    allergenTags: ["wheat"],
    portionAliases: { slice: 28, piece: 28, serving: 56 },
    category: "grain",
  },
  {
    id: "food-bread-whole-wheat-001",
    canonicalName: "whole wheat bread",
    aliases: ["wholemeal bread", "brown bread", "wheat bread"],
    per100g: nutritionPer100g({
      kcal: 247,
      proteinG: 13,
      fatG: 3.4,
      carbsG: 41,
    }),
    allergenTags: ["wheat"],
    portionAliases: { slice: 28, piece: 28, serving: 56 },
    category: "grain",
  },
  {
    id: "food-pasta-001",
    canonicalName: "pasta",
    aliases: ["spaghetti", "cooked pasta", "macaroni", "penne", "linguine"],
    per100g: nutritionPer100g({
      kcal: 131,
      proteinG: 5,
      fatG: 1.1,
      carbsG: 25,
    }),
    allergenTags: ["wheat"],
    portionAliases: { bowl: 200, cup: 140, serving: 200, plate: 300 },
    category: "grain",
  },
  {
    id: "food-oatmeal-001",
    canonicalName: "oatmeal",
    aliases: ["oats", "porridge", "cooked oats", "rolled oats"],
    per100g: nutritionPer100g({
      kcal: 71,
      proteinG: 2.5,
      fatG: 1.5,
      carbsG: 12,
    }),
    allergenTags: [],
    portionAliases: { bowl: 240, cup: 234, serving: 240 },
    category: "grain",
  },
  {
    id: "food-noodles-001",
    canonicalName: "noodles",
    aliases: ["egg noodles", "chow mein", "lo mein"],
    per100g: nutritionPer100g({
      kcal: 138,
      proteinG: 4.5,
      fatG: 2.1,
      carbsG: 25,
    }),
    allergenTags: ["wheat"],
    portionAliases: { bowl: 250, serving: 200 },
    category: "grain",
  },

  // ── vegetables ─────────────────────────────────────────────────────────
  {
    id: "food-broccoli-001",
    canonicalName: "broccoli",
    aliases: ["broccoli florets", "steamed broccoli", "green broccoli"],
    per100g: nutritionPer100g({
      kcal: 34,
      proteinG: 2.8,
      fatG: 0.4,
      carbsG: 7,
    }),
    allergenTags: [],
    portionAliases: { cup: 91, serving: 100, floret: 15 },
    category: "vegetable",
  },
  {
    id: "food-spinach-001",
    canonicalName: "spinach",
    aliases: ["spinach leaves", "fresh spinach", "baby spinach"],
    per100g: nutritionPer100g({
      kcal: 23,
      proteinG: 2.9,
      fatG: 0.4,
      carbsG: 3.6,
    }),
    allergenTags: [],
    portionAliases: { cup: 30, serving: 100, handful: 30 },
    category: "vegetable",
  },
  {
    id: "food-carrot-001",
    canonicalName: "carrot",
    aliases: ["carrots", "raw carrot", "orange carrot"],
    per100g: nutritionPer100g({
      kcal: 41,
      proteinG: 0.9,
      fatG: 0.2,
      carbsG: 10,
    }),
    allergenTags: [],
    portionAliases: { piece: 61, serving: 100, cup: 128 },
    category: "vegetable",
  },
  {
    id: "food-tomato-001",
    canonicalName: "tomato",
    aliases: ["tomatoes", "fresh tomato", "raw tomato", "roma tomato"],
    per100g: nutritionPer100g({
      kcal: 18,
      proteinG: 0.9,
      fatG: 0.2,
      carbsG: 3.9,
    }),
    allergenTags: [],
    portionAliases: { piece: 123, serving: 100, cup: 180 },
    category: "vegetable",
  },
  {
    id: "food-potato-001",
    canonicalName: "potato",
    aliases: ["potatoes", "white potato", "baked potato", "boiled potato"],
    per100g: nutritionPer100g({ kcal: 77, proteinG: 2, fatG: 0.1, carbsG: 17 }),
    allergenTags: [],
    portionAliases: { piece: 173, serving: 100, medium: 173 },
    category: "vegetable",
  },
  {
    id: "food-sweet-potato-001",
    canonicalName: "sweet potato",
    aliases: ["sweet potatoes", "yam"],
    per100g: nutritionPer100g({
      kcal: 86,
      proteinG: 1.6,
      fatG: 0.1,
      carbsG: 20,
    }),
    allergenTags: [],
    portionAliases: { piece: 130, serving: 100, medium: 130 },
    category: "vegetable",
  },
  {
    id: "food-lettuce-001",
    canonicalName: "lettuce",
    aliases: [
      "iceberg lettuce",
      "romaine lettuce",
      "green lettuce",
      "salad leaves",
    ],
    per100g: nutritionPer100g({
      kcal: 15,
      proteinG: 1.4,
      fatG: 0.2,
      carbsG: 2.9,
    }),
    allergenTags: [],
    portionAliases: { cup: 36, serving: 100, bowl: 85 },
    category: "vegetable",
  },

  // ── dairy / eggs ──────────────────────────────────────────────────────
  {
    id: "food-egg-001",
    canonicalName: "egg",
    aliases: ["eggs", "chicken egg", "hen egg", "large egg", "whole egg"],
    per100g: nutritionPer100g({
      kcal: 155,
      proteinG: 13,
      fatG: 11,
      carbsG: 1.1,
    }),
    allergenTags: ["egg"],
    portionAliases: { large: 50, medium: 44, piece: 50, serving: 100 },
    category: "dairy",
  },
  {
    id: "food-milk-whole-001",
    canonicalName: "whole milk",
    aliases: [
      "milk",
      "cow milk",
      "full fat milk",
      "full cream milk",
      "dairy milk",
    ],
    per100g: nutritionPer100g({
      kcal: 61,
      proteinG: 3.2,
      fatG: 3.3,
      carbsG: 4.8,
    }),
    allergenTags: ["milk"],
    portionAliases: { cup: 244, glass: 244, serving: 244, ml: 1 },
    category: "dairy",
  },
  {
    id: "food-milk-skim-001",
    canonicalName: "skim milk",
    aliases: ["nonfat milk", "fat free milk", "0% milk", "skimmed milk"],
    per100g: nutritionPer100g({
      kcal: 34,
      proteinG: 3.4,
      fatG: 0.1,
      carbsG: 5,
    }),
    allergenTags: ["milk"],
    portionAliases: { cup: 245, glass: 245, serving: 245, ml: 1 },
    category: "dairy",
  },
  {
    id: "food-cheese-001",
    canonicalName: "cheese",
    aliases: ["cheddar cheese", "hard cheese", "block cheese"],
    per100g: nutritionPer100g({
      kcal: 402,
      proteinG: 25,
      fatG: 33,
      carbsG: 1.3,
    }),
    allergenTags: ["milk"],
    portionAliases: { slice: 28, oz: 28, serving: 30, piece: 28 },
    category: "dairy",
  },
  {
    id: "food-yogurt-001",
    canonicalName: "yogurt",
    aliases: ["plain yogurt", "regular yogurt", "natural yogurt"],
    per100g: nutritionPer100g({
      kcal: 63,
      proteinG: 5.3,
      fatG: 1.6,
      carbsG: 7,
    }),
    allergenTags: ["milk"],
    portionAliases: { cup: 245, serving: 150, pot: 150 },
    category: "dairy",
  },
  {
    id: "food-greek-yogurt-001",
    canonicalName: "greek yogurt",
    aliases: ["strained yogurt", "greek style yogurt"],
    per100g: nutritionPer100g({ kcal: 97, proteinG: 9, fatG: 5, carbsG: 3.6 }),
    allergenTags: ["milk"],
    portionAliases: { cup: 200, serving: 150, pot: 150 },
    category: "dairy",
  },

  // ── fruits ─────────────────────────────────────────────────────────────
  {
    id: "food-banana-001",
    canonicalName: "banana",
    aliases: ["bananas", "ripe banana", "yellow banana"],
    per100g: nutritionPer100g({
      kcal: 89,
      proteinG: 1.1,
      fatG: 0.3,
      carbsG: 23,
    }),
    allergenTags: [],
    portionAliases: { piece: 118, medium: 118, serving: 100 },
    category: "fruit",
  },
  {
    id: "food-apple-001",
    canonicalName: "apple",
    aliases: ["apples", "fresh apple", "red apple", "green apple"],
    per100g: nutritionPer100g({
      kcal: 52,
      proteinG: 0.3,
      fatG: 0.2,
      carbsG: 14,
    }),
    allergenTags: [],
    portionAliases: { piece: 182, medium: 182, serving: 100 },
    category: "fruit",
  },
  {
    id: "food-orange-001",
    canonicalName: "orange",
    aliases: ["oranges", "fresh orange", "navel orange", "valencia orange"],
    per100g: nutritionPer100g({
      kcal: 47,
      proteinG: 0.9,
      fatG: 0.1,
      carbsG: 12,
    }),
    allergenTags: [],
    portionAliases: { piece: 131, medium: 131, serving: 100 },
    category: "fruit",
  },
  {
    id: "food-strawberry-001",
    canonicalName: "strawberry",
    aliases: ["strawberries", "fresh strawberries"],
    per100g: nutritionPer100g({
      kcal: 32,
      proteinG: 0.7,
      fatG: 0.3,
      carbsG: 7.7,
    }),
    allergenTags: [],
    portionAliases: { cup: 152, serving: 100, piece: 12 },
    category: "fruit",
  },
  {
    id: "food-blueberry-001",
    canonicalName: "blueberry",
    aliases: ["blueberries", "fresh blueberries"],
    per100g: nutritionPer100g({
      kcal: 57,
      proteinG: 0.7,
      fatG: 0.3,
      carbsG: 14,
    }),
    allergenTags: [],
    portionAliases: { cup: 148, serving: 100 },
    category: "fruit",
  },

  // ── legumes / nuts ────────────────────────────────────────────────────
  {
    id: "food-tofu-001",
    canonicalName: "tofu",
    aliases: ["bean curd", "firm tofu", "soybean curd", "soft tofu"],
    per100g: nutritionPer100g({
      kcal: 76,
      proteinG: 8,
      fatG: 4.8,
      carbsG: 1.9,
    }),
    allergenTags: ["soy"],
    portionAliases: { block: 300, piece: 100, serving: 100, cup: 248 },
    category: "legume_nut",
  },
  {
    id: "food-peanut-butter-001",
    canonicalName: "peanut butter",
    aliases: ["peanut spread", "smooth peanut butter", "crunchy peanut butter"],
    per100g: nutritionPer100g({
      kcal: 588,
      proteinG: 25,
      fatG: 50,
      carbsG: 20,
    }),
    allergenTags: ["peanut"],
    portionAliases: { tbsp: 16, tablespoon: 16, serving: 32, oz: 28 },
    category: "legume_nut",
  },
  {
    id: "food-almond-001",
    canonicalName: "almond",
    aliases: ["almonds", "raw almonds", "whole almonds"],
    per100g: nutritionPer100g({
      kcal: 579,
      proteinG: 21,
      fatG: 50,
      carbsG: 22,
    }),
    allergenTags: ["tree_nut"],
    portionAliases: { oz: 28, serving: 28, piece: 1.2, handful: 28 },
    category: "legume_nut",
  },
  {
    id: "food-walnut-001",
    canonicalName: "walnut",
    aliases: ["walnuts", "raw walnuts", "english walnuts"],
    per100g: nutritionPer100g({
      kcal: 654,
      proteinG: 15,
      fatG: 65,
      carbsG: 14,
    }),
    allergenTags: ["tree_nut"],
    portionAliases: { oz: 28, serving: 28, piece: 4, handful: 28 },
    category: "legume_nut",
  },

  // ── beverages ──────────────────────────────────────────────────────────
  {
    id: "food-orange-juice-001",
    canonicalName: "orange juice",
    aliases: ["oj", "fresh orange juice", "squeezed orange juice"],
    per100g: nutritionPer100g({
      kcal: 45,
      proteinG: 0.7,
      fatG: 0.2,
      carbsG: 10,
    }),
    allergenTags: [],
    portionAliases: { cup: 248, glass: 248, serving: 248, ml: 1 },
    category: "beverage",
  },
  {
    id: "food-coffee-001",
    canonicalName: "coffee",
    aliases: ["black coffee", "brewed coffee", "filter coffee", "drip coffee"],
    per100g: nutritionPer100g({ kcal: 2, proteinG: 0.1, fatG: 0, carbsG: 0 }),
    allergenTags: [],
    portionAliases: { cup: 240, mug: 350, serving: 240, ml: 1 },
    category: "beverage",
  },
];
