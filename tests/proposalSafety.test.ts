import { describe, expect, it } from "vitest";
import type { WriteProposalData } from "../src/harness/types";
import type { DrugNutrientInteraction } from "../src/lib/drugInteractions";
import {
  matchQualityLabel,
  projectProposalSafetyNotices,
  type ProposalSafetyNotice,
} from "../src/lib/proposalSafety";

function baseProposal(
  overrides: Partial<WriteProposalData> = {},
): WriteProposalData {
  return {
    proposalId: "p-1",
    foodName: "spinach",
    portionG: 100,
    mealType: "lunch",
    nutritionSource: "usda-test",
    createdAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

const warfarinSpinach: DrugNutrientInteraction = {
  drugName: "warfarin",
  nutrient: "vitamin K",
  foodExamples: ["spinach", "kale"],
  severity: "high",
  source: "NIH",
};

const metforminGrapefruit: DrugNutrientInteraction = {
  drugName: "metformin",
  nutrient: "alcohol",
  foodExamples: ["beer", "wine"],
  severity: "moderate",
  source: "NIH",
};

describe("matchQualityLabel", () => {
  it("returns null for exact (no extra badge)", () => {
    expect(matchQualityLabel("exact")).toBeNull();
  });

  it("returns null for alias (optional canonical name is separate)", () => {
    expect(matchQualityLabel("alias")).toBeNull();
  });

  it("marks fuzzy as estimated", () => {
    expect(matchQualityLabel("fuzzy")).toEqual({
      kind: "estimated",
      label: "Estimated match",
    });
  });

  it("marks low confidence and unknown distinctly", () => {
    expect(matchQualityLabel("miss_low_confidence")?.kind).toBe("uncertain");
    expect(matchQualityLabel("miss_unknown")?.kind).toBe("unknown");
  });

  it("returns null for missing matchType", () => {
    expect(matchQualityLabel(undefined)).toBeNull();
  });
});

describe("projectProposalSafetyNotices", () => {
  it("emits allergen notices from proposal.allergenTags before confirm", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ allergenTags: ["dairy", "egg"] }),
      [],
    );
    expect(notices).toEqual<ProposalSafetyNotice[]>([
      {
        kind: "allergen",
        severity: "high",
        title: "Allergen",
        detail: "dairy",
      },
      {
        kind: "allergen",
        severity: "high",
        title: "Allergen",
        detail: "egg",
      },
    ]);
  });

  it("emits unreviewed allergen notice when allergenCoverage is unreviewed", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ allergenTags: [], allergenCoverage: "unreviewed" }),
      [],
    );
    expect(notices.some((n) => n.title === "Allergen coverage")).toBe(true);
    expect(notices[0]?.detail.toLowerCase()).toContain("not reviewed");
  });

  it("does not emit allergen notices when coverage is reviewed empty", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ allergenTags: [], allergenCoverage: "reviewed" }),
      [],
    );
    expect(notices.filter((n) => n.kind === "allergen")).toHaveLength(0);
  });

  it("includes only drug interactions relevant to the proposal food", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ foodName: "Spinach omelette", canonicalName: "spinach" }),
      [warfarinSpinach, metforminGrapefruit],
    );
    const drugs = notices.filter((n) => n.kind === "drug_interaction");
    expect(drugs).toHaveLength(1);
    expect(drugs[0]).toMatchObject({
      kind: "drug_interaction",
      severity: "high",
      title: "warfarin × vitamin K",
    });
    expect(drugs[0]?.detail.toLowerCase()).toContain("spinach");
    expect(drugs[0]?.detail.toLowerCase()).toContain("high-severity");
    expect(drugs[0]?.detail.startsWith("Avoid ")).toBe(false);
  });

  it("uses neutral interaction wording for moderate severity (no Avoid)", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ foodName: "beer battered fish" }),
      [metforminGrapefruit],
    );
    const drugs = notices.filter((n) => n.kind === "drug_interaction");
    expect(drugs).toHaveLength(1);
    expect(drugs[0]?.severity).toBe("moderate");
    expect(drugs[0]?.detail.toLowerCase()).toContain("moderate-severity");
    expect(drugs[0]?.detail.startsWith("Avoid ")).toBe(false);
  });

  it("does not match interaction food examples as substrings (ham ≠ graham)", () => {
    const hamRule: DrugNutrientInteraction = {
      drugName: "maoie",
      nutrient: "tyramine",
      foodExamples: ["ham"],
      severity: "high",
      source: "NIH",
    };
    const notices = projectProposalSafetyNotices(
      baseProposal({ foodName: "graham crackers" }),
      [hamRule],
    );
    expect(notices.filter((n) => n.kind === "drug_interaction")).toHaveLength(
      0,
    );
  });

  it("does not dump unrelated medication rules onto every meal", () => {
    const notices = projectProposalSafetyNotices(
      baseProposal({ foodName: "plain rice", allergenTags: [] }),
      [warfarinSpinach, metforminGrapefruit],
    );
    expect(notices.filter((n) => n.kind === "drug_interaction")).toHaveLength(
      0,
    );
  });

  it("returns empty when allergens are reviewed-empty and no interactions match", () => {
    expect(
      projectProposalSafetyNotices(
        baseProposal({ foodName: "rice", allergenTags: [] }),
        [],
      ),
    ).toEqual([]);
  });
});
