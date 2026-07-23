// Resolver miss projection for confirm/clarification UI (RFC 0004 §6.1).
// Pure: tool-outcome data in → typed candidates out. No prose parsing.

import type { JsonValue } from "@/harness/toolOutcome";

export type ResolverMissMatchType =
  | "miss_ambiguous"
  | "miss_low_confidence"
  | "miss_unknown"
  | "fuzzy"
  | string;

export interface ResolverCandidate {
  readonly foodId: string;
  readonly foodName: string;
  readonly matchScore?: number;
  readonly allergenTags?: readonly string[];
}

/**
 * Typed projection attached to the turn terminal when log_meal returns
 * a typed miss (or when the model needs a structured candidate list).
 */
export interface ResolverMissProjection {
  readonly matchType: ResolverMissMatchType;
  readonly input: string;
  readonly message: string;
  readonly candidates: readonly ResolverCandidate[];
  /** Last log_meal portion if known from the tool act. */
  readonly portionG?: number;
  readonly mealType?: string;
}

/** Build a user utterance that re-logs a chosen candidate without retyping free-form. */
export function utteranceForCandidatePick(
  candidate: ResolverCandidate,
  context: Pick<ResolverMissProjection, "portionG" | "mealType">,
): string {
  const portion = context.portionG ?? 100;
  const meal = context.mealType ?? "snack";
  return `Log ${portion}g of ${candidate.foodName} for ${meal}`;
}

/**
 * Project a log_meal typed_miss data blob + optional act args into UI shape.
 * Returns undefined if data is not a resolvable miss payload.
 */
export function projectResolverMiss(
  data: unknown,
  actArgs?: Readonly<Record<string, unknown>>,
): ResolverMissProjection | undefined {
  if (!isRecord(data)) return undefined;
  const matchType = readString(data, "match_type");
  if (!matchType) return undefined;

  const message =
    readString(data, "message") ??
    readString(data, "error") ??
    "Could not resolve that food.";
  const input =
    extractQuotedInput(readString(data, "error")) ??
    readString(actArgs ?? {}, "food_name") ??
    "";

  const rawCandidates = data.candidates;
  const candidates: ResolverCandidate[] = [];
  if (Array.isArray(rawCandidates)) {
    for (const item of rawCandidates) {
      const c = projectCandidate(item);
      if (c) candidates.push(c);
    }
  }

  const portionG = readNumber(actArgs ?? {}, "portion_g");
  const mealType = readString(actArgs ?? {}, "meal_type");

  return {
    matchType,
    input,
    message,
    candidates,
    ...(portionG !== undefined ? { portionG } : {}),
    ...(mealType ? { mealType } : {}),
  };
}

function projectCandidate(value: unknown): ResolverCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const foodId =
    readString(value, "food_id") ?? readString(value, "foodId") ?? "";
  const foodName =
    readString(value, "food_name") ??
    readString(value, "foodName") ??
    readString(value, "canonical_name") ??
    "";
  if (!foodId || !foodName) return undefined;
  const matchScore =
    readNumber(value, "match_score") ?? readNumber(value, "matchScore");
  const tags = readStringArray(value, "allergen_tags") ??
    readStringArray(value, "allergenTags");
  return {
    foodId,
    foodName,
    ...(matchScore !== undefined ? { matchScore } : {}),
    ...(tags ? { allergenTags: tags } : {}),
  };
}

function extractQuotedInput(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const m = error.match(/food not found in catalog: "([^"]+)"/i);
  return m?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = record[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const v = record[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    return undefined;
  }
  return v;
}

/** Type guard helper for tests / stream. */
export function isJsonRecord(value: JsonValue): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
