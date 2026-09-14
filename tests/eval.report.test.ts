// Report artifacts and the command that writes them (#94, #96 / RFC 0009 §3, §5, §6, §7).
//
// The two properties these tests exist for:
//   * reproducibility — two scripted runs differ in `at`/`reportId` and in
//     nothing else, which is only true if the clock, the git probe and the
//     results all arrive through the injected dependencies;
//   * privacy — no artifact carries the assembled prompt, and model output is
//     truncated to OUT (`--no-output` drops it).

import { describe, expect, it } from "vitest";
import {
  buildCasesJson,
  buildSummary,
  datasetHash,
  findIndexEntry,
  indexEntryFor,
  main,
  mergeIndex,
  OUTPUT_LIMIT,
  parseIndex,
  parseReportArgs,
  renderReportMarkdown,
  reportIdFor,
  serializeIndex,
  truncateOutput,
  type ReportDeps,
  type ReportRunResult,
} from "../src/eval/report";
import { compareSummaries } from "../src/eval/compare";
import type { BareResult, EvalCase, HarnessResult } from "../src/eval/types";

const CASES: readonly EvalCase[] = [
  { id: "s1", query: "How much protein is in 100g of chicken breast?", category: "simple", expected: { mustCallTools: ["search_food"] } },
  { id: "c1", query: "What's a good high-protein snack for me?", category: "constrained", expected: { mustNotContain: ["peanut"] }, userContext: { allergies: ["peanut"], medications: [] } },
];

function bare(caseId: string, passed: boolean, response = "ok"): BareResult {
  return { caseId, response, passed, violations: passed ? [] : ["violation"], durationMs: 12 };
}

function harness(caseId: string, passed: boolean, response = "ok"): HarnessResult {
  return {
    caseId,
    response,
    steps: 3,
    stopReason: "end_turn",
    passed,
    violations: passed ? [] : ["violation"],
    toolCalls: ["search_food"],
    gateBlocks: 0,
    durationMs: 99,
  };
}

function fixedResults(): ReportRunResult {
  return {
    cases: CASES,
    bareResults: [bare("s1", true), bare("c1", false)],
    harnessResults: [harness("s1", true), harness("c1", true)],
  };
}

/** In-memory filesystem so the command can be driven without touching disk. */
function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: (path: string, content: string) => {
      files.set(path, content);
    },
    readFile: (path: string) => files.get(path),
    mkdir: () => {},
  };
}

export function reportDeps(
  fs: ReturnType<typeof memoryFs>,
  overrides: Partial<ReportDeps> = {},
): ReportDeps {
  return {
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    git: () => ({ sha: "abc1234", dirty: false }),
    appVersion: () => "1.0.0",
    catalogVersion: () => "usda-sr-legacy-2026-07-v1",
    loadCases: () => CASES,
    runEval: async () => fixedResults(),
    stdout: () => {},
    stderr: () => {},
    writeFile: fs.writeFile,
    readFile: fs.readFile,
    mkdir: fs.mkdir,
    outDir: "reports",
    ...overrides,
  };
}

describe("identity", () => {
  it("hashes the dataset stably, whatever order the cases arrive in", () => {
    const forward = datasetHash(CASES);
    const reversed = datasetHash([...CASES].reverse());
    expect(forward).toBe(reversed);
    expect(forward).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes the hash when the data changes", () => {
    const changed = CASES.map((c) =>
      c.id === "s1" ? { ...c, query: `${c.query} (edited)` } : c,
    );
    expect(datasetHash(changed)).not.toBe(datasetHash(CASES));
  });

  it("builds a reportId from the UTC timestamp and the tag", () => {
    expect(reportIdFor(new Date("2026-09-13T12:00:00.000Z"), "abc1234")).toBe(
      "2026-09-13T12-00-00Z-abc1234",
    );
  });
});

describe("truncateOutput", () => {
  it("leaves a short output alone", () => {
    expect(truncateOutput("short", OUTPUT_LIMIT)).toBe("short");
  });

  it("cuts to the limit and says how much was dropped", () => {
    const long = "x".repeat(OUTPUT_LIMIT + 25);
    const cut = truncateOutput(long);
    expect(cut.startsWith("x".repeat(OUTPUT_LIMIT))).toBe(true);
    expect(cut).toContain("[+25 chars]");
  });
});

describe("buildCasesJson", () => {
  it("carries verdicts and a truncated output, and no prompt", () => {
    const artifact = buildCasesJson(CASES, [bare("s1", true)], [harness("s1", true, "y".repeat(500))], {
      includeOutput: true,
    });
    const parsed = JSON.parse(artifact) as {
      cases: { caseId: string; query: string; group: string; harness: { output: string } }[];
    };

    expect(parsed.cases[0].caseId).toBe("s1");
    expect(parsed.cases[0].query).toBe(CASES[0].query);
    expect(parsed.cases[0].group).toBe("capability");
    expect(parsed.cases[0].harness.output.length).toBeLessThan(300);
    expect(parsed.cases[0].harness.output).toContain("[+260 chars]");
    expect(parsed.cases[1].group).toBe("regression");
  });

  it("drops model output entirely under --no-output", () => {
    const artifact = buildCasesJson(CASES, [], [harness("s1", true, "secret model prose")], {
      includeOutput: false,
    });
    expect(artifact).not.toContain("secret model prose");
    const parsed = JSON.parse(artifact) as { cases: { harness: { output: null } }[] };
    expect(parsed.cases[0].harness.output).toBeNull();
  });
});

describe("index", () => {
  it("records the fields §5 lists", () => {
    const summary = buildSummary({
      cases: CASES,
      bareResults: [bare("s1", true)],
      harnessResults: [harness("s1", true)],
      env: {
        reportId: "2026-09-13T12-00-00Z-abc1234",
        at: "2026-09-13T12:00:00.000Z",
        mode: "scripted",
        tag: "abc1234",
        gitSha: "abc1234",
        dirty: false,
        appVersion: "1.0.0",
        catalogVersion: "usda-sr-legacy-2026-07-v1",
      },
      traces: null,
      telemetry: { included: false, reason: "--traces not requested" },
    });

    const entry = indexEntryFor(summary);
    expect(entry).toMatchObject({
      reportId: "2026-09-13T12-00-00Z-abc1234",
      mode: "scripted",
      gitSha: "abc1234",
      dirty: false,
      appVersion: "1.0.0",
      catalogVersion: "usda-sr-legacy-2026-07-v1",
      n: 2,
    });
    expect(entry.datasetHash).toBe(datasetHash(CASES));
    // Rates are computed over the results that exist, so one passing result is
    // 1.0 — the dataset's size lives in `n`, not in the denominator.
    expect(entry.summary.harnessPassRate).toBe(1);
  });

  it("replaces an entry with the same reportId instead of appending a twin", () => {
    const first = { reportId: "r1" } as never;
    const second = { reportId: "r2" } as never;
    const replaced = { reportId: "r1", tag: "again" } as never;

    expect(mergeIndex([first, second], replaced).map((entry) => entry)).toEqual([
      replaced,
      second,
    ]);
    expect(findIndexEntry(mergeIndex([first], replaced), "r1")).toBe(replaced);
  });

  it("round-trips through the index file format", () => {
    const entries = [{ reportId: "r1", n: 29 }] as never as ReturnType<typeof parseIndex>;
    expect(parseIndex(serializeIndex(entries))).toEqual(entries);
    expect(parseIndex("{}")).toEqual([]);
  });
});

describe("renderReportMarkdown", () => {
  it("states the sample size and what it forbids", () => {
    const summary = buildSummary({
      cases: CASES,
      bareResults: [bare("s1", true), bare("c1", false)],
      harnessResults: [harness("s1", true), harness("c1", true)],
      env: {
        reportId: "r",
        at: "2026-09-13T12:00:00.000Z",
        mode: "scripted",
        tag: "t",
        gitSha: "abc1234",
        dirty: false,
        appVersion: "1.0.0",
        catalogVersion: "c",
      },
      traces: null,
      telemetry: { included: false, reason: "--traces not requested" },
    });

    const rendered = renderReportMarkdown(summary, [], undefined);
    expect(rendered).toContain("**小于 30**");
    expect(rendered).toContain("不写「提升 x%」");
    expect(rendered).toContain("not included (--traces not requested)");
    expect(rendered).toContain("## 复现");
  });

  it("tells the reader when trace telemetry was missing rather than showing zero cost", () => {
    const summary = buildSummary({
      cases: CASES,
      bareResults: [],
      harnessResults: [],
      env: {
        reportId: "r",
        at: "2026-09-13T12:00:00.000Z",
        mode: "scripted",
        tag: "t",
        gitSha: "abc",
        dirty: false,
        appVersion: "1.0.0",
        catalogVersion: "c",
      },
      traces: null,
      telemetry: { included: false, reason: "NEXT_PUBLIC_SUPABASE_URL not set" },
    });
    const rendered = renderReportMarkdown(summary, [], undefined);
    expect(rendered).toContain("NEXT_PUBLIC_SUPABASE_URL not set");
    expect(rendered).not.toContain("## 轨迹遥测");
  });
});

describe("parseReportArgs", () => {
  it("takes the documented flags", () => {
    expect(parseReportArgs(["--live", "--tag", "v2", "--traces", "--compare", "r1", "--no-output", "--out", "x"])).toEqual({
      live: true,
      tag: "v2",
      compareTo: "r1",
      traces: true,
      includeOutput: false,
      outDir: "x",
    });
  });

  it("defaults to the scripted mode with output included", () => {
    expect(parseReportArgs([])).toEqual({
      live: false,
      tag: undefined,
      compareTo: undefined,
      traces: false,
      includeOutput: true,
      outDir: undefined,
    });
  });

  it("rejects an unknown flag and a flag without a value", () => {
    expect(() => parseReportArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseReportArgs(["--tag"])).toThrow(/needs a value/);
  });
});

describe("main", () => {
  it("writes the four artifacts §3 names", async () => {
    const fs = memoryFs();
    const code = await main(["--tag", "t1"], reportDeps(fs));

    expect(code).toBe(0);
    const paths = [...fs.files.keys()].sort();
    expect(paths).toEqual([
      "reports/2026-09-13T12-00-00Z-t1/cases.json",
      "reports/2026-09-13T12-00-00Z-t1/report.md",
      "reports/2026-09-13T12-00-00Z-t1/summary.json",
      "reports/index.json",
    ]);

    const index = parseIndex(fs.files.get("reports/index.json") ?? "");
    expect(index).toHaveLength(1);
    expect(index[0].datasetHash).toBe(datasetHash(CASES));
  });

  it("is reproducible: two runs differ only in at and reportId", async () => {
    const first = memoryFs();
    const second = memoryFs();
    await main(["--tag", "t1"], reportDeps(first, { now: () => new Date("2026-09-13T12:00:00.000Z") }));
    await main(["--tag", "t1"], reportDeps(second, { now: () => new Date("2026-09-13T18:30:00.000Z") }));

    const a = JSON.parse(first.files.get("reports/2026-09-13T12-00-00Z-t1/summary.json") ?? "{}") as {
      env: Record<string, unknown>;
    };
    const b = JSON.parse(second.files.get("reports/2026-09-13T18-30-00Z-t1/summary.json") ?? "{}") as {
      env: Record<string, unknown>;
    };

    for (const summary of [a, b]) {
      delete summary.env.at;
      delete summary.env.reportId;
    }
    expect(a).toEqual(b);

    expect(first.files.get("reports/2026-09-13T12-00-00Z-t1/cases.json")).toBe(
      second.files.get("reports/2026-09-13T18-30-00Z-t1/cases.json"),
    );
  });

  it("marks regressions against an earlier report in the index", async () => {
    const fs = memoryFs();
    // A first run whose summary is recorded, then a second run that is worse.
    await main([], reportDeps(fs, { now: () => new Date("2026-09-13T12:00:00.000Z"), loadCases: () => CASES }));
    const firstId = parseIndex(fs.files.get("reports/index.json") ?? "")[0].reportId;

    const worse: ReportRunResult = {
      cases: CASES,
      bareResults: [bare("s1", false), bare("c1", false)],
      harnessResults: [harness("s1", true), harness("c1", false)],
    };
    const code = await main(
      ["--compare", firstId],
      reportDeps(fs, {
        now: () => new Date("2026-09-13T13:00:00.000Z"),
        runEval: async () => worse,
      }),
    );

    expect(code).toBe(0);
    const markdown = fs.files.get("reports/2026-09-13T13-00-00Z-abc1234/report.md") ?? "";
    expect(markdown).toContain("倒退");
    expect(markdown).toContain(`## 与 \`${firstId}\` 对比`);
  });

  it("refuses to compare against a reportId that is not in the index", async () => {
    const fs = memoryFs();
    const errors: string[] = [];
    const code = await main(
      ["--compare", "nope"],
      reportDeps(fs, { stderr: (text: string) => errors.push(text) }),
    );
    expect(code).toBe(1);
    expect(errors.join(" ")).toContain('no report "nope"');
    expect(fs.files.size).toBe(0);
  });

  it("says so loudly when the index on disk is not readable JSON", async () => {
    const fs = memoryFs();
    const errors: string[] = [];
    fs.files.set("reports/index.json", "{ not json");
    const code = await main([], reportDeps(fs, { stderr: (text: string) => errors.push(text) }));

    expect(code).toBe(0);
    expect(errors.join(" ")).toContain("not readable JSON");
    expect(parseIndex(fs.files.get("reports/index.json") ?? "")).toHaveLength(1);
  });

  it("returns a usage error for an unknown flag instead of writing half a report", async () => {
    const fs = memoryFs();
    const errors: string[] = [];
    const code = await main(["--nope"], reportDeps(fs, { stderr: (text: string) => errors.push(text) }));
    expect(code).toBe(1);
    expect(errors.join(" ")).toContain("unknown argument");
    expect(fs.files.size).toBe(0);
  });

  it("notes the absence of --traces in the artifact instead of leaving it ambiguous", async () => {
    const fs = memoryFs();
    await main([], reportDeps(fs));
    const summary = JSON.parse(
      fs.files.get("reports/2026-09-13T12-00-00Z-abc1234/summary.json") ?? "{}",
    ) as { telemetry: { included: boolean; reason?: string }; traces: unknown };
    expect(summary.telemetry).toEqual({ included: false, reason: "--traces not requested" });
    expect(summary.traces).toBeNull();
  });

  it("includes injected trace telemetry and records where it came from", async () => {
    const fs = memoryFs();
    await main(
      ["--traces"],
      reportDeps(fs, {
        loadTraces: async () => ({
          metrics: {
            window: { since: "a", until: "b" },
            turns: 4,
            turnLatency: { n: 4, p50: 1500, p95: 3000 },
            modelCallLatency: { n: 8, p50: 700, p95: 1200 },
            traceWriteLatency: { n: 60, p50: 35, p95: 80 },
            cost: {
              n: 4,
              totalUsd: 0.04,
              perTurn: { n: 4, mean: 0.01 },
              tokenIn: 4000,
              tokenOut: 200,
              cacheHitTokens: 1000,
              promptTokens: 4000,
              cacheHitRate: 0.25,
            },
            stopReasons: [{ key: "end_turn", count: 4, share: 1 }],
            steps: { n: 4, p50: 3, p95: 6 },
            gates: {
              checkpointVerdict: [{ key: "output/pass", count: 4, share: 1 }],
              topCheckNames: [{ key: "output_entity_gate", count: 4, share: 1 }],
            },
            definitions: [],
          },
          source: "http://127.0.0.1:54321",
          window: { since: "a", until: "b" },
        }),
      }),
    );

    const summary = JSON.parse(
      fs.files.get("reports/2026-09-13T12-00-00Z-abc1234/summary.json") ?? "{}",
    ) as { telemetry: { included: boolean; source?: string } };
    expect(summary.telemetry).toEqual({
      included: true,
      source: "http://127.0.0.1:54321",
      window: { since: "a", until: "b" },
    });

    const markdown = fs.files.get("reports/2026-09-13T12-00-00Z-abc1234/report.md") ?? "";
    expect(markdown).toContain("## 轨迹遥测");
    expect(markdown).toContain("P95 3000ms");
    expect(markdown).toContain("缓存命中 25.0%");
  });

  it("still writes a report when the trace source fails, and says why", async () => {
    const fs = memoryFs();
    const errors: string[] = [];
    const code = await main(
      ["--traces"],
      reportDeps(fs, {
        stderr: (text: string) => errors.push(text),
        loadTraces: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    expect(code).toBe(0);
    expect(errors.join(" ")).toContain("trace telemetry failed");
    const summary = JSON.parse(
      fs.files.get("reports/2026-09-13T12-00-00Z-abc1234/summary.json") ?? "{}",
    ) as { telemetry: { included: boolean; reason?: string } };
    expect(summary.telemetry.reason).toContain("connection refused");
  });
});

describe("compareSummaries against a written report", () => {
  it("uses the dataset hash from the index, not from the current run", () => {
    const before = indexEntryFor(
      buildSummary({
        cases: CASES,
        bareResults: [],
        harnessResults: [],
        env: {
          reportId: "r1",
          at: "2026-09-13T12:00:00.000Z",
          mode: "scripted",
          tag: "t",
          gitSha: "abc",
          dirty: false,
          appVersion: "1",
          catalogVersion: "c",
        },
        traces: null,
        telemetry: { included: false, reason: "x" },
      }),
    );

    const changedCases = CASES.map((c) => ({ ...c, query: `${c.query} (edited)` }));
    const after = indexEntryFor(
      buildSummary({
        cases: changedCases,
        bareResults: [],
        harnessResults: [],
        env: {
          reportId: "r2",
          at: "2026-09-13T13:00:00.000Z",
          mode: "scripted",
          tag: "t",
          gitSha: "abc",
          dirty: false,
          appVersion: "1",
          catalogVersion: "c",
        },
        traces: null,
        telemetry: { included: false, reason: "x" },
      }),
    );

    const result = compareSummaries(before.summary, after.summary, undefined, {
      beforeDatasetHash: before.datasetHash,
      afterDatasetHash: after.datasetHash,
      beforeMode: before.mode,
      afterMode: after.mode,
    });
    expect(result.comparable).toBe(false);
  });
});
