// Proposal confirmation safety / match-quality projections (RFC 0004 §6.1 / §6.4).
// Pure functions: turn/wire data in → UI notices out. No prose parsing.
// Prefer calling from the turn seam so all surfaces get the same typed notices.

import type { WriteProposalData } from "@/harness/types";
import type { DrugNutrientInteraction } from "@/lib/drugInteractions";

export type MatchQualityKind = "estimated" | "uncertain" | "unknown";

export interface MatchQualityBadge {
  readonly kind: MatchQualityKind;
  readonly label: string;
}

export type SafetyNoticeKind = "allergen" | "drug_interaction";

export interface ProposalSafetyNotice {
  readonly kind: SafetyNoticeKind;
  readonly severity: "high" | "moderate" | "low";
  readonly title: string;
  readonly detail: string;
}

/** Map resolver matchType to a user-visible badge. exact/alias need no badge. */
export function matchQualityLabel(
  matchType: string | undefined,
): MatchQualityBadge | null {
  if (!matchType) return null;
  switch (matchType) {
    case "exact":
    case "alias":
      return null;
    case "fuzzy":
      return { kind: "estimated", label: "Estimated match" };
    case "miss_low_confidence":
      return { kind: "uncertain", label: "Low confidence match" };
    case "miss_unknown":
    case "miss_ambiguous":
      return { kind: "unknown", label: "Unresolved match" };
    default:
      if (matchType.startsWith("miss_")) {
        return { kind: "unknown", label: "Unresolved match" };
      }
      return null;
  }
}

/**
 * Project allergen tags + proposal-relevant drug interactions for the
 * confirm card. Does not dump every medication rule onto every meal.
 * Intended to run at the turn seam (not only in React).
 */
export function projectProposalSafetyNotices(
  proposal: Pick<
    WriteProposalData,
    "foodName" | "canonicalName" | "allergenTags" | "allergenCoverage"
  >,
  interactions: readonly DrugNutrientInteraction[],
): readonly ProposalSafetyNotice[] {
  const notices: ProposalSafetyNotice[] = [];

  // Unreviewed coverage is explicit — do not treat stored [] as "safe".
  if (proposal.allergenCoverage === "unreviewed") {
    notices.push({
      kind: "allergen",
      severity: "high",
      title: "Allergen coverage",
      detail: "Not reviewed for allergens — treat as unknown before confirming",
    });
  } else {
    for (const tag of proposal.allergenTags ?? []) {
      const trimmed = tag.trim();
      if (!trimmed) continue;
      notices.push({
        kind: "allergen",
        severity: "high",
        title: "Allergen",
        detail: trimmed,
      });
    }
  }

  const haystack = [proposal.foodName, proposal.canonicalName]
    .filter(Boolean)
    .join(" ");

  for (const interaction of interactions) {
    const hit = matchingFoodExample(haystack, interaction);
    if (!hit) continue;
    notices.push({
      kind: "drug_interaction",
      severity: interaction.severity,
      title: `${interaction.drugName} × ${interaction.nutrient}`,
      detail: interactionDetail(interaction, hit),
    });
  }

  return notices;
}

function interactionDetail(
  interaction: DrugNutrientInteraction,
  matchedExample: string,
): string {
  // Rules carry severity/examples/source only — never invent clinical actions
  // like "avoid" from severity alone (Codex review).
  const examples = interaction.foodExamples.join(", ");
  return (
    `Known ${interaction.severity}-severity interaction with foods like ${examples} ` +
    `(matched "${matchedExample}"; ${interaction.source}). ` +
    `Confirm only if this matches your clinician guidance.`
  );
}

/**
 * Word-boundary phrase match (same idea as gate containsAnyTerm):
 * "ham" must not match "graham crackers".
 */
function matchingFoodExample(
  foodText: string,
  interaction: DrugNutrientInteraction,
): string | null {
  for (const example of interaction.foodExamples) {
    if (containsPhrase(foodText, example)) return example;
  }
  if (containsPhrase(foodText, interaction.nutrient)) {
    return interaction.nutrient;
  }
  return null;
}

function containsPhrase(text: string, phrase: string): boolean {
  const term = phrase.trim();
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "i");
  return regex.test(text);
}
