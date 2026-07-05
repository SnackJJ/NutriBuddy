// Deterministic Food Resolver - exact -> alias -> fuzzy cascade.
//
// Pure function: accepts a Catalog + input string, returns a typed
// ResolveResult. The model proposes strings; the resolver mints FoodRefs.
// The model cannot invent food ids; only the resolver can produce a FoodRef.
//
// Fuzzy matching uses bigram Jaccard similarity for typo-tolerant lookup.
// Configurable thresholds allow tuning the match/miss boundary.

import {
  CATALOG_SNAPSHOT_VERSION,
  type Catalog,
  type CatalogFood,
  type FoodRef,
  type MatchType,
  type ResolveResult,
} from "./catalog";

export interface ResolverConfig {
  /** Score at or above this value can resolve as a fuzzy match. */
  readonly fuzzyHighThreshold: number;
  /** Score at or above this value can return candidates for clarification. */
  readonly fuzzyMediumThreshold: number;
  /** Gap between 1st and 2nd best must exceed this for "single dominant". */
  readonly ambiguityMargin: number;
  /** Maximum number of candidates returned in miss results. */
  readonly maxCandidates: number;
}

export const DEFAULT_FUZZY_HIGH = 0.75;
export const DEFAULT_FUZZY_MEDIUM = 0.45;
export const DEFAULT_AMBIGUITY_MARGIN = 0.12;
export const DEFAULT_MAX_CANDIDATES = 5;

const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  fuzzyHighThreshold: DEFAULT_FUZZY_HIGH,
  fuzzyMediumThreshold: DEFAULT_FUZZY_MEDIUM,
  ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
};

/**
 * Extract adjacent-character bigrams from a string.
 * Returns an empty set for strings shorter than 2 characters (no bigrams).
 *
 * Example: "ab" -> {"ab"}, "abc" -> {"ab","bc"}, "a" -> {}.
 */
function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.substring(i, i + 2));
  }
  return result;
}

/**
 * Bigram Jaccard similarity: size(intersection) / size(union).
 *
 * Returns 0 when either string produces no bigrams (length < 2).
 * Returns 1.0 for identical strings.
 */
function bigramJaccard(a: string, b: string): number {
  const bgA = bigrams(a);
  const bgB = bigrams(b);

  if (bgA.size === 0 || bgB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) {
      intersection++;
    }
  }

  return intersection / (bgA.size + bgB.size - intersection);
}

function makeFoodRef(
  food: CatalogFood,
  matchType: "exact" | "alias" | "fuzzy",
  matchScore: number,
): FoodRef {
  return {
    foodId: food.id,
    canonicalName: food.canonicalName,
    per100g: food.per100g,
    allergenTags: food.allergenTags,
    matchType,
    matchScore,
  };
}

type FoodRefMatchType = FoodRef["matchType"];
type MissMatchType = Exclude<MatchType, FoodRefMatchType>;

interface ScoredCandidate {
  readonly food: CatalogFood;
  readonly score: number;
}

type ScoreClassification =
  | { readonly matchType: "fuzzy"; readonly foodRef: FoodRef }
  | {
      readonly matchType: MissMatchType;
      readonly candidates: readonly FoodRef[];
    };

function makeFoodRefResult(input: string, foodRef: FoodRef): ResolveResult {
  return {
    matchType: foodRef.matchType,
    foodRef,
    catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
    input,
  };
}

function makeMatchedResult(
  input: string,
  food: CatalogFood,
  matchType: FoodRefMatchType,
  matchScore: number,
): ResolveResult {
  return makeFoodRefResult(input, makeFoodRef(food, matchType, matchScore));
}

function makeMissResult(
  input: string,
  matchType: MissMatchType,
  candidates?: readonly FoodRef[],
): ResolveResult {
  if (candidates === undefined) {
    return {
      matchType,
      foodRef: null,
      catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
      input,
    };
  }

  return {
    matchType,
    foodRef: null,
    catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
    candidates: candidates.length > 0 ? candidates : undefined,
    input,
  };
}

function makeCandidateRefs(
  scored: readonly ScoredCandidate[],
  maxCandidates: number,
): FoodRef[] {
  return scored
    .slice(0, maxCandidates)
    .map((candidate) => makeFoodRef(candidate.food, "fuzzy", candidate.score));
}

function classifyByScore(
  scored: readonly ScoredCandidate[],
  config: ResolverConfig,
): ScoreClassification {
  const [best, secondBest] = scored;

  if (best === undefined) {
    return { matchType: "miss_unknown", candidates: [] };
  }

  const gap = secondBest !== undefined ? best.score - secondBest.score : 1.0;

  if (
    best.score >= config.fuzzyHighThreshold &&
    gap >= config.ambiguityMargin
  ) {
    return {
      matchType: "fuzzy",
      foodRef: makeFoodRef(best.food, "fuzzy", best.score),
    };
  }

  if (best.score < config.fuzzyMediumThreshold) {
    return { matchType: "miss_unknown", candidates: [] };
  }

  const candidates = makeCandidateRefs(scored, config.maxCandidates);
  if (gap < config.ambiguityMargin) {
    return { matchType: "miss_ambiguous", candidates };
  }

  return { matchType: "miss_low_confidence", candidates };
}

/**
 * Score every food in the catalog against the input using bigram Jaccard
 * on the canonical name. Sort descending by score.
 */
function fuzzyScan(catalog: Catalog, query: string): ScoredCandidate[] {
  const results: ScoredCandidate[] = [];

  for (const food of catalog.allFoods) {
    const score = bigramJaccard(query, food.canonicalName);
    if (score > 0) {
      results.push({ food, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Resolve a food string against the catalog using the deterministic cascade:
 *
 *   1. Exact match on canonical name
 *   2. Alias table lookup
 *   3. Fuzzy scan with bigram Jaccard similarity
 *
 * Returns a typed ResolveResult: matched FoodRef for exact/alias/fuzzy hits,
 * or a typed miss (miss_ambiguous / miss_low_confidence / miss_unknown) with
 * top-k candidates for clarification context.
 *
 * The model proposes strings; the resolver mints FoodRefs. The model cannot
 * invent or bypass the catalog id namespace.
 *
 * @param catalog - the catalog to resolve against (from createCatalog())
 * @param input - the raw food string (e.g. user utterance or model output)
 * @param config - optional tuning overrides for fuzzy thresholds
 */
export function resolveFood(
  catalog: Catalog,
  input: string,
  config?: Partial<ResolverConfig>,
): ResolveResult {
  const cfg: ResolverConfig = { ...DEFAULT_RESOLVER_CONFIG, ...config };
  const normalized = input.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return makeMissResult(input, "miss_unknown");
  }

  const lower = normalized.toLowerCase();

  const exact = catalog.foods.get(lower);
  if (exact) {
    return makeMatchedResult(input, exact, "exact", 1.0);
  }

  const aliasTarget = catalog.aliasIndex.get(lower);
  if (aliasTarget) {
    const food = catalog.foods.get(aliasTarget);
    if (food) {
      return makeMatchedResult(input, food, "alias", 1.0);
    }
  }

  const scored = fuzzyScan(catalog, lower);
  const classification = classifyByScore(scored, cfg);

  if (classification.matchType === "fuzzy") {
    return makeFoodRefResult(input, classification.foodRef);
  }

  return makeMissResult(
    input,
    classification.matchType,
    classification.candidates,
  );
}
