// Eval report artifacts (S2 / #94 / RFC 0009 §3, §5).
//
// One command produces four artifacts: `report.md` (the human read), `summary.json`
// (metrics + 口径 + environment), `cases.json` (per-case verdicts), and the
// rolling `reports/index.json` that makes reports comparable with each other.
//
// Two properties are load-bearing, and both are structural rather than
// editorial:
//
//   * **Reproducibility.** Two scripted runs must produce equal summaries with
//     only `at` and `reportId` differing. That only holds if nothing else
//     time- or order-dependent reaches the artifact — so the clock, the git
//     probe and the results all enter through injected dependencies, counts are
//     sorted before serialization, and wall-clock durations from the runners are
//     never aggregated (they differ run to run and measure the machine, not the
//     agent).
//   * **Privacy.** Reports do not carry prompts (§6): the assembled prompt is
//     never in the results, the case query is hand-written test data (allowed
//     into git by the same section), and model output is truncated to
//     `OUTPUT_LIMIT` characters unless `--no-output` drops it entirely. Raw
//     traces never enter this module at all — `traceMetrics` hands over counts
//     and percentiles only.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { CATALOG_SNAPSHOT_VERSION, createCatalog, SEED_FOODS } from "../catalog/catalog";
import { loadEvalCases } from "./dataset";
import { runBareEval } from "./bare-runner";
import { runHarnessEval } from "./harness-runner";
import { createStubAdapter, createStubTools } from "./stubAdapter";
import { DeepSeekAdapter } from "../harness/modelAdapter";
import type { ToolHandler } from "../harness/types";
import type { InteractionStore } from "../lib/drugInteractions";
import type { BareResult, ComparisonRow, EvalCase, HarnessResult } from "./types";
import {
  groupOf,
  METRIC_DEFINITIONS,
  summarizeEvalResults,
  type EvalResultSummary,
} from "./summary";
import {
  collectTraceMetrics,
  createSupabaseTraceAggregateSource,
  type TraceAggregateSource,
  type TraceMetrics,
} from "./traceMetrics";
import {
  buildComparableSummary,
  compareSummaries,
  renderCompareMarkdown,
  DEFAULT_COMPARE_THRESHOLDS,
  type ComparableSummary,
  type CompareResult,
  type CompareThresholds,
} from "./compare";

export const REPORT_SCHEMA_VERSION = "1.0.0";

/** §6: the length a model output is cut to before it is written to disk. */
export const OUTPUT_LIMIT = 240;

/** Default window for trace telemetry: the same day-ish span a run describes. */
const DEFAULT_TRACE_WINDOW_HOURS = 24;
const DEFAULT_TRACE_LIMIT = 500;

export type ReportMode = "scripted" | "live";

export interface ReportEnv {
  readonly reportId: string;
  readonly at: string;
  readonly mode: ReportMode;
  readonly tag: string;
  readonly gitSha: string;
  readonly dirty: boolean;
  readonly appVersion: string;
  readonly catalogVersion: string;
  readonly datasetHash: string;
}

/**
 * Why the trace half of the summary is there or not.
 *
 * Recorded rather than implied: a report whose telemetry silently vanished looks
 * identical to a report of a window with no turns, and the difference matters
 * when someone reads a cost row that says zero.
 */
export interface TelemetryNote {
  readonly included: boolean;
  readonly source?: string;
  readonly window?: { readonly since: string; readonly until: string };
  readonly reason?: string;
}

export interface ReportSummary {
  readonly schema: string;
  readonly env: ReportEnv;
  readonly n: number;
  readonly eval: EvalResultSummary;
  readonly traces: TraceMetrics | null;
  readonly telemetry: TelemetryNote;
}

/**
 * The parts `index.json` keeps per report: everything `--compare` reads, and
 * nothing that would make the index as large as the reports it indexes.
 */
export interface ComparableEntry {
  readonly reportId: string;
  readonly at: string;
  readonly mode: ReportMode;
  readonly tag: string;
  readonly gitSha: string;
  readonly dirty: boolean;
  readonly appVersion: string;
  readonly catalogVersion: string;
  readonly datasetHash: string;
  readonly n: number;
  readonly summary: ComparableSummary;
}

// ─── identity ──────────────────────────────────────────────────────────────

/**
 * `datasetHash`: the case set's canonical hash, sorted by id and serialized with
 * sorted keys, so it changes when the data changes and not when someone
 * reorders the file (§5). Two reports with different hashes are not comparable,
 * and `--compare` says so instead of printing a delta.
 */
export function datasetHash(cases: readonly EvalCase[]): string {
  const canonical = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({
      id: c.id,
      query: c.query,
      category: c.category,
      expected: c.expected,
      userContext: c.userContext ?? null,
    }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

/** `<UTC timestamp>-<tag>`; the tag defaults to the git short sha (§3). */
export function reportIdFor(at: Date, tag: string): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `${stamp}-${tag}`;
}

export function truncateOutput(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[+${text.length - limit} chars]`;
}

// ─── assembly ──────────────────────────────────────────────────────────────

export interface BuildSummaryInput {
  readonly cases: readonly EvalCase[];
  readonly bareResults: readonly BareResult[];
  readonly harnessResults: readonly HarnessResult[];
  readonly env: Omit<ReportEnv, "datasetHash">;
  readonly traces: TraceMetrics | null;
  readonly telemetry: TelemetryNote;
}

export function buildSummary(input: BuildSummaryInput): ReportSummary {
  return {
    schema: REPORT_SCHEMA_VERSION,
    env: { ...input.env, datasetHash: datasetHash(input.cases) },
    n: input.cases.length,
    eval: summarizeEvalResults(input.cases, input.bareResults, input.harnessResults),
    traces: input.traces,
    telemetry: input.telemetry,
  };
}

export function comparisonRows(
  cases: readonly EvalCase[],
  bareResults: readonly BareResult[],
  harnessResults: readonly HarnessResult[],
): readonly (ComparisonRow & { readonly group: string })[] {
  const bareById = new Map(bareResults.map((r) => [r.caseId, r]));
  const harnessById = new Map(harnessResults.map((r) => [r.caseId, r]));

  return cases.map((c) => {
    const barePassed = bareById.get(c.id)?.passed ?? false;
    const harnessPassed = harnessById.get(c.id)?.passed ?? false;
    const delta =
      barePassed === harnessPassed
        ? `same (both ${barePassed ? "passed" : "failed"})`
        : harnessPassed
          ? "+harness (harness passed, bare failed)"
          : "−harness (bare passed, harness failed)";
    return {
      caseId: c.id,
      query: c.query,
      category: c.category,
      barePassed,
      harnessPassed,
      delta,
      group: groupOf(c),
    };
  });
}

// ─── rendering ─────────────────────────────────────────────────────────────

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function points(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}pt`;
}

function ms(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

function usd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

/**
 * The human-readable half. It opens with the sample size and what that number
 * permits: §4 discipline 1 says a 29-case dataset cannot support a "提升 x%"
 * claim, and the report is where that constraint has to be visible rather than
 * remembered.
 */
export function renderReportMarkdown(
  summary: ReportSummary,
  rows: readonly (ComparisonRow & { readonly group: string })[],
  compare?: { readonly result: CompareResult; readonly beforeId: string },
): string {
  const { env, eval: metrics } = summary;
  const lines: string[] = [];

  lines.push(`# Eval report \`${env.reportId}\``, "");
  lines.push(`- mode: **${env.mode}**${env.mode === "scripted" ? " (stub adapter, offline, deterministic)" : " (real model)"}`);
  lines.push(`- at: ${env.at}`);
  lines.push(`- tag: \`${env.tag}\``);
  lines.push(`- git: \`${env.gitSha}\`${env.dirty ? " (dirty working tree)" : ""}`);
  lines.push(`- app version: ${env.appVersion} · catalog: ${env.catalogVersion}`);
  lines.push(`- dataset: n=${summary.n} · \`${env.datasetHash}\``);
  lines.push(`- telemetry: ${summary.telemetry.included ? `traces from ${summary.telemetry.source ?? "unknown"}` : `not included (${summary.telemetry.reason ?? "unknown"})`}`);
  lines.push("");

  lines.push("## 口径与样本量", "");
  if (metrics.sampleSize.claimPercentages) {
    lines.push(`n=${metrics.sampleSize.n} — 达到 ${metrics.sampleSize.meaningfulAt}，可以给出百分点差异。`);
  } else {
    lines.push(
      `n=${metrics.sampleSize.n} **小于 ${metrics.sampleSize.meaningfulAt}**：本报告只报计数与原始差，不写「提升 x%」这类百分点结论。`,
    );
  }
  lines.push("");

  lines.push("## 指标", "");
  lines.push("| 指标 | bare | harness | Δ |", "| --- | --- | --- | --- |");
  lines.push(
    `| 通过率 | ${metrics.bare.passed}/${metrics.bare.failed + metrics.bare.passed} (${pct(metrics.bare.passRate)}) | ${metrics.harness.passed}/${metrics.harness.failed + metrics.harness.passed} (${pct(metrics.harness.passRate)}) | ${points(metrics.deltaPoints)} |`,
  );
  lines.push(
    `| 约束违反率 | ${pct(metrics.constraintViolationRate.bare.value)} | ${pct(metrics.constraintViolationRate.harness.value)} | |`,
  );
  lines.push(`| 工具调用率 | — | ${pct(metrics.toolCallRate.value)} | |`);
  lines.push(`| 闸拦截率 | — | ${pct(metrics.gateTurnRate.value)} | |`);
  lines.push(
    `| 来源合规率（软，词面） | ${pct(metrics.sourceComplianceRate.bare.value)} | ${pct(metrics.sourceComplianceRate.harness.value)} | |`,
  );
  lines.push("");

  lines.push("## 分组（capability / regression）", "");
  lines.push("regression = 声明了安全契约（`mustNotContain` / `shouldBeBlocked`）的 case；capability = 其余。", "");
  lines.push("| 组 | n | bare 通过 | harness 通过 | Δ |", "| --- | --- | --- | --- | --- |");
  for (const group of metrics.groups) {
    lines.push(
      `| ${group.group} | ${group.n} | ${group.barePassed}/${group.n} | ${group.harnessPassed}/${group.n} | ${points(group.deltaPoints)} |`,
    );
  }
  lines.push("");

  if (summary.traces) {
    const t = summary.traces;
    lines.push("## 轨迹遥测（与模型延迟分开统计）", "");
    lines.push(`- 窗口: ${t.window.since} → ${t.window.until} · turns: ${t.turns}`);
    lines.push(
      `- turn 墙钟: P50 ${ms(t.turnLatency.p50)} · P95 ${ms(t.turnLatency.p95)} (n=${t.turnLatency.n})`,
    );
    lines.push(
      `- model_call 往返: P50 ${ms(t.modelCallLatency.p50)} · P95 ${ms(t.modelCallLatency.p95)} (n=${t.modelCallLatency.n})`,
    );
    lines.push(
      `- 轨迹写入: P50 ${ms(t.traceWriteLatency.p50)} · P95 ${ms(t.traceWriteLatency.p95)} (n=${t.traceWriteLatency.n})`,
    );
    lines.push(
      `- 成本: 合计 ${usd(t.cost.totalUsd)} · 每轮均值 ${usd(t.cost.perTurn.mean)} · token in ${t.cost.tokenIn} / out ${t.cost.tokenOut} · 缓存命中 ${pct(t.cost.cacheHitRate)}`,
    );
    lines.push(
      `- 终态: ${t.stopReasons.map((entry) => `${entry.key}=${entry.count}`).join(" · ") || "n/a"}`,
    );
    lines.push(
      `- 闸: ${t.gates.checkpointVerdict.map((entry) => `${entry.key}=${entry.count}`).join(" · ") || "n/a"}`,
    );
    lines.push(
      `- 闸 checkName top: ${t.gates.topCheckNames.map((entry) => `${entry.key}=${entry.count}`).join(" · ") || "n/a"}`,
    );
    lines.push("");
  }

  if (compare) {
    lines.push(renderCompareMarkdown(compare.result, compare.beforeId, env.reportId));
    lines.push("");
  }

  lines.push("## 逐 case", "");
  lines.push("| id | category | group | bare | harness | delta |", "| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(
      `| ${row.caseId} | ${row.category} | ${row.group} | ${row.barePassed ? "pass" : "FAIL"} | ${row.harnessPassed ? "pass" : "FAIL"} | ${row.delta} |`,
    );
  }
  lines.push("");

  lines.push("## 复现", "");
  lines.push("```bash");
  lines.push(`npm run eval:report${env.mode === "live" ? " -- --live" : ""} -- --tag ${env.tag}`);
  lines.push("```");
  lines.push(
    `同一 datasetHash（\`${env.datasetHash}\`）与同一 mode 的两次运行，summary 除 \`at\`/\`reportId\` 外逐字节相等；换数据集必须显式声明不可比。`,
  );
  lines.push("");

  return lines.join("\n");
}

export interface CasesArtifactOptions {
  /** false drops model output entirely (`--no-output`). */
  readonly includeOutput: boolean;
  readonly outputLimit?: number;
}

/**
 * `cases.json`: the per-case record. It carries the case id, the hand-written
 * query (test data, allowed into git by §6), the verdicts and a truncated model
 * output — never the assembled prompt, which this module never sees.
 */
export function buildCasesJson(
  cases: readonly EvalCase[],
  bareResults: readonly BareResult[],
  harnessResults: readonly HarnessResult[],
  options: CasesArtifactOptions,
): string {
  const limit = options.outputLimit ?? OUTPUT_LIMIT;
  const bareById = new Map(bareResults.map((r) => [r.caseId, r]));
  const harnessById = new Map(harnessResults.map((r) => [r.caseId, r]));

  const payload = cases.map((c) => {
    const bare = bareById.get(c.id);
    const harness = harnessById.get(c.id);
    return {
      caseId: c.id,
      query: c.query,
      category: c.category,
      group: groupOf(c),
      bare: bare
        ? {
            passed: bare.passed,
            violations: bare.violations,
            output: options.includeOutput ? truncateOutput(bare.response, limit) : null,
          }
        : null,
      harness: harness
        ? {
            passed: harness.passed,
            violations: harness.violations,
            toolCalls: harness.toolCalls,
            gateBlocks: harness.gateBlocks,
            steps: harness.steps,
            stopReason: harness.stopReason,
            output: options.includeOutput
              ? truncateOutput(harness.response, limit)
              : null,
          }
        : null,
    };
  });

  return `${JSON.stringify({ cases: payload }, null, 2)}\n`;
}

// ─── index.json ────────────────────────────────────────────────────────────

export function indexEntryFor(summary: ReportSummary): ComparableEntry {
  return {
    reportId: summary.env.reportId,
    at: summary.env.at,
    mode: summary.env.mode,
    tag: summary.env.tag,
    gitSha: summary.env.gitSha,
    dirty: summary.env.dirty,
    appVersion: summary.env.appVersion,
    catalogVersion: summary.env.catalogVersion,
    datasetHash: summary.env.datasetHash,
    n: summary.n,
    summary: buildComparableSummary(summary.eval, summary.traces),
  };
}

/**
 * Newest first, and replacing an entry with the same `reportId` rather than
 * appending a second one: re-running a tag means "this is what that report
 * says", not "here are two reports with one name".
 */
export function mergeIndex(
  existing: readonly ComparableEntry[],
  entry: ComparableEntry,
): readonly ComparableEntry[] {
  const others = existing.filter((candidate) => candidate.reportId !== entry.reportId);
  return [entry, ...others];
}

export function parseIndex(text: string): readonly ComparableEntry[] {
  const parsed = JSON.parse(text) as { reports?: unknown };
  return Array.isArray(parsed.reports) ? (parsed.reports as ComparableEntry[]) : [];
}

export function serializeIndex(entries: readonly ComparableEntry[]): string {
  return `${JSON.stringify({ reports: entries }, null, 2)}\n`;
}

export function findIndexEntry(
  entries: readonly ComparableEntry[],
  reportId: string,
): ComparableEntry | undefined {
  return entries.find((entry) => entry.reportId === reportId);
}

// ─── the command ───────────────────────────────────────────────────────────

export interface ReportRunResult {
  readonly cases: readonly EvalCase[];
  readonly bareResults: readonly BareResult[];
  readonly harnessResults: readonly HarnessResult[];
}

export interface ReportDeps {
  readonly now?: () => Date;
  readonly git?: () => { readonly sha: string; readonly dirty: boolean };
  readonly appVersion?: () => string;
  readonly catalogVersion?: () => string;
  readonly loadCases?: () => readonly EvalCase[];
  /** Runs the evaluation; injected so tests do not need an adapter. */
  readonly runEval?: (mode: ReportMode) => Promise<ReportRunResult>;
  /** Trace telemetry, or null when it is unavailable/not requested. */
  readonly loadTraces?: (mode: ReportMode, until: Date) => Promise<{
    readonly metrics: TraceMetrics;
    readonly source: string;
    readonly window: { readonly since: string; readonly until: string };
  } | null>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly writeFile?: (path: string, content: string) => void;
  readonly readFile?: (path: string) => string | undefined;
  readonly mkdir?: (dir: string) => void;
  readonly outDir?: string;
  readonly compareThresholds?: CompareThresholds;
}

interface ParsedArgs {
  readonly live: boolean;
  readonly tag?: string;
  readonly compareTo?: string;
  readonly traces: boolean;
  readonly includeOutput: boolean;
  readonly outDir?: string;
}

class UsageError extends Error {}

export function parseReportArgs(argv: readonly string[]): ParsedArgs {
  let live = false;
  let tag: string | undefined;
  let compareTo: string | undefined;
  let traces = false;
  let includeOutput = true;
  let outDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${flag} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (flag) {
      case "--live":
        live = true;
        break;
      case "--tag":
        tag = value();
        break;
      case "--compare":
        compareTo = value();
        break;
      case "--traces":
        traces = true;
        break;
      case "--no-output":
        includeOutput = false;
        break;
      case "--out":
        outDir = value();
        break;
      case "--help":
      case "-h":
        throw new UsageError("requested help");
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }

  return { live, tag, compareTo, traces, includeOutput, outDir };
}

const USAGE = `usage:
  eval:report [--live] [--tag <name>] [--traces] [--compare <reportId>] [--no-output] [--out <dir>]

  --live           real model (needs DEEPSEEK_API_KEY); default is the scripted stub
  --tag            report tag; defaults to the git short sha
  --traces         include trace telemetry (delays/cost) from Supabase
  --compare        mark regressions against a reportId in reports/index.json
  --no-output      omit model output from cases.json (it is truncated to ${OUTPUT_LIMIT} chars otherwise)
  --out            output directory (default: reports)`;

/** Git probe: the report records the revision it describes, not a guess. */
function readGit(): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync("package.json", "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "0.0.0-unversioned";
  } catch {
    return "0.0.0-unversioned";
  }
}

/** The default trace telemetry loader: Supabase, service role, one window. */
async function loadSupabaseTraces(
  until: Date,
  source: TraceAggregateSource,
  label: string,
): Promise<{ metrics: TraceMetrics; source: string; window: { since: string; until: string } }> {
  const untilIso = until.toISOString();
  const sinceIso = new Date(
    until.getTime() - DEFAULT_TRACE_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const query = { since: sinceIso, until: untilIso, limit: DEFAULT_TRACE_LIMIT };
  const metrics = await collectTraceMetrics(source, query, METRIC_DEFINITIONS);
  return { metrics, source: label, window: { since: sinceIso, until: untilIso } };
}

export async function main(
  argv: readonly string[],
  deps: ReportDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));

  let args: ParsedArgs;
  try {
    args = parseReportArgs(argv);
  } catch (err) {
    const message = (err as Error).message;
    stderr(`eval:report: ${message}\n${USAGE}\n`);
    return message === "requested help" ? 0 : 1;
  }

  const now = deps.now ?? (() => new Date());
  const at = now();
  const git = (deps.git ?? readGit)();
  const tag = args.tag ?? git.sha;
  const reportId = reportIdFor(at, tag);
  const mode: ReportMode = args.live ? "live" : "scripted";
  const cases = (deps.loadCases ?? loadEvalCases)();

  const runEval =
    deps.runEval ??
    (async (runMode: ReportMode): Promise<ReportRunResult> => {
      const adapter = runMode === "live" ? new DeepSeekAdapter() : createStubAdapter(cases);
      const tools =
        runMode === "live" ? new Map<string, ToolHandler>() : createStubTools();
      const interactionStore: InteractionStore = { all: async () => [] };
      const bare = await runBareEval(cases, adapter);
      const harness = await runHarnessEval(
        cases,
        adapter,
        tools,
        interactionStore,
        createCatalog(SEED_FOODS),
      );
      return { cases, bareResults: bare, harnessResults: harness };
    });

  let results: ReportRunResult;
  try {
    results = await runEval(mode);
  } catch (err) {
    stderr(`eval:report: evaluation failed: ${(err as Error).message}\n`);
    return 1;
  }

  // Telemetry is opt-in: it needs a database, and a scripted run that silently
  // read whatever happened to be in one would not be reproducible (§7).
  let telemetry: TelemetryNote = {
    included: false,
    reason: "--traces not requested",
  };
  let traces: TraceMetrics | null = null;

  if (args.traces) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // An injected loader replaces the Supabase one entirely, so the env check is
    // only meaningful when the default loader is the one that would run.
    const loader =
      deps.loadTraces ??
      (url && key
        ? (_runMode: ReportMode, until: Date) =>
            loadSupabaseTraces(
              until,
              createSupabaseTraceAggregateSource(
                createClient(url, key, {
                  auth: { persistSession: false, autoRefreshToken: false },
                }),
              ),
              url,
            )
        : undefined);

    if (!loader) {
      telemetry = {
        included: false,
        reason: "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
      };
      stderr(
        "eval:report: --traces requested but Supabase env is missing; continuing without telemetry\n",
      );
    } else {
      try {
        const loaded = await loader(mode, at);
        if (loaded) {
          traces = loaded.metrics;
          telemetry = {
            included: true,
            source: loaded.source,
            window: loaded.window,
          };
        } else {
          telemetry = { included: false, reason: "trace source returned nothing" };
        }
      } catch (err) {
        telemetry = { included: false, reason: (err as Error).message };
        stderr(`eval:report: trace telemetry failed: ${(err as Error).message}\n`);
      }
    }
  }

  const summary = buildSummary({
    cases: results.cases,
    bareResults: results.bareResults,
    harnessResults: results.harnessResults,
    env: {
      reportId,
      at: at.toISOString(),
      mode,
      tag,
      gitSha: git.sha,
      dirty: git.dirty,
      appVersion: (deps.appVersion ?? readPackageVersion)(),
      catalogVersion: (deps.catalogVersion ?? (() => CATALOG_SNAPSHOT_VERSION))(),
    },
    traces,
    telemetry,
  });

  const rows = comparisonRows(results.cases, results.bareResults, results.harnessResults);

  const outDir = args.outDir ?? deps.outDir ?? "reports";
  const readFile = deps.readFile ?? ((path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  });
  const writeFile = deps.writeFile ?? ((path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  });
  const mkdir = deps.mkdir ?? ((dir: string) => {
    mkdirSync(dir, { recursive: true });
  });

  const indexPath = join(outDir, "index.json");
  const existingIndex = (() => {
    const text = readFile(indexPath);
    if (text === undefined) return [] as readonly ComparableEntry[];
    try {
      return parseIndex(text);
    } catch (err) {
      stderr(`eval:report: reports/index.json is not readable JSON (${(err as Error).message}); starting a new index\n`);
      return [] as readonly ComparableEntry[];
    }
  })();

  let compare: { result: CompareResult; beforeId: string } | undefined;
  if (args.compareTo) {
    const before = findIndexEntry(existingIndex, args.compareTo);
    if (!before) {
      stderr(
        `eval:report: no report "${args.compareTo}" in ${indexPath}; nothing to compare against\n`,
      );
      return 1;
    }
    compare = {
      result: compareSummaries(
        before.summary,
        buildComparableSummary(summary.eval, summary.traces),
        deps.compareThresholds ?? DEFAULT_COMPARE_THRESHOLDS,
      ),
      beforeId: args.compareTo,
    };
  }

  const reportDir = join(outDir, reportId);
  mkdir(reportDir);
  writeFile(join(reportDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFile(
    join(reportDir, "cases.json"),
    buildCasesJson(results.cases, results.bareResults, results.harnessResults, {
      includeOutput: args.includeOutput,
    }),
  );
  writeFile(join(reportDir, "report.md"), renderReportMarkdown(summary, rows, compare));

  const entry = indexEntryFor(summary);
  writeFile(indexPath, serializeIndex(mergeIndex(existingIndex, entry)));

  stdout(
    [
      `report: ${reportId} (${mode})`,
      `  ${join(reportDir, "report.md")}`,
      `  ${join(reportDir, "summary.json")}`,
      `  ${join(reportDir, "cases.json")}`,
      `  ${indexPath}`,
      compare
        ? `  compare vs ${compare.beforeId}: ${compare.result.regressions.length} regression(s), comparable=${compare.result.comparable}`
        : "",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith("report.ts") ?? false;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `eval:report: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
