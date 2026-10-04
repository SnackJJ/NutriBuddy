// Budgeted live repeats for the scoring-口径 experiment.
//
// Wraps fetch, prices each chat completion with the repo's flash table, and
// stops before the next call once the running total reaches the cap. The
// figure is upstream DeepSeek pricing; a gateway markup is not in it.
//
//   node --env-file=.env.local --import tsx scripts/resume-exp-scoring-runs.mts \
//     --runs 3 --budget 15 --tag-prefix resume-exp-scoring

import { computeCostUsd } from "../src/harness/modelAdapter";
import type { ModelUsage } from "../src/harness/types";
import { main } from "../src/eval/report";
import { loadEvalCases } from "../src/eval/dataset";

interface Args {
  readonly runs: number;
  readonly budget: number;
  readonly tagPrefix: string;
  readonly out?: string;
  readonly ids?: readonly string[];
  readonly arms: "both" | "harness" | "bare";
}

function parseArgs(argv: readonly string[]): Args {
  let runs = 1;
  let budget = 15;
  let tagPrefix = "resume-exp-scoring";
  let out: string | undefined;
  let ids: string[] | undefined;
  let arms: Args["arms"] = "both";
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--runs") runs = Number(value());
    else if (flag === "--budget") budget = Number(value());
    else if (flag === "--tag-prefix") tagPrefix = value();
    else if (flag === "--out") out = value();
    else if (flag === "--ids") ids = value().split(",").filter(Boolean);
    else if (flag === "--arms") {
      const name = value();
      if (name !== "both" && name !== "harness" && name !== "bare") {
        throw new Error("--arms must be both|harness|bare");
      }
      arms = name;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!Number.isFinite(runs) || runs < 1) throw new Error("--runs must be >= 1");
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("--budget must be > 0");
  return { runs, budget, tagPrefix, out, ids, arms };
}

function costOf(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): number {
  if (typeof usage.total_tokens !== "number") return 0;
  const prompt = usage.prompt_tokens ?? 0;
  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - cacheHit);
  const modelUsage: ModelUsage = {
    promptTokens: prompt,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
  };
  return computeCostUsd("flash", modelUsage);
}

const args = parseArgs(process.argv.slice(2));
let spent = 0;
let calls = 0;
const origFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  if (spent >= args.budget) {
    throw new Error(`BUDGET_STOP spent=${spent.toFixed(4)} cap=${args.budget}`);
  }
  const res = await origFetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes("/chat/completions") || !res.ok) return res;
  try {
    const data = (await res.clone().json()) as { usage?: Parameters<typeof costOf>[0] };
    if (data.usage) {
      const add = costOf(data.usage);
      spent += add;
      calls += 1;
      process.stderr.write(
        `cost +${add.toFixed(5)} spent=${spent.toFixed(4)} calls=${calls}\n`,
      );
    }
  } catch {
    // A body that is not JSON still returns to the adapter.
  }
  return res;
};

const cases = loadEvalCases("base").filter((evalCase) =>
  args.ids === undefined ? true : args.ids.includes(evalCase.id),
);
if (cases.length === 0) throw new Error("no cases selected");

process.stderr.write(
  `plan runs=${args.runs} cases=${cases.length} arms=${args.arms} budget=${args.budget}\n`,
);

for (let run = 1; run <= args.runs; run += 1) {
  if (spent >= args.budget) {
    process.stderr.write(`stop before run ${run}: spent=${spent.toFixed(4)}\n`);
    break;
  }
  const tag = `${args.tagPrefix}-r${run}`;
  const code = await main(
    ["--live", "--tag", tag, "--arms", args.arms],
    {
      ...(args.out ? { outDir: args.out } : {}),
      loadCases: () => cases,
    },
  );
  process.stderr.write(`run ${run} exit=${code} spent=${spent.toFixed(4)}\n`);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
  const projected = spent * (args.runs / run);
  if (projected > args.budget && run < args.runs) {
    process.stderr.write(
      `stop after run ${run}: projected ${projected.toFixed(4)} exceeds budget ${args.budget}\n`,
    );
    break;
  }
}

process.stderr.write(`DONE spent=${spent.toFixed(4)} calls=${calls}\n`);
