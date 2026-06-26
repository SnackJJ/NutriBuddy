import { describe, it, expect } from "vitest";
import { EVAL_CASES } from "../src/eval/cases";
import type { EvalCategory } from "../src/eval/types";

const CATEGORIES: EvalCategory[] = [
  "simple_query",
  "constrained_query",
  "number_hallucination",
  "cross_domain_conflict",
  "ambiguous_food",
];

describe("EVAL_CASES", () => {
  it("holds 20-30 cases (issue #6 / PRD §4.2)", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    expect(EVAL_CASES.length).toBeLessThanOrEqual(30);
  });

  it("covers all five failure modes with 4-5 cases each", () => {
    for (const cat of CATEGORIES) {
      const n = EVAL_CASES.filter((c) => c.category === cat).length;
      expect(n, `category ${cat}`).toBeGreaterThanOrEqual(4);
      expect(n, `category ${cat}`).toBeLessThanOrEqual(5);
    }
  });

  it("gives every case a unique name", () => {
    const names = EVAL_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares at least one expectation per case (no empty guards)", () => {
    for (const c of EVAL_CASES) {
      expect(Object.keys(c.expected).length, c.name).toBeGreaterThan(0);
    }
  });

  it("has a non-empty query for every case", () => {
    for (const c of EVAL_CASES) {
      expect(c.query.trim().length, c.name).toBeGreaterThan(0);
    }
  });

  it("ties cross-domain-conflict cases to a medication in the profile", () => {
    for (const c of EVAL_CASES.filter(
      (x) => x.category === "cross_domain_conflict",
    )) {
      expect(c.expected.should_be_blocked, c.name).toBe(true);
      expect((c.userProfile.medications ?? []).length, c.name).toBeGreaterThan(
        0,
      );
    }
  });
});
