// Metric aggregation (#92 / RFC 0009 §4).
//
// The two properties worth asserting here are the ones a reader would otherwise
// have to trust: a percentile never reports a value no sample produced (nearest
// rank, not interpolation), and a rate with no data is absent rather than 0 —
// "0 of 0 passed" and "0 of 29 passed" are different claims.

import { describe, expect, it } from "vitest";
import {
  countBy,
  distribution,
  groupOf,
  MEANINGFUL_SAMPLE_SIZE,
  METRIC_DEFINITIONS,
  percentile,
  rate,
  rateMetrics,
  summarizeEvalResults,
  topByCount,
} from "../src/eval/summary";
import type { BareResult, EvalCase, HarnessResult } from "../src/eval/types";

function bare(caseId: string, passed: boolean, response = "ok"): BareResult {
  return { caseId, response, passed, violations: passed ? [] : ["violation"], durationMs: 1 };
}

function harness(caseId: string, passed: boolean, overrides: Partial<HarnessResult> = {}): HarnessResult {
  return {
    caseId,
    response: "ok",
    steps: 2,
    stopReason: "end_turn",
    passed,
    violations: passed ? [] : ["violation"],
    toolCalls: [],
    gateBlocks: 0,
    durationMs: 1,
    ...overrides,
  };
}

function evalCase(id: string, expected: EvalCase["expected"] = {}): EvalCase {
  return { id, query: `query ${id}`, category: "simple", expected };
}

describe("percentile", () => {
  it("returns the only value for a single sample", () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("uses nearest rank, so it never invents an observation", () => {
    // Interpolated p95 of [1,2,3,4] would be 3.85 — a value no sample produced.
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(50);
  });

  it("handles the boundaries of a distribution", () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
    expect(percentile([1, 2, 3], 0.001)).toBe(1);
  });

  it("has nothing to say about an empty sample or an out-of-range q", () => {
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([1, 2, 3], 0)).toBeUndefined();
    expect(percentile([1, 2, 3], 1.5)).toBeUndefined();
  });
});

describe("distribution", () => {
  it("carries its sample size and the spread", () => {
    const d = distribution([5, 1, 3]);
    expect(d).toEqual({ n: 3, p50: 3, p95: 5, min: 1, max: 5, mean: 3 });
  });

  it("reports n=0 rather than zero-valued statistics when there is no data", () => {
    expect(distribution([])).toEqual({ n: 0 });
  });

  it("does not divide by zero for identical samples", () => {
    expect(distribution([4, 4, 4])).toEqual({ n: 3, p50: 4, p95: 4, min: 4, max: 4, mean: 4 });
  });
});

describe("counts", () => {
  it("sorts by key so two identical runs serialize identically", () => {
    expect(countBy(["b", "a", "b"]).map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(countBy(["b", "a", "b"])[1]).toEqual({ key: "b", count: 2, share: 2 / 3 });
  });

  it("takes the share from the population, not from the counted values", () => {
    expect(countBy(["gate_blocked"], 4)[0].share).toBe(0.25);
    expect(countBy([], 0)[0]?.share).toBeUndefined();
  });

  it("breaks top-N ties by key so the list is stable", () => {
    expect(topByCount(["z", "a"], 1).map((entry) => entry.key)).toEqual(["a"]);
  });
});

describe("rate", () => {
  it("is undefined when the population is empty (除零)", () => {
    expect(rate(0, 0)).toEqual({ n: 0, value: undefined });
  });

  it("is a plain ratio otherwise", () => {
    expect(rate(1, 4)).toEqual({ n: 4, value: 0.25 });
  });
});

describe("groupOf", () => {
  it("treats a declared safety contract as a regression case", () => {
    expect(groupOf(evalCase("a", { mustNotContain: ["peanut"] }))).toBe("regression");
    expect(groupOf(evalCase("b", { shouldBeBlocked: true }))).toBe("regression");
    expect(groupOf(evalCase("c", { shouldBeBlocked: false }))).toBe("regression");
  });

  it("treats everything else as a capability case", () => {
    expect(groupOf(evalCase("d", { mustCallTools: ["search_food"] }))).toBe("capability");
    expect(groupOf(evalCase("e", {}))).toBe("capability");
    expect(groupOf(evalCase("f", { mustNotContain: [] }))).toBe("capability");
  });
});

describe("summarizeEvalResults", () => {
  const cases: EvalCase[] = [
    evalCase("r1", { mustNotContain: ["peanut"] }),
    evalCase("r2", { shouldBeBlocked: true }),
    evalCase("c1", { mustCallTools: ["search_food"] }),
    evalCase("c2", {}),
  ];

  it("groups capability and regression separately", () => {
    const summary = summarizeEvalResults(
      cases,
      [bare("r1", true), bare("r2", false), bare("c1", true), bare("c2", false)],
      [
        harness("r1", true),
        harness("r2", true),
        harness("c1", false),
        harness("c2", false),
      ],
    );

    const regression = summary.groups.find((group) => group.group === "regression");
    const capability = summary.groups.find((group) => group.group === "capability");
    expect(regression).toMatchObject({
      n: 2,
      measured: 2,
      barePassed: 1,
      harnessPassed: 2,
      deltaPoints: 50,
    });
    expect(capability).toMatchObject({
      n: 2,
      measured: 2,
      barePassed: 1,
      harnessPassed: 0,
      deltaPoints: -50,
    });
  });

  it("says whether the sample size permits percentage claims", () => {
    const small = summarizeEvalResults(cases, [], []);
    expect(small.sampleSize).toEqual({
      n: 4,
      meaningfulAt: MEANINGFUL_SAMPLE_SIZE,
      claimPercentages: false,
    });

    const many = Array.from({ length: MEANINGFUL_SAMPLE_SIZE }, (_, i) => evalCase(`c${i}`));
    expect(summarizeEvalResults(many, [], []).sampleSize.claimPercentages).toBe(true);
  });

  it("rates a group over the cases that ran, and says how many that was", () => {
    const summary = summarizeEvalResults(
      cases,
      [bare("r1", true)],
      [harness("r1", true), harness("c1", true)],
    );

    const regression = summary.groups.find((group) => group.group === "regression");
    const capability = summary.groups.find((group) => group.group === "capability");
    // r2 and c2 produced no result: the regression rate is 1/1, not 1/2.
    expect(regression).toMatchObject({ n: 2, measured: 1, harnessPassRate: 1 });
    expect(capability).toMatchObject({ n: 2, measured: 1, harnessPassRate: 1 });
  });

  it("publishes the metric definitions with the numbers", () => {
    const summary = summarizeEvalResults(cases, [bare("r1", true)], [harness("r1", true)]);
    expect(summary.definitions).toBe(METRIC_DEFINITIONS);
    expect(summary.definitions.map((d) => d.key)).toContain("traceWriteLatency");
    expect(summary.definitions.map((d) => d.key)).toContain("cacheHitRate");
  });

  it("leaves a rate undefined instead of zero when a case had no result", () => {
    const summary = summarizeEvalResults(cases, [], []);
    expect(summary.bare.passRate).toBeUndefined();
    expect(summary.harness.passRate).toBeUndefined();
    expect(summary.toolCallRate.value).toBeUndefined();
    expect(summary.bare.failed + summary.bare.passed).toBe(0);
  });

  it("counts violations, tool calls and gate blocks per arm", () => {
    const rates = rateMetrics(
      [bare("a", true, "according to USDA, 1g"), bare("b", false, "peanut butter")],
      [
        harness("a", true, { toolCalls: ["search_food"], response: "[source] x" }),
        harness("b", false, { gateBlocks: 1 }),
      ],
    );

    expect(rates.constraintViolationRate.bare).toEqual({ n: 2, value: 0.5 });
    expect(rates.toolCallRate).toEqual({ n: 2, value: 0.5 });
    expect(rates.gateTurnRate).toEqual({ n: 2, value: 0.5 });
    expect(rates.sourceComplianceRate.harness).toEqual({ n: 2, value: 0.5 });
    expect(rates.deltaPoints).toBe(0);
  });
});
