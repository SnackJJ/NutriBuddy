// The safety suite's shape (2026-09-28): the coverage floors its header promises.
//
// The rules live in `src/eval/safetyCases.ts`; this file makes the countable ones
// fail loudly when a later edit drops below them.

import { describe, expect, it } from "vitest";
import { SAFETY_CASES } from "../src/eval/safetyCases";
import { loadEvalCases } from "../src/eval/dataset";
import { EVAL_INTERACTION_FIXTURE } from "../src/eval/evalInteractions";

/** The allergen categories `gate.ts` expands (its ALLERGEN_SYNONYMS keys). */
const GATE_ALLERGENS = [
  "milk",
  "egg",
  "peanut",
  "tree_nut",
  "soy",
  "wheat",
  "fish",
  "shellfish",
  "sesame",
];

const withTag = (tag: string) => SAFETY_CASES.filter((c) => c.tags?.includes(tag));
const tagValue = (tags: readonly string[] | undefined, key: string) =>
  (tags ?? []).filter((t) => t.startsWith(`${key}:`));

describe("SAFETY_CASES", () => {
  it("holds at least 50 cases", () => {
    expect(SAFETY_CASES.length).toBeGreaterThanOrEqual(50);
  });

  it("gives every case exactly one intent, lang, variant and kind tag", () => {
    for (const c of SAFETY_CASES) {
      for (const key of ["intent", "lang", "variant", "kind"]) {
        expect(tagValue(c.tags, key), `${c.id} ${key}`).toHaveLength(1);
      }
    }
  });

  it("uses only the declared tag values", () => {
    const allowed = new Set([
      "intent:prescriptive",
      "intent:descriptive",
      "lang:en",
      "lang:zh",
      "variant:direct",
      "variant:synonym",
      "variant:indirect",
      "variant:paraphrase",
      "kind:allergen",
      "kind:interaction",
    ]);
    for (const c of SAFETY_CASES) {
      for (const tag of c.tags ?? []) expect(allowed, `${c.id} ${tag}`).toContain(tag);
    }
  });

  it("meets the coverage floors", () => {
    expect(withTag("intent:descriptive").length).toBeGreaterThanOrEqual(12);
    expect(withTag("intent:prescriptive").length).toBeGreaterThanOrEqual(12);
    expect(withTag("lang:zh").length).toBeGreaterThanOrEqual(12);
    expect(SAFETY_CASES.length - withTag("variant:direct").length).toBeGreaterThanOrEqual(20);
    for (const variant of ["synonym", "indirect", "paraphrase"]) {
      expect(withTag(`variant:${variant}`).length, variant).toBeGreaterThan(0);
    }
  });

  it("covers every gate allergen category at least twice", () => {
    for (const allergen of GATE_ALLERGENS) {
      const n = withTag("kind:allergen").filter((c) =>
        c.userContext?.allergies.includes(allergen),
      ).length;
      expect(n, allergen).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses only allergen keys the gate knows", () => {
    for (const c of SAFETY_CASES) {
      for (const allergen of c.userContext?.allergies ?? []) {
        expect(GATE_ALLERGENS, c.id).toContain(allergen);
      }
    }
  });

  it("asks at least one question per interaction rule in the fixture", () => {
    for (const rule of EVAL_INTERACTION_FIXTURE) {
      const n = withTag("kind:interaction").filter((c) =>
        c.userContext?.medications.includes(rule.drugName),
      ).length;
      expect(n, `${rule.drugName} + ${rule.nutrient}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("only uses drugs that exist in the eval interaction fixture", () => {
    const drugs = new Set(EVAL_INTERACTION_FIXTURE.map((rule) => rule.drugName));
    for (const c of withTag("kind:interaction")) {
      const meds = c.userContext?.medications ?? [];
      expect(meds.length, c.id).toBeGreaterThan(0);
      for (const med of meds) expect(drugs, `${c.id} ${med}`).toContain(med);
    }
  });

  it("gives every case a userContext", () => {
    for (const c of SAFETY_CASES) expect(c.userContext, c.id).toBeDefined();
  });

  it("uses sa-prefixed ids that are unique here and across all suites", () => {
    const ids = SAFETY_CASES.map((c) => c.id);
    for (const id of ids) expect(id).toMatch(/^sa\d{2,}$/);
    expect(new Set(ids).size).toBe(ids.length);
    const all = loadEvalCases("all").map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("stays within the existing categories", () => {
    for (const c of SAFETY_CASES) {
      expect(["constrained", "cross_domain", "descriptive"], c.id).toContain(c.category);
    }
  });

  it("expects descriptive cases to be let through, and never scores their wording", () => {
    for (const c of withTag("intent:descriptive")) {
      expect(c.expected.shouldBeBlocked, c.id).toBe(false);
      expect(c.expected.mustNotContain, c.id).toBeUndefined();
    }
  });

  it("scores prescriptive cases by outcome, not by whether the gate fired", () => {
    for (const c of withTag("intent:prescriptive")) {
      expect(c.expected.mustNotContain?.length ?? 0, c.id).toBeGreaterThan(0);
      expect(c.expected.shouldBeBlocked, c.id).not.toBe(true);
    }
  });

  it("lists Chinese and English forbidden terms for Chinese prescriptive cases", () => {
    const cjk = /[㐀-鿿]/;
    for (const c of withTag("intent:prescriptive").filter((x) => x.tags?.includes("lang:zh"))) {
      const terms = c.expected.mustNotContain ?? [];
      expect(terms.some((t) => cjk.test(t)), c.id).toBe(true);
      expect(terms.some((t) => /^[\x20-\x7e]+$/.test(t)), c.id).toBe(true);
    }
  });
});
