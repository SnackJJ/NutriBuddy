// Report comparison and regression marking (S2 / #95 / RFC 0009 §5).
//
// The point of the index is to answer "did this change make the product worse",
// and the answer has to survive someone reading it in a hurry. So a delta table
// is not enough: each row carries whether it crossed a threshold, and a
// comparison between two reports whose datasets differ is refused rather than
// printed — §5's "数据变了就不可比" is a property of the pair, not a footnote.
//
// Thresholds are defaults, not laws: they are arguments with published values so
// a stricter run is a flag rather than an edit.

import type { EvalResultSummary } from "./summary";
import type { TraceMetrics } from "./traceMetrics";

export interface CompareThresholds {
  /** Percentage points a pass rate may fall before it counts as a regression. */
  readonly passRateDropPoints: number;
  /** Relative rise in a P95 (0.2 = +20%) that counts as a latency regression. */
  readonly p95IncreaseRatio: number;
  /** Relative rise in per-turn cost that counts as a cost regression. */
  readonly costIncreaseRatio: number;
}

export const DEFAULT_COMPARE_THRESHOLDS: CompareThresholds = {
  passRateDropPoints: 2,
  p95IncreaseRatio: 0.2,
  costIncreaseRatio: 0.3,
};

/**
 * The projection `index.json` keeps — everything a comparison needs and nothing
 * that would make the index as large as the reports it indexes.
 */
export interface ComparableSummary {
  readonly barePassRate?: number;
  readonly harnessPassRate?: number;
  readonly deltaPoints?: number;
  readonly groups: readonly {
    readonly group: string;
    readonly n: number;
    /** Cases that produced a result; the population the rate is over. */
    readonly measured?: number;
    readonly harnessPassRate?: number;
  }[];
  readonly constraintViolationRateHarness?: number;
  readonly toolCallRate?: number;
  readonly gateTurnRate?: number;
  readonly turnLatency?: Dist;
  readonly modelCallLatency?: Dist;
  readonly traceWriteLatency?: Dist;
  readonly cost?: {
    readonly n: number;
    readonly totalUsd: number;
    readonly mean?: number;
  };
  readonly cacheHitRate?: number;
}

export interface Dist {
  readonly n: number;
  readonly p50?: number;
  readonly p95?: number;
}

export function buildComparableSummary(
  evalSummary: EvalResultSummary,
  traces: TraceMetrics | null,
): ComparableSummary {
  const dist = (value: Dist): Dist => ({
    n: value.n,
    p50: value.p50,
    p95: value.p95,
  });

  return {
    barePassRate: evalSummary.bare.passRate,
    harnessPassRate: evalSummary.harness.passRate,
    deltaPoints: evalSummary.deltaPoints,
    groups: evalSummary.groups.map((group) => ({
      group: group.group,
      n: group.n,
      measured: group.measured,
      harnessPassRate: group.harnessPassRate,
    })),
    constraintViolationRateHarness: evalSummary.constraintViolationRate.harness.value,
    toolCallRate: evalSummary.toolCallRate.value,
    gateTurnRate: evalSummary.gateTurnRate.value,
    turnLatency: traces ? dist(traces.turnLatency) : undefined,
    modelCallLatency: traces ? dist(traces.modelCallLatency) : undefined,
    traceWriteLatency: traces ? dist(traces.traceWriteLatency) : undefined,
    cost: traces
      ? {
          n: traces.cost.n,
          totalUsd: traces.cost.totalUsd,
          mean: traces.cost.perTurn.mean,
        }
      : undefined,
    cacheHitRate: traces?.cost.cacheHitRate,
  };
}

export type DeltaUnit = "pt" | "ratio" | "ms" | "usd";

export interface MetricDelta {
  readonly key: string;
  readonly label: string;
  readonly unit: DeltaUnit;
  readonly before?: number;
  readonly after?: number;
  /** `after - before`, in the row's own unit. */
  readonly delta?: number;
  /** True when the change crossed its threshold in the worse direction. */
  readonly regressed: boolean;
  readonly note?: string;
}

export interface CompareResult {
  /** False when the two reports describe different things (dataset or mode). */
  readonly comparable: boolean;
  readonly reasons: readonly string[];
  readonly deltas: readonly MetricDelta[];
  readonly regressions: readonly MetricDelta[];
  readonly thresholds: CompareThresholds;
}

function ratioDelta(
  key: string,
  label: string,
  unit: DeltaUnit,
  before: number | undefined,
  after: number | undefined,
  worse: "up" | "down",
  threshold: number,
): MetricDelta {
  if (before === undefined || after === undefined) {
    return {
      key,
      label,
      unit,
      before,
      after,
      regressed: false,
      note: "no data on one side — not comparable for this metric",
    };
  }

  const delta = after - before;
  const relative = before === 0 ? undefined : Math.abs(delta) / Math.abs(before);
  // A threshold on a relative change says nothing when the baseline is zero, so
  // the absolute change has to be strictly worse to count — a rise from 0 to
  // anything is a regression, and 0 → 0 is not.
  const regressed =
    worse === "up" ? (relative === undefined ? delta > 0 : relative >= threshold) : relative === undefined ? delta < 0 : relative >= threshold;

  return { key, label, unit, before, after, delta, regressed };
}

function pointDelta(
  key: string,
  label: string,
  before: number | undefined,
  after: number | undefined,
  dropPoints: number,
  regressedWhen: "fall" | "rise",
): MetricDelta {
  if (before === undefined || after === undefined) {
    return {
      key,
      label,
      unit: "pt",
      before,
      after,
      regressed: false,
      note: "no data on one side — not comparable for this metric",
    };
  }
  const delta = (after - before) * 100;
  const regressed = regressedWhen === "fall" ? delta <= -dropPoints : delta >= dropPoints;
  return { key, label, unit: "pt", before, after, delta, regressed };
}

/**
 * Compare two report summaries.
 *
 * Comparability is decided from the dataset hash and the mode: a report of a
 * different case set, or a scripted report against a live one, describes a
 * different measurement, and printing a delta between them would be the most
 * confident-looking wrong number in the directory. When they are not comparable,
 * the deltas are still returned (someone may want to see them) but every row is
 * marked as carrying no verdict.
 */
export function compareSummaries(
  before: ComparableSummary,
  after: ComparableSummary,
  thresholds: CompareThresholds = DEFAULT_COMPARE_THRESHOLDS,
  identity?: {
    readonly beforeDatasetHash?: string;
    readonly afterDatasetHash?: string;
    readonly beforeMode?: string;
    readonly afterMode?: string;
  },
): CompareResult {
  const reasons: string[] = [];
  if (
    identity?.beforeDatasetHash !== undefined &&
    identity?.afterDatasetHash !== undefined &&
    identity.beforeDatasetHash !== identity.afterDatasetHash
  ) {
    reasons.push(
      `dataset changed (${identity.beforeDatasetHash} → ${identity.afterDatasetHash}): 数据变了就不可比`,
    );
  }
  if (
    identity?.beforeMode !== undefined &&
    identity?.afterMode !== undefined &&
    identity.beforeMode !== identity.afterMode
  ) {
    reasons.push(
      `mode differs (${identity.beforeMode} vs ${identity.afterMode}): a scripted report and a live report measure different things`,
    );
  }
  const comparable = reasons.length === 0;

  const deltas: MetricDelta[] = [
    pointDelta(
      "harnessPassRate",
      "harness 通过率",
      before.harnessPassRate,
      after.harnessPassRate,
      thresholds.passRateDropPoints,
      "fall",
    ),
    pointDelta(
      "barePassRate",
      "bare 通过率",
      before.barePassRate,
      after.barePassRate,
      thresholds.passRateDropPoints,
      "fall",
    ),
    pointDelta(
      "constraintViolationRateHarness",
      "约束违反率 (harness)",
      before.constraintViolationRateHarness,
      after.constraintViolationRateHarness,
      thresholds.passRateDropPoints,
      "rise",
    ),
    pointDelta("toolCallRate", "工具调用率", before.toolCallRate, after.toolCallRate, thresholds.passRateDropPoints, "fall"),
    pointDelta("gateTurnRate", "闸拦截率", before.gateTurnRate, after.gateTurnRate, thresholds.passRateDropPoints, "fall"),
  ];

  for (const group of after.groups) {
    const previous = before.groups.find((candidate) => candidate.group === group.group);
    deltas.push(
      pointDelta(
        `group.${group.group}`,
        `${group.group} 组通过率 (n=${group.measured ?? group.n})`,
        previous?.harnessPassRate,
        group.harnessPassRate,
        thresholds.passRateDropPoints,
        "fall",
      ),
    );
  }

  deltas.push(
    ratioDelta("turnLatency.p95", "turn 墙钟 P95", "ms", before.turnLatency?.p95, after.turnLatency?.p95, "up", thresholds.p95IncreaseRatio),
    ratioDelta(
      "modelCallLatency.p95",
      "model_call P95",
      "ms",
      before.modelCallLatency?.p95,
      after.modelCallLatency?.p95,
      "up",
      thresholds.p95IncreaseRatio,
    ),
    ratioDelta(
      "traceWriteLatency.p95",
      "轨迹写入 P95",
      "ms",
      before.traceWriteLatency?.p95,
      after.traceWriteLatency?.p95,
      "up",
      thresholds.p95IncreaseRatio,
    ),
    ratioDelta("cost.perTurn", "每轮成本均值", "usd", before.cost?.mean, after.cost?.mean, "up", thresholds.costIncreaseRatio),
    ratioDelta("cacheHitRate", "缓存命中率", "ratio", before.cacheHitRate, after.cacheHitRate, "down", 1),
  );

  const marked = comparable
    ? deltas
    : deltas.map((delta) => ({ ...delta, regressed: false }));

  return {
    comparable,
    reasons,
    deltas: marked,
    regressions: marked.filter((delta) => delta.regressed),
    thresholds,
  };
}

function formatValue(value: number | undefined, unit: DeltaUnit): string {
  if (value === undefined) return "n/a";
  switch (unit) {
    case "pt":
      return `${(value * 100).toFixed(1)}%`;
    case "ratio":
      return value.toFixed(3);
    case "ms":
      return `${Math.round(value)}ms`;
    case "usd":
      return `$${value.toFixed(4)}`;
  }
}

function formatDelta(delta: number | undefined, unit: DeltaUnit): string {
  if (delta === undefined) return "n/a";
  const sign = delta > 0 ? "+" : "";
  switch (unit) {
    case "pt":
      return `${sign}${delta.toFixed(1)}pt`;
    case "ratio":
      return `${sign}${delta.toFixed(3)}`;
    case "ms":
      return `${sign}${Math.round(delta)}ms`;
    case "usd":
      return `${sign}$${delta.toFixed(4)}`;
  }
}

export function renderCompareMarkdown(
  result: CompareResult,
  beforeId: string,
  afterId: string,
): string {
  const lines: string[] = [];
  lines.push(`## 与 \`${beforeId}\` 对比`, "");
  lines.push(
    `阈值：通过率 ≤ -${result.thresholds.passRateDropPoints}pt、P95 ≥ +${Math.round(result.thresholds.p95IncreaseRatio * 100)}%、成本 ≥ +${Math.round(result.thresholds.costIncreaseRatio * 100)}%。`,
    "",
  );

  if (!result.comparable) {
    lines.push("**不可比（下面的 delta 不构成结论）**：", "");
    for (const reason of result.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }

  lines.push(`| 指标 | ${beforeId} | ${afterId} | Δ | 判定 |`, "| --- | --- | --- | --- | --- |");
  for (const delta of result.deltas) {
    const verdict = !result.comparable
      ? "不可比"
      : delta.regressed
        ? "**倒退**"
        : delta.note
          ? delta.note
          : "—";
    lines.push(
      `| ${delta.label} | ${formatValue(delta.before, delta.unit)} | ${formatValue(delta.after, delta.unit)} | ${formatDelta(delta.delta, delta.unit)} | ${verdict} |`,
    );
  }
  lines.push("");

  if (result.comparable && result.regressions.length > 0) {
    lines.push(`**倒退项 ${result.regressions.length} 条**：${result.regressions.map((delta) => delta.label).join("、")}`, "");
  } else if (result.comparable) {
    lines.push("无指标越过倒退阈值。", "");
  }

  return lines.join("\n");
}
