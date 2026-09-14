// Report comparison and regression marking (#95 / RFC 0009 §5).
//
// Two things get asserted here that a reader would otherwise have to trust: a
// change only counts as a regression when it crosses the published threshold in
// the worse direction, and a comparison between two reports whose datasets
// differ carries no verdict at all — "数据变了就不可比" has to be loud, because a
// delta table printed over a changed dataset is the most confident-looking wrong
// number the tool could produce.

import { describe, expect, it } from "vitest";
import {
  buildComparableSummary,
  compareSummaries,
  DEFAULT_COMPARE_THRESHOLDS,
  renderCompareMarkdown,
  type ComparableSummary,
} from "../src/eval/compare";
import { summarizeEvalResults } from "../src/eval/summary";
import type { EvalCase } from "../src/eval/types";

function summaryWith(overrides: Partial<ComparableSummary> = {}): ComparableSummary {
  return {
    barePassRate: 0.5,
    harnessPassRate: 0.8,
    deltaPoints: 30,
    groups: [
      { group: "regression", n: 14, harnessPassRate: 0.9 },
      { group: "capability", n: 15, harnessPassRate: 0.7 },
    ],
    constraintViolationRateHarness: 0.1,
    toolCallRate: 0.6,
    gateTurnRate: 0.2,
    turnLatency: { n: 20, p50: 2000, p95: 4000 },
    modelCallLatency: { n: 40, p50: 800, p95: 1500 },
    traceWriteLatency: { n: 400, p50: 40, p95: 90 },
    cost: { n: 20, totalUsd: 0.2, mean: 0.01 },
    cacheHitRate: 0.4,
    ...overrides,
  };
}

function identity(datasetHash = "abc", mode = "scripted") {
  return {
    beforeDatasetHash: datasetHash,
    afterDatasetHash: datasetHash,
    beforeMode: mode,
    afterMode: mode,
  };
}

function find(result: ReturnType<typeof compareSummaries>, key: string) {
  const delta = result.deltas.find((candidate) => candidate.key === key);
  if (!delta) throw new Error(`no delta ${key}`);
  return delta;
}

describe("compareSummaries", () => {
  it("flags a pass-rate drop past the threshold and not one inside it", () => {
    const borders = compareSummaries(
      summaryWith({ harnessPassRate: 0.8 }),
      summaryWith({ harnessPassRate: 0.79 }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(borders, "harnessPassRate").regressed).toBe(false);
    expect(find(borders, "harnessPassRate").delta).toBeCloseTo(-1);

    const drop = compareSummaries(
      summaryWith({ harnessPassRate: 0.8 }),
      summaryWith({ harnessPassRate: 0.77 }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(drop, "harnessPassRate").regressed).toBe(true);
    expect(find(drop, "harnessPassRate").delta).toBeCloseTo(-3);
  });

  it("flags a P95 rise past 20% and not one below it", () => {
    const mild = compareSummaries(
      summaryWith(),
      summaryWith({ turnLatency: { n: 20, p50: 2000, p95: 4600 } }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(mild, "turnLatency.p95").regressed).toBe(false);

    const bad = compareSummaries(
      summaryWith(),
      summaryWith({ turnLatency: { n: 20, p50: 2000, p95: 5000 } }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(bad, "turnLatency.p95").regressed).toBe(true);
  });

  it("flags a cost rise past 30%", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith({ cost: { n: 20, totalUsd: 0.26, mean: 0.014 } }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(result, "cost.perTurn").regressed).toBe(true);
    expect(result.regressions.map((delta) => delta.key)).toContain("cost.perTurn");
  });

  it("treats a rising constraint-violation rate as a regression", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith({ constraintViolationRateHarness: 0.2 }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(result, "constraintViolationRateHarness").regressed).toBe(true);
  });

  it("flags a per-group drop, since that is where a safety regression hides", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith({
        groups: [
          { group: "regression", n: 14, harnessPassRate: 0.6 },
          { group: "capability", n: 15, harnessPassRate: 0.7 },
        ],
      }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(result, "group.regression").regressed).toBe(true);
    expect(find(result, "group.capability").regressed).toBe(false);
  });

  it("refuses to judge anything when the dataset changed", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith({ harnessPassRate: 0.1 }),
      DEFAULT_COMPARE_THRESHOLDS,
      { ...identity(), afterDatasetHash: "different" },
    );

    expect(result.comparable).toBe(false);
    expect(result.regressions).toEqual([]);
    expect(result.reasons.join(" ")).toContain("不可比");
    expect(result.reasons.join(" ")).toContain("abc → different");
    expect(find(result, "harnessPassRate").regressed).toBe(false);
  });

  it("refuses to compare a scripted report with a live one", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith(),
      DEFAULT_COMPARE_THRESHOLDS,
      { ...identity(), afterMode: "live" },
    );
    expect(result.comparable).toBe(false);
    expect(result.reasons.join(" ")).toContain("mode differs");
  });

  it("counts a rise from a zero baseline as a regression rather than dividing by zero", () => {
    const result = compareSummaries(
      summaryWith({ cost: { n: 20, totalUsd: 0, mean: 0 } }),
      summaryWith({ cost: { n: 20, totalUsd: 0.05, mean: 0.0025 } }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    expect(find(result, "cost.perTurn").regressed).toBe(true);
  });

  it("says a metric with no data on one side cannot be judged", () => {
    const result = compareSummaries(
      summaryWith({ turnLatency: undefined }),
      summaryWith(),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    const delta = find(result, "turnLatency.p95");
    expect(delta.regressed).toBe(false);
    expect(delta.note).toContain("no data");
  });
});

describe("renderCompareMarkdown", () => {
  it("marks regressions and stays quiet when there are none", () => {
    const regression = compareSummaries(
      summaryWith(),
      summaryWith({ harnessPassRate: 0.5 }),
      DEFAULT_COMPARE_THRESHOLDS,
      identity(),
    );
    const rendered = renderCompareMarkdown(regression, "before-id", "after-id");
    expect(rendered).toContain("**倒退**");
    expect(rendered).toContain("倒退项 1 条");
    expect(rendered).toContain("-2pt");

    const clean = compareSummaries(summaryWith(), summaryWith(), DEFAULT_COMPARE_THRESHOLDS, identity());
    expect(renderCompareMarkdown(clean, "a", "b")).toContain("无指标越过倒退阈值");
  });

  it("says the table is not a verdict when the reports are not comparable", () => {
    const result = compareSummaries(
      summaryWith(),
      summaryWith(),
      DEFAULT_COMPARE_THRESHOLDS,
      { ...identity(), afterDatasetHash: "other" },
    );
    const rendered = renderCompareMarkdown(result, "before-id", "after-id");
    expect(rendered).toContain("**不可比");
    expect(rendered).toContain("| 不可比 |");
  });
});

describe("buildComparableSummary", () => {
  const cases: EvalCase[] = [
    { id: "a", query: "q", category: "simple", expected: { mustNotContain: ["x"] } },
  ];

  it("keeps the parts a comparison reads and nothing else", () => {
    const comparable = buildComparableSummary(
      summarizeEvalResults(cases, [], []),
      null,
    );
    expect(comparable.harnessPassRate).toBeUndefined();
    expect(comparable.turnLatency).toBeUndefined();
    expect(comparable.cost).toBeUndefined();
    expect(comparable.groups).toEqual([
      { group: "regression", n: 1, measured: 0, harnessPassRate: undefined },
      { group: "capability", n: 0, measured: 0, harnessPassRate: undefined },
    ]);
  });

  it("carries the trace percentiles and cost when telemetry is present", () => {
    const comparable = buildComparableSummary(summarizeEvalResults(cases, [], []), {
      window: { since: "a", until: "b" },
      turns: 3,
      turnLatency: { n: 3, p50: 100, p95: 200 },
      modelCallLatency: { n: 5, p50: 10, p95: 20 },
      traceWriteLatency: { n: 9, p50: 1, p95: 2 },
      cost: {
        n: 3,
        totalUsd: 0.03,
        perTurn: { n: 3, mean: 0.01 },
        tokenIn: 0,
        tokenOut: 0,
        cacheHitTokens: 0,
        promptTokens: 0,
      },
      stopReasons: [],
      steps: { n: 0 },
      gates: { checkpointVerdict: [], topCheckNames: [] },
      definitions: [],
    });

    expect(comparable.turnLatency).toEqual({ n: 3, p50: 100, p95: 200 });
    expect(comparable.cost).toEqual({ n: 3, totalUsd: 0.03, mean: 0.01 });
    expect(comparable.cacheHitRate).toBeUndefined();
  });
});
