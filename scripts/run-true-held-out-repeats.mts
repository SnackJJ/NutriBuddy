// Budgeted live repeats for True Held-Out Evaluation Cases.

import { computeCostUsd } from "../src/harness/modelAdapter";
import type { ModelUsage } from "../src/harness/types";
import { main } from "../src/eval/report";
import { TRUE_HELD_OUT_CASES } from "../src/eval/trueHeldOutCases";

interface Args {
  readonly runs: number;
  readonly budget: number;
  readonly tagPrefix: string;
  readonly out?: string;
  readonly arms: "both" | "harness" | "bare";
}

function parseArgs(argv: readonly string[]): Args {
  let runs = 3;
  let budget = 0.5;
  let tagPrefix = "true-held-out";
  let out: string | undefined;
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
  return { runs, budget, tagPrefix, out, arms };
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
    // ignore
  }
  return res;
};

process.stderr.write(
  `running true held-out: n=${TRUE_HELD_OUT_CASES.length} runs=${args.runs} prefix=${args.tagPrefix} budget=${args.budget}\n`,
);

for (let r = 1; r <= args.runs; r += 1) {
  const tag = `${args.tagPrefix}-r${r}`;
  process.stderr.write(`\n=== RUN ${r}/${args.runs}: ${tag} ===\n`);
  const code = await main(
    ["--live", "--tag", tag, "--arms", args.arms],
    {
      ...(args.out ? { outDir: args.out } : {}),
      loadCases: () => TRUE_HELD_OUT_CASES,
    },
  );
  process.stderr.write(`run ${r} exit=${code} spent=${spent.toFixed(4)}\n`);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}

process.stderr.write(`DONE spent=${spent.toFixed(4)} calls=${calls}\n`);
