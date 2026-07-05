// Deterministic Food Resolver — exact → alias → fuzzy cascade.
//
// Pure function: accepts a Catalog + input string, returns a typed
// ResolveResult. The model proposes strings; the resolver mints FoodRefs.
// The model cannot invent food ids — only the resolver can produce a FoodRef.
//
// Fuzzy matching uses bigram Jaccard similarity for typo-tolerant lookup.
// Configurable thresholds allow tuning the match/miss boundary.

import type {
  Catalog,
  CatalogFood,
  FoodRef,
  MatchType,
  ResolveResult,
} from "./catalog";
import { CATALOG_SNAPSHOT_VERSION } from "./catalog";

// ─── config ────────────────────────────────────────────────────────────────

export interface ResolverConfig {
  /** Score ≥ this → proceed as fuzzy match (if single dominant). */
  readonly fuzzyHighThreshold: number;
  /** Score ≥ this → candidates exist but not confident enough. */
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

const DEFAULTS: ResolverConfig = {
  fuzzyHighThreshold: DEFAULT_FUZZY_HIGH,
  fuzzyMediumThreshold: DEFAULT_FUZZY_MEDIUM,
  ambiguityMargin: DEFAULT_AMBIGUITY_MARGIN,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
};

// ─── bigram Jaccard similarity ─────────────────────────────────────────────

/**
 * Extract adjacent-character bigrams from a string.
 * Returns an empty set for strings shorter than 2 characters (no bigrams).
 *
 * Example: "ab" → {"ab"}, "abc" → {"ab","bc"}, "a" → {}.
 */
function bigrams(s: string): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.substring(i, i + 2));
  }
  return result;
}

/**
 * Bigram Jaccard similarity: |A ∩ B| / |A ∪ B|.
 *
 * Returns 0 when either string produces no bigrams (length < 2).
 * Returns 1.0 for identical strings.
 */
function bigramJaccard(a: string, b: string): number {
  const bgA = bigrams(a);
  const bgB = bigrams(b);

  if (bgA.size === 0 || bgB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) intersection++;
  }

  return intersection / (bgA.size + bgB.size - intersection);
}

// ─── FoodRef factory ───────────────────────────────────────────────────────

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

// ─── classification ────────────────────────────────────────────────────────

interface ScoredCandidate {
  readonly food: CatalogFood;
  readonly score: number;
}

function classifyByScore(
  scored: readonly ScoredCandidate[],
  config: ResolverConfig,
): { matchType: MatchType; candidates: FoodRef[] } {
  if (scored.length === 0) {
    return { matchType: "miss_unknown", candidates: [] };
  }

  const best = scored[0];
  const secondBest = scored[1];

  const gap = secondBest !== undefined ? best.score - secondBest.score : 1.0;

  // Single dominant candidate at high confidence → fuzzy match, proceed.
  if (best.score >= config.fuzzyHighThreshold && gap >= config.ambiguityMargin) {
    return {
      matchType: "fuzzy",
      candidates: [makeFoodRef(best.food, "fuzzy", best.score)],
    };
  }

  // Best score in medium range → candidates exist but not confident.
  if (best.score >= config.fuzzyMediumThreshold) {
    // Within ambiguity margin of second best → ambiguous.
    if (gap < config.ambiguityMargin) {
      const refs = scored
        .slice(0, config.maxCandidates)
        .map((c) => makeFoodRef(c.food, "fuzzy", c.score));
      return { matchType: "miss_ambiguous", candidates: refs };
    }

    // Single but below high threshold → low confidence.
    const refs = scored
      .slice(0, config.maxCandidates)
      .map((c) => makeFoodRef(c.food, "fuzzy", c.score));
    return { matchType: "miss_low_confidence", candidates: refs };
  }

  // Below medium threshold → unknown.
  return { matchType: "miss_unknown", candidates: [] };
}

// ─── fuzzy scan ────────────────────────────────────────────────────────────

/**
 * Score every food in the catalog against the input using bigram Jaccard
 * on the canonical name. Sort descending by score.
 */
function fuzzyScan(
  catalog: Catalog,
  normalized: string,
  config: ResolverConfig,
): ScoredCandidate[] {
  const results: ScoredCandidate[] = [];

  for (const food of catalog.allFoods) {
    const score = bigramJaccard(normalized, food.canonicalName);
    if (score > 0) {
      results.push({ food, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─── resolve ───────────────────────────────────────────────────────────────

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
 * @param catalog — the catalog to resolve against (from createCatalog())
 * @param input   — the raw food string (e.g. user utterance or model output)
 * @param config  — optional tuning overrides for fuzzy thresholds
 */
export function resolveFood(
  catalog: Catalog,
  input: string,
  config?: Partial<ResolverConfig>,
): ResolveResult {
  const cfg: ResolverConfig = { ...DEFAULTS, ...config };
  // Collapse whitespace: trim + normalize internal runs to single spaces.
  const normalized = input.trim().replace(/\s+/g, " ");

  // Empty / whitespace-only — no match possible.
  if (normalized.length === 0) {
    return {
      matchType: "miss_unknown",
      foodRef: null,
      catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
      input,
    };
  }

  const lower = normalized.toLowerCase();

  // 1. Exact match on canonical name.
  const exact = catalog.foods.get(lower);
  if (exact) {
    return {
      matchType: "exact",
      foodRef: makeFoodRef(exact, "exact", 1.0),
      catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
      input,
    };
  }

  // 2. Alias table lookup.
  const aliasTarget = catalog.aliasIndex.get(lower);
  if (aliasTarget) {
    const food = catalog.foods.get(aliasTarget);
    if (food) {
      return {
        matchType: "alias",
        foodRef: makeFoodRef(food, "alias", 1.0),
        catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
        input,
      };
    }
  }

  // 3. Fuzzy scan — score every food, classify the result.
  const scored = fuzzyScan(catalog, lower, cfg);
  const { matchType, candidates } = classifyByScore(scored, cfg);

  // Fuzzy match → return the FoodRef directly.
  if (matchType === "fuzzy" && candidates.length > 0) {
    return {
      matchType: "fuzzy",
      foodRef: candidates[0],
      catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
      input,
    };
  }

  // Any miss type — return null FoodRef with optional candidates.
  return {
    matchType,
    foodRef: null,
    catalogSnapshotId: CATALOG_SNAPSHOT_VERSION,
    candidates: candidates.length > 0 ? candidates : undefined,
    input,
  };
}
