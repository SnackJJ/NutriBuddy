import { describe, it, expect } from "vitest";
import { loadEvalCases } from "../src/eval/dataset";
import type { EvalCategory } from "../src/eval/types";

const CATEGORIES: EvalCategory[] = [
  "simple",
  "constrained",
  "numeric",
  "cross_domain",
  "edge_case",
  "descriptive",
  "write",
];

const EVAL_CASES = loadEvalCases();

describe("EVAL_CASES", () => {
  it("holds 20-40 cases (issue #6 / PRD §4.2)", () => {
    // The ceiling moved from 30 on 2026-09-15, when `write` was added. It exists
    // to keep the set hand-reviewable, not to fix its size: the set had reached
    // the old bound while whole surfaces (the write path) still had no case
    // asserting anything about them, and a bound that forces a choice between
    // "reviewable" and "covers the product" picks the wrong one.
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    expect(EVAL_CASES.length).toBeLessThanOrEqual(40);
  });

  it("covers every category with 4-6 cases each", () => {
    for (const cat of CATEGORIES) {
      const n = EVAL_CASES.filter((c) => c.category === cat).length;
      expect(n, `category ${cat}`).toBeGreaterThanOrEqual(4);
      expect(n, `category ${cat}`).toBeLessThanOrEqual(6);
    }
  });

  it("makes every category reachable — the list above is the whole type", () => {
    // A category added to `EvalCategory` but not to CATEGORIES would be silently
    // exempt from the coverage rule above, which is how a group ships with one
    // case and no one notices.
    for (const c of EVAL_CASES) {
      expect(CATEGORIES, `category of ${c.id}`).toContain(c.category);
    }
  });

  it("gives every case a unique id", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares expectations for most constrained/cross_domain cases", () => {
    // Some numeric/cross_domain/edge cases are intentionally pass-through (expected: {}).
    let withExpectations = 0;
    for (const c of EVAL_CASES) {
      if (c.category === "constrained" || c.category === "cross_domain") {
        if (Object.keys(c.expected).length > 0) withExpectations++;
      }
    }
    // At least 80% of constrained/cross_domain cases should have expectations.
    const constrainedCross = EVAL_CASES.filter(
      (c) => c.category === "constrained" || c.category === "cross_domain",
    ).length;
    expect(withExpectations).toBeGreaterThan(constrainedCross * 0.8);
  });

  it("has a non-empty query for every case", () => {
    for (const c of EVAL_CASES) {
      expect(c.query.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it("ties cross-domain-conflict cases to a medication in userContext", () => {
    for (const c of EVAL_CASES.filter(
      (x) => x.category === "cross_domain",
    )) {
      expect(
        (c.userContext?.medications ?? []).length,
        c.id,
      ).toBeGreaterThan(0);
    }
  });
});
