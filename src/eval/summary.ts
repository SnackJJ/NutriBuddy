// Report-grade metric aggregation (S2 / #92 / RFC 0009 §4).
//
// `metrics.ts` computes the six metrics the console report has always shown;
// this module is what lands in `reports/`, and three §4 disciplines are
// structural here rather than editorial:
//
//   * a rate carries the n it came from, and a rate with no data is `undefined`
//     rather than 0 — "0 of 0 passed" and "0 of 40 passed" are different claims
//     and only one of them is bad news;
//   * capability and regression cases are grouped, because a dataset that mixes
//     cases which are supposed to fail with cases that must not fail hides the
//     regression in the average;
//   * the metric definitions ship inside the artifact, so the same name cannot
//     quietly mean two things in two reports.
//
// Everything here is pure: no clock, no IO, no map iteration without sorting.
// Byte-stable output is what makes "two scripted runs are equal" checkable.

import type { BareResult, EvalCase, HarnessResult } from "./types";

/** One row of the §4 metric table, published with the numbers it explains. */
export interface MetricDefinition {
  readonly key: string;
  readonly definition: string;
  readonly source: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: "barePassRate",
    definition: "cases the bare model passed / n cases",
    source: "computeMetrics",
  },
  {
    key: "harnessPassRate",
    definition: "cases the harness passed / n cases",
    source: "computeMetrics",
  },
  {
    key: "passRateDelta",
    definition: "harness minus bare pass rate, in percentage points",
    source: "computeMetrics",
  },
  {
    key: "constraintViolationRate",
    definition: "cases with at least one violation / n cases, per arm",
    source: "computeMetrics",
  },
  {
    key: "toolCallRate",
    definition: "harness cases that called at least one tool / n cases",
    source: "computeMetrics",
  },
  {
    key: "gateTurnRate",
    definition: "harness cases where a gate blocked at least once / n cases",
    source: "computeMetrics",
  },
  {
    key: "sourceMarkerRate",
    definition:
      "cases whose reply carries a source marker (soft and lexical: words like 'according to' / USDA / NIH), per arm. NOT a citation check — see citationSupport",
    source: "computeMetrics",
  },
  {
    key: "citationSupport",
    definition:
      "harness answers that kept at least one verified citation, over the cases that declare expected.shouldCite; the rate V1.1 retrieval is judged on (RFC 0013 §0)",
    source: "HarnessResult.citations",
  },
  {
    key: "citationFallbacks",
    definition:
      "cases where the tier-2 backstop fired: the answer claimed authority without naming a source, which is the one citation failure that regenerates",
    source: "HarnessResult.citations",
  },
  {
    key: "turnLatency",
    definition:
      "wall-clock turn duration in ms, from turn_start to turn_end in the trace; p50/p95 are nearest-rank",
    source: "turn_events (traces)",
  },
  {
    key: "modelCallLatency",
    definition: "provider round-trip per model_call in ms, kept apart from turn latency",
    source: "turn_events (traces)",
  },
  {
    key: "traceWriteLatency",
    definition:
      "turn_events.created_at minus the event's own timestamp, per append; the cost S1 adds to every yield",
    source: "turn_events (traces)",
  },
  {
    key: "cost",
    definition:
      "sum and per-turn mean of model_call.costUsd, including every regenerate attempt",
    source: "turn_events (traces)",
  },
  {
    key: "cacheHitRate",
    definition: "sum(cacheHitTokens) / sum(promptTokens); undefined when no prompt tokens",
    source: "turn_events (traces)",
  },
  {
    key: "stopReasonDistribution",
    definition: "count of turn_end.result.stopReason over the window",
    source: "turn_events (traces)",
  },
  {
    key: "gateDistribution",
    definition: "count of gate_verdict by checkpoint × verdict, and by checkName",
    source: "turn_events (traces)",
  },
  {
    key: "retrieval",
    definition:
      "not a separate metric: retrieval is judged by citationSupport above. Recall@5 / MRR are deliberately not computed — they need a labelled relevance set, and an unlabelled recall number is a self-set exam (RFC 0013 §6)",
    source: "not implemented in V1.0 or V1.1",
  },
];

/** The sample size below which §4 discipline 1 forbids percentage claims. */
export const MEANINGFUL_SAMPLE_SIZE = 30;

/** Nearest-rank percentile over an **ascending** array. */
export function percentile(
  sorted: readonly number[],
  q: number,
): number | undefined {
  if (sorted.length === 0) return undefined;
  if (!(q > 0 && q <= 1)) return undefined;
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/**
 * A distribution with its sample size attached.
 *
 * Nearest-rank rather than interpolated: with n below 30 — which is where this
 * dataset lives — an interpolated p95 is a number no sample produced, and the
 * one thing a percentile must not do is invent an observation.
 */
export interface Distribution {
  readonly n: number;
  readonly p50?: number;
  readonly p95?: number;
  readonly min?: number;
  readonly max?: number;
  readonly mean?: number;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0 };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** A count that says how much of its population it is, when that is knowable. */
export interface CountEntry {
  readonly key: string;
  readonly count: number;
  readonly share?: number;
}

/**
 * Counts by key, sorted by key.
 *
 * Sorted because a report is compared byte-wise across runs (§7): insertion
 * order would make two identical runs differ whenever the trace order differs.
 */
export function countBy(
  values: readonly string[],
  population?: number,
): readonly CountEntry[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const total = population ?? values.length;
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => ({
      key,
      count,
      share: total > 0 ? count / total : undefined,
    }));
}

/** Top-N by count, ties broken by key so the list is stable. */
export function topByCount(
  values: readonly string[],
  limit: number,
): readonly CountEntry[] {
  return [...countBy(values)]
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    .slice(0, limit);
}

// ─── eval results → summary (#92) ─────────────────────────────────────────

/**
 * Capability vs regression, derived from the case's own contract rather than
 * from a per-case label someone has to maintain.
 *
 * A case that declares a safety contract (`mustNotContain`, `shouldBeBlocked`)
 * is a regression case: the expected behaviour is an invariant that must hold
 * every run, and a drop there is a safety regression rather than a capability
 * gap. Everything else measures what the agent can do, which is allowed to move.
 */
export type EvalGroup = "capability" | "regression";

export function groupOf(evalCase: EvalCase): EvalGroup {
  const { mustNotContain, shouldBeBlocked } = evalCase.expected;
  const hasSafetyContract =
    (mustNotContain !== undefined && mustNotContain.length > 0) ||
    shouldBeBlocked !== undefined;
  return hasSafetyContract ? "regression" : "capability";
}

/** A rate that knows what it was computed from. */
export interface Rate {
  readonly n: number;
  readonly value?: number;
}

export function rate(part: number, whole: number): Rate {
  return { n: whole, value: whole > 0 ? part / whole : undefined };
}

export interface GroupMetrics {
  readonly group: EvalGroup;
  /** Cases the dataset declares in this group. */
  readonly n: number;
  /**
   * How many of them actually produced a result.
   *
   * Separate from `n` because the pass rate is computed over this population:
   * a run that crashed halfway would otherwise report a lower rate for a group
   * it simply measured less of, which is the same lie as a rate with no n.
   */
  readonly measured: number;
  readonly barePassed: number;
  readonly harnessPassed: number;
  readonly barePassRate?: number;
  readonly harnessPassRate?: number;
  /** Percentage points. Undefined when a rate has no data to be a delta of. */
  readonly deltaPoints?: number;
}

export interface ArmCounts {
  readonly passed: number;
  readonly failed: number;
  readonly passRate?: number;
}

/**
 * Provider faults that survived the retries (issue #129).
 *
 * Excluded from every rate's denominator and reported here by case id, because a
 * number that improves by silently dropping what it could not measure is not a
 * measurement. A non-empty list means this report's rates describe fewer cases
 * than the dataset has, and the report says so.
 */
export interface InfrastructureReport {
  readonly count: number;
  readonly cases: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Whether answers that *should* carry a citation actually carry one (RFC 0013 §0).
 *
 * Declared / measured / supported rather than a single rate, because the
 * denominator is a claim about the dataset: a rate over "cases that produced a
 * result" would let a run that crashed halfway look better, and a rate over every
 * case would be diluted by the questions that need no source at all.
 *
 * The two failure lists are kept apart because they call for different work: a
 * stripped citation means the answer cited something the registry could not
 * confirm, while a fallback means it claimed authority and cited nothing.
 */
export interface CitationSupport {
  /** Cases declaring `expected.shouldCite`. */
  readonly declared: number;
  /** How many of those produced a harness result with an observable citation outcome. */
  readonly measured: number;
  /** Of those, how many kept at least one verified citation. */
  readonly supported: number;
  readonly rate?: number;
  /** Cases where a citation was stripped for failing the provenance check (tier-1). */
  readonly stripped: readonly string[];
  /** Cases where the answer claimed authority without naming a source (tier-2). */
  readonly fallbacks: readonly string[];
}

export interface EvalResultSummary {
  readonly n: number;
  readonly bare: ArmCounts;
  readonly harness: ArmCounts;
  readonly deltaPoints?: number;
  readonly groups: readonly GroupMetrics[];
  readonly constraintViolationRate: { readonly bare: Rate; readonly harness: Rate };
  readonly toolCallRate: Rate;
  readonly sourceMarkerRate: { readonly bare: Rate; readonly harness: Rate };
  readonly gateTurnRate: Rate;
  /** See {@link CitationSupport} — the structural metric, unlike the marker above. */
  readonly citationSupport: CitationSupport;
  /**
   * §4 discipline 1: below this n the report states counts and the raw
   * difference, and does not turn either into a percentage claim.
   */
  readonly sampleSize: {
    readonly n: number;
    readonly meaningfulAt: number;
    readonly claimPercentages: boolean;
  };
  readonly definitions: readonly MetricDefinition[];
  readonly infrastructure: InfrastructureReport;
}

function infrastructureOf(
  bareResults: readonly BareResult[],
  harnessResults: readonly HarnessResult[],
): InfrastructureReport {
  const faults = [
    ...bareResults.map((result) => ({ caseId: result.caseId, fault: result.infrastructure })),
    ...harnessResults.map((result) => ({ caseId: result.caseId, fault: result.infrastructure })),
  ].filter((entry): entry is { caseId: string; fault: NonNullable<typeof entry.fault> } =>
    entry.fault !== undefined,
  );

  return {
    count: faults.length,
    cases: [...new Set(faults.map((entry) => entry.caseId))],
    reasons: [...new Set(faults.map((entry) => entry.fault.reason))],
  };
}

/**
 * The results a rate may be computed from.
 *
 * Infrastructure faults are dropped here and nowhere else, so every rate in this
 * module is over the same population and the report can state which population
 * that was.
 */
function measurable<T extends { readonly infrastructure?: unknown }>(
  results: readonly T[],
): readonly T[] {
  return results.filter((result) => result.infrastructure === undefined);
}

/**
 * The lexical source marker, kept byte-identical to `metrics.ts` because two
 * different literals for one metric name is the drift RFC 0009 §4 discipline 3
 * exists to prevent.
 *
 * It counts wording, not evidence: an answer that says "according to USDA" and
 * cites nothing scores here, and so does one that cites a real section without
 * those words. It is a style signal, and it is named that way. The structural
 * question — did this answer carry a verifiable citation — is answered by
 * `citationSupport` from the gate's own result.
 */
const SOURCE_MARKER = /\[source\]|source:|according to|USDA|NIH|ODS/i;

export function sourceMarkerCounts(
  bareResults: readonly BareResult[],
  harnessResults: readonly HarnessResult[],
): { readonly bare: number; readonly harness: number } {
  return {
    bare: bareResults.filter((r) => SOURCE_MARKER.test(r.response)).length,
    harness: harnessResults.filter((r) => SOURCE_MARKER.test(r.response)).length,
  };
}

function countsOf(results: readonly { readonly passed: boolean }[]): ArmCounts {
  const passed = results.filter((r) => r.passed).length;
  return {
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : undefined,
  };
}

/**
 * The rate half of the summary, shared with the console path so the six legacy
 * metrics have exactly one implementation (see `computeMetrics`).
 */
export interface RateMetrics {
  readonly n: number;
  readonly barePassRate?: number;
  readonly harnessPassRate?: number;
  readonly deltaPoints?: number;
  readonly constraintViolationRate: { readonly bare: Rate; readonly harness: Rate };
  readonly toolCallRate: Rate;
  readonly sourceMarkerRate: { readonly bare: Rate; readonly harness: Rate };
  readonly gateTurnRate: Rate;
}

export function rateMetrics(
  bareResultsInput: readonly BareResult[],
  harnessResultsInput: readonly HarnessResult[],
): RateMetrics {
  const bareResults = measurable(bareResultsInput);
  const harnessResults = measurable(harnessResultsInput);
  const n = bareResults.length;
  const barePassed = bareResults.filter((r) => r.passed).length;
  const harnessPassed = harnessResults.filter((r) => r.passed).length;
  const sources = sourceMarkerCounts(bareResults, harnessResults);

  const barePassRate = n > 0 ? barePassed / n : undefined;
  const harnessPassRate = harnessResults.length > 0 ? harnessPassed / harnessResults.length : undefined;

  return {
    n,
    barePassRate,
    harnessPassRate,
    deltaPoints:
      barePassRate !== undefined && harnessPassRate !== undefined
        ? (harnessPassRate - barePassRate) * 100
        : undefined,
    constraintViolationRate: {
      bare: rate(bareResults.filter((r) => r.violations.length > 0).length, n),
      harness: rate(
        harnessResults.filter((r) => r.violations.length > 0).length,
        harnessResults.length,
      ),
    },
    toolCallRate: rate(
      harnessResults.filter((r) => r.toolCalls.length > 0).length,
      harnessResults.length,
    ),
    sourceMarkerRate: {
      bare: rate(sources.bare, n),
      harness: rate(sources.harness, harnessResults.length),
    },
    gateTurnRate: rate(
      harnessResults.filter((r) => r.gateBlocks > 0).length,
      harnessResults.length,
    ),
  };
}

/**
 * Citation support over the cases that declare one is needed (RFC 0013 §0).
 *
 * A case counts as measured only when the harness produced a citation signal,
 * which the runner omits when no terminal result arrived: an answer that never
 * got far enough to cite is not evidence about citation behaviour, and folding it
 * into the denominator would turn a crash into a capability gap.
 *
 * The denominator is the declared cases rather than the measured ones, so a run
 * that measured less reports a lower rate instead of a flattering one — the same
 * reason `GroupMetrics` carries `n` and `measured` separately.
 */
export function citationSupportOf(
  cases: readonly EvalCase[],
  harnessResults: readonly HarnessResult[],
): CitationSupport {
  const declared = cases.filter((c) => c.expected.shouldCite === true);
  const byId = new Map(harnessResults.map((result) => [result.caseId, result]));

  const measured = declared.filter((c) => byId.get(c.id)?.citations !== undefined);
  const supported = measured.filter((c) => (byId.get(c.id)?.citations?.kept ?? 0) > 0);

  return {
    declared: declared.length,
    measured: measured.length,
    supported: supported.length,
    rate: declared.length > 0 ? supported.length / declared.length : undefined,
    stripped: measured
      .filter((c) => byId.get(c.id)?.citations?.stripped === true)
      .map((c) => c.id),
    fallbacks: measured
      .filter((c) => byId.get(c.id)?.citations?.claimedAuthorityWithoutCitation === true)
      .map((c) => c.id),
  };
}

export function summarizeEvalResults(
  cases: readonly EvalCase[],
  bareResultsInput: readonly BareResult[],
  harnessResultsInput: readonly HarnessResult[],
): EvalResultSummary {
  const infrastructure = infrastructureOf(bareResultsInput, harnessResultsInput);
  const bareResults = measurable(bareResultsInput);
  const harnessResults = measurable(harnessResultsInput);
  const rates = rateMetrics(bareResultsInput, harnessResultsInput);
  const harnessById = new Map(harnessResults.map((r) => [r.caseId, r]));
  const bareById = new Map(bareResults.map((r) => [r.caseId, r]));

  const groupNames: readonly EvalGroup[] = ["regression", "capability"];
  const groups: GroupMetrics[] = groupNames.map((group) => {
    const inGroup = cases.filter((c) => groupOf(c) === group);
    const bareMeasured = inGroup.filter((c) => bareById.has(c.id));
    const harnessMeasured = inGroup.filter((c) => harnessById.has(c.id));
    const barePassed = bareMeasured.filter((c) => bareById.get(c.id)?.passed === true).length;
    const harnessPassed = harnessMeasured.filter((c) => harnessById.get(c.id)?.passed === true).length;
    const barePassRate =
      bareMeasured.length > 0 ? barePassed / bareMeasured.length : undefined;
    const harnessPassRate =
      harnessMeasured.length > 0 ? harnessPassed / harnessMeasured.length : undefined;
    return {
      group,
      n: inGroup.length,
      measured: harnessMeasured.length,
      barePassed,
      harnessPassed,
      barePassRate,
      harnessPassRate,
      deltaPoints:
        barePassRate !== undefined && harnessPassRate !== undefined
          ? (harnessPassRate - barePassRate) * 100
          : undefined,
    };
  });

  const harnessCounts = countsOf(harnessResults);

  return {
    n: cases.length,
    bare: countsOf(bareResults),
    harness: harnessCounts,
    deltaPoints: rates.deltaPoints,
    groups,
    constraintViolationRate: rates.constraintViolationRate,
    toolCallRate: rates.toolCallRate,
    sourceMarkerRate: rates.sourceMarkerRate,
    gateTurnRate: rates.gateTurnRate,
    citationSupport: citationSupportOf(cases, harnessResults),
    sampleSize: {
      n: cases.length,
      meaningfulAt: MEANINGFUL_SAMPLE_SIZE,
      claimPercentages: cases.length >= MEANINGFUL_SAMPLE_SIZE,
    },
    definitions: METRIC_DEFINITIONS,
    infrastructure,
  };
}
