// Interaction rules for the offline/CI eval arms (#93/#96 e2e fidelity).
//
// The application reads these rules from the `drug_nutrient_interactions` table
// through `supabaseInteractionStore`; migration `0015` creates and seeds it
// (issue #125). The eval cannot use it all the same: the scripted arm runs with
// no database by design, so it carries its own copy — a fixture, in the same
// sense the eval queries are hand-written test data. It states the rules the
// dataset was written against, and it is versioned with the dataset.
//
// Two copies of a safety rule set is a drift risk with a specific shape: the eval
// would keep passing while production refused different food, or the reverse.
// `tests/interactionSeed.test.ts` parses the migration and compares the two, so
// the drift fails a test rather than a user.
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
