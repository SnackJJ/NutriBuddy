// Proposal confirmation safety / match-quality projections (RFC 0004 §6.1 / §6.4).
// Pure functions: turn/wire data in → UI notices out. No prose parsing.

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
 */
export function projectProposalSafetyNotices(
  proposal: Pick<
    WriteProposalData,
    "foodName" | "canonicalName" | "allergenTags"
  >,
  interactions: readonly DrugNutrientInteraction[],
): readonly ProposalSafetyNotice[] {
  const notices: ProposalSafetyNotice[] = [];

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

  const haystack = normalize(
    [proposal.foodName, proposal.canonicalName].filter(Boolean).join(" "),
  );

  for (const interaction of interactions) {
    if (!interactionRelevantToFood(haystack, interaction)) continue;
    notices.push({
      kind: "drug_interaction",
      severity: interaction.severity,
      title: `${interaction.drugName} × ${interaction.nutrient}`,
      detail: `Avoid foods like ${interaction.foodExamples.join(", ")} (${interaction.source})`,
    });
  }

  return notices;
}

function interactionRelevantToFood(
  foodHaystack: string,
  interaction: DrugNutrientInteraction,
): boolean {
  if (!foodHaystack) return false;
  for (const example of interaction.foodExamples) {
    const term = normalize(example);
    if (term && foodHaystack.includes(term)) return true;
  }
  const nutrient = normalize(interaction.nutrient);
  if (nutrient && foodHaystack.includes(nutrient)) return true;
  return false;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
