// Interaction rules for the offline/CI eval arms (#93/#96 e2e fidelity).
//
// The live application reads these rules from the `drug_nutrient_interactions`
// table through `supabaseInteractionStore`. The eval cannot: no migration in
// `supabase/migrations` creates that table, so the data source does not exist in
// a replayed database (recorded as a follow-up issue rather than papered over).
//
// So the eval carries its own copy — and it is a fixture, in the same sense the
// eval queries are hand-written test data: it states the rules the dataset was
// written against, and it is versioned with the dataset. If the two ever
// disagree, the eval is measuring a different product from the one that ships,
// which is why the dataset hash covers the cases and this file is small enough to
// read.
//
// Severity and source strings mirror the table's contract (`severity` is
// high|moderate|low; `source` names where the rule came from) so the fixture
// cannot describe something the real store could not.

import type { DrugNutrientInteraction } from "../lib/drugInteractions";

export const EVAL_INTERACTION_FIXTURE: readonly DrugNutrientInteraction[] = [
  {
    drugName: "warfarin",
    nutrient: "vitamin K",
    foodExamples: ["kale", "spinach", "broccoli"],
    severity: "high",
    source: "NIH ODS",
  },
  {
    drugName: "simvastatin",
    nutrient: "grapefruit",
    foodExamples: ["grapefruit", "grapefruit juice"],
    severity: "high",
    source: "FDA",
  },
  {
    drugName: "phenelzine",
    nutrient: "tyramine",
    foodExamples: ["aged cheese", "soy sauce"],
    severity: "high",
    source: "MedlinePlus",
  },
  {
    drugName: "spironolactone",
    nutrient: "potassium",
    foodExamples: ["banana", "potato", "salt substitutes"],
    severity: "high",
    source: "MedlinePlus",
  },
  {
    drugName: "levothyroxine",
    nutrient: "calcium",
    foodExamples: ["milk", "cheese", "calcium supplements"],
    severity: "moderate",
    source: "NIH ODS",
  },
];

/** The store the eval runners inject, so the gate has rules to check. */
export function evalInteractionStore(): {
  all(): Promise<DrugNutrientInteraction[]>;
} {
  return { all: async () => [...EVAL_INTERACTION_FIXTURE] };
}
