// Advisory Structure Gate — verifies that when conflicts exist and food
// recommendations are present, the typed output includes advisory RuleRefs
// citing valid rule IDs (ADD §Gates / Output gate).
//
// This is one of the four output gate checks. It makes "advisory in prose"
// checkable (field present, rule id valid) instead of relying on a fuzzy
// prose judgment. The model must produce structured RuleRefs when safety
// conflicts demand them.

import type { TypedOutput } from "./types";

// ─── types ─────────────────────────────────────────────────────────────────

/**
 * A safety conflict that the advisory gate checks resolution of.
 * These are detected at the input gate or present in proposal entities.
 */
export interface Conflict {
  /** The kind of conflict. */
  readonly type: "allergy" | "drug_interaction";
  /** Stable identifier for the conflict (allergen name or drug-interaction rule id). */
  readonly id: string;
  /** Human-readable description for evidence messages. */
  readonly description: string;
}

export interface AdvisoryStructureInput {
  /** Typed final output to check. */
  readonly output: TypedOutput;
  /** Conflicts detected at input or present in proposal entities. */
  readonly conflicts: readonly Conflict[];
}

export interface AdvisoryStructureResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

// ─── validation ────────────────────────────────────────────────────────────

function isValidRuleId(ruleId: unknown): boolean {
  return typeof ruleId === "string" && ruleId.trim().length > 0;
}

// ─── main check ────────────────────────────────────────────────────────────

/**
 * Check that advisory RuleRefs are present and structurally valid when
 * conflicts exist and food recommendations are being made.
 *
 * Implements ADD §Output gate check (c): Advisory Structure.
 *
 * The check is structural, not semantic: it validates that ruleRefs
 * exist and have valid ruleIds when the situation requires them.
 * It does not judge whether the specific rule ids are correct for the
 * conflicts — that's the model's job.
 */
export function checkAdvisoryStructure(
  input: AdvisoryStructureInput,
): AdvisoryStructureResult {
  const { output, conflicts } = input;

  // No conflicts → no advisory requirement
  if (conflicts.length === 0) {
    return { passed: true, reasons: [] };
  }

  // No food recommendations → advisory not required
  // (the lexical backstop handles food mentions in prose)
  const foodRefs = output.foodRefs ?? [];
  if (foodRefs.length === 0) {
    return { passed: true, reasons: [] };
  }

  // Conflicts exist AND food recommendations are present —
  // ruleRefs must be non-empty and structurally valid.
  const ruleRefs = output.ruleRefs ?? [];
  const reasons: string[] = [];

  if (ruleRefs.length === 0) {
    reasons.push(
      `Missing advisory ruleRefs: food recommendations are present ` +
        `but no advisory rules were cited. Conflicts requiring advisories: ` +
        conflicts.map((c) => c.id).join(", "),
    );
    return { passed: false, reasons };
  }

  // Check each ruleRef has a valid ruleId
  const invalid = ruleRefs
    .map((ref, i) => ({ ref, i }))
    .filter(({ ref }) => !isValidRuleId(ref.ruleId));

  if (invalid.length > 0) {
    reasons.push(
      `Invalid ruleRef entries: ${invalid.length} ruleRef(s) have empty or missing ruleIds ` +
        `(indices: ${invalid.map(({ i }) => i).join(", ")}). ` +
        `Conflicts present: ${conflicts.map((c) => c.id).join(", ")}.`,
    );
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}
