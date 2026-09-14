// Quota gate tests (S3 / RFC 0010 §3.3, §5, §6 — issues #97, #99, #100, #103).
//
// Two kinds of assertion live here, and the split is deliberate:
//   * the decision, the estimate and the log line are pure, so their boundary
//     cases are tested directly;
//   * "the route wires it before the model" is a property of `route.ts`, which
//     this repo tests by reading the file — the HTTP handler cannot be invoked
//     without a live Supabase auth call, and the checks are ordered text, so the
//     same style `chat.test.ts` uses for the 401 gate applies.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { computeCostUsd } from "../src/harness/modelAdapter";
import type { ModelUsage } from "../src/harness/types";
import { MAX_STEPS } from "../src/harness/loop";
import { MAX_OBSERVATION_BYTES } from "../src/catalog/queryCatalog";
import {
  checkQuota,
  decideQuota,
  parseQuotaLimits,
  quotaRejectionBody,
  quotaRejectionLogLine,
  utcDayReset,
  utcDayStart,
  QUOTA_DEFAULT_LIMITS,
  type DailyUsage,
  type QuotaGateDeps,
  type QuotaLimits,
} from "../src/lib/quota";
import {
  buildTurnCostBounds,
  estimateWorstCaseTurnCostUsd,
  tokensForChars,
  ROUTE_TURN_TIER,
} from "../src/lib/turnCostEstimate";

const LIMITS: QuotaLimits = {
  dailyTurns: 40,
  dailyCostUsd: 1,
  maxTurnCostUsd: 0.25,
};

/** Nothing spent, nothing run — the state a request with an empty day sees. */
const EMPTY_USAGE: DailyUsage = { turns: 0, costUsd: 0 };

function decide(
  usage: DailyUsage,
  overrides: Partial<QuotaLimits> = {},
  now = new Date("2026-07-26T12:00:00Z"),
) {
  return decideQuota({
    limits: { ...LIMITS, ...overrides },
    usage,
    worstCaseTurnCostUsd: 0.01,
    now,
  });
}

// ─── #97: the decision, and its edges ──────────────────────────────────

describe("decideQuota boundary behaviour (#97)", () => {
  it("admits the turn that lands the day exactly on the limit", () => {
    // 39 turns have run; the 40th brings the day to the limit of 40.
    expect(decide({ turns: 39, costUsd: 0 }).ok).toBe(true);
  });

  it("refuses once the day has reached the limit, and says so with current == limit", () => {
    const verdict = decide({ turns: 40, costUsd: 0 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.scope).toBe("daily_turns");
    expect(verdict.limit).toBe(40);
    expect(verdict.current).toBe(40);
  });

  it("refuses a day that is already one turn over the limit", () => {
    const verdict = decide({ turns: 41, costUsd: 0 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.scope).toBe("daily_turns");
  });

  it("applies the same edge to the daily cost budget", () => {
    expect(decide({ turns: 0, costUsd: 0.99 }).ok).toBe(true);
    const atLimit = decide({ turns: 0, costUsd: 1 });
    expect(atLimit.ok).toBe(false);
    if (atLimit.ok) return;
    expect(atLimit.scope).toBe("daily_cost");
    expect(atLimit.current).toBe(1);
  });

  it("refuses a turn whose worst-case estimate reaches the per-turn cap", () => {
    const verdict = decideQuota({
      limits: LIMITS,
      usage: EMPTY_USAGE,
      worstCaseTurnCostUsd: LIMITS.maxTurnCostUsd,
      now: new Date("2026-07-26T12:00:00Z"),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.scope).toBe("turn_cost");
    expect(verdict.limit).toBe(0.25);
    expect(verdict.current).toBe(0.25);
  });

  it("names the scope that actually binds: cost before turn count (§9.2)", () => {
    // Both budgets are exhausted; the refusal reports the binding one.
    const verdict = decide({ turns: 80, costUsd: 2 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.scope).toBe("daily_cost");
  });

  it("carries the next UTC midnight as resetAt", () => {
    const verdict = decide({ turns: 40, costUsd: 0 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.resetAt).toBe("2026-07-27T00:00:00.000Z");
  });

  it("resets across the UTC day boundary, not the server's local day", () => {
    // 23:59:59Z is still 26 July in UTC; one millisecond later the window rolls
    // and the same usage is a fresh day (RFC 0010 §5).
    expect(utcDayStart(new Date("2026-07-26T23:59:59.999Z")).toISOString()).toBe(
      "2026-07-26T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-07-27T00:00:00.000Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
    const justBefore = decide(
      { turns: 40, costUsd: 0 },
      {},
      new Date("2026-07-26T23:59:59.999Z"),
    );
    const justAfter = decide(
      { turns: 0, costUsd: 0 },
      {},
      new Date("2026-07-27T00:00:00.000Z"),
    );
    expect(justBefore.ok).toBe(false);
    expect(justAfter.ok).toBe(true);
    expect(utcDayReset(new Date("2026-07-26T23:59:59.999Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });

  it("limit = 0 denies the scope outright, including the first turn", () => {
    const turns = decide(EMPTY_USAGE, { dailyTurns: 0 });
    expect(turns.ok).toBe(false);
    if (!turns.ok) {
      expect(turns.scope).toBe("daily_turns");
      expect(turns.limit).toBe(0);
      expect(turns.current).toBe(0);
    }

    const cost = decide(EMPTY_USAGE, { dailyCostUsd: 0 });
    expect(cost.ok).toBe(false);
    if (!cost.ok) expect(cost.scope).toBe("daily_cost");

    const turnCost = decideQuota({
      limits: { ...LIMITS, maxTurnCostUsd: 0 },
      usage: EMPTY_USAGE,
      worstCaseTurnCostUsd: 0.01,
      now: new Date("2026-07-26T12:00:00Z"),
    });
    expect(turnCost.ok).toBe(false);
    if (!turnCost.ok) expect(turnCost.scope).toBe("turn_cost");
  });

  it("emits exactly the typed body of §3.3", () => {
    const verdict = decide({ turns: 40, costUsd: 0 });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(quotaRejectionBody(verdict)).toEqual({
      error: "quota_exceeded",
      scope: "daily_turns",
      limit: 40,
      current: 40,
      resetAt: "2026-07-27T00:00:00.000Z",
    });
  });
});

describe("parseQuotaLimits (#97 config)", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    expect(parseQuotaLimits({})).toEqual(QUOTA_DEFAULT_LIMITS);
    expect(QUOTA_DEFAULT_LIMITS.dailyTurns).toBeGreaterThan(0);
    expect(QUOTA_DEFAULT_LIMITS.dailyCostUsd).toBeGreaterThan(0);
    expect(QUOTA_DEFAULT_LIMITS.maxTurnCostUsd).toBeGreaterThan(0);
  });

  it("reads the three env vars", () => {
    expect(
      parseQuotaLimits({
        QUOTA_DAILY_TURNS: "5",
        QUOTA_DAILY_COST_USD: "0.5",
        QUOTA_MAX_TURN_COST_USD: "0.05",
      }),
    ).toEqual({ dailyTurns: 5, dailyCostUsd: 0.5, maxTurnCostUsd: 0.05 });
  });

  it("reads 0 literally instead of treating it as unset", () => {
    expect(parseQuotaLimits({ QUOTA_DAILY_TURNS: "0" }).dailyTurns).toBe(0);
  });

  it("falls back to a real cap — never to unlimited — for unreadable values", () => {
    const parsed = parseQuotaLimits({
      QUOTA_DAILY_TURNS: "forty",
      QUOTA_DAILY_COST_USD: "",
      QUOTA_MAX_TURN_COST_USD: "-1",
    });
    expect(parsed).toEqual(QUOTA_DEFAULT_LIMITS);
    expect(Number.isFinite(parsed.dailyTurns)).toBe(true);
    expect(Number.isFinite(parsed.dailyCostUsd)).toBe(true);
    expect(Number.isFinite(parsed.maxTurnCostUsd)).toBe(true);
  });
});

// ─── #100: the worst-case single-turn estimate ─────────────────────────

describe("estimateWorstCaseTurnCostUsd (#100)", () => {
  const bounds = buildTurnCostBounds({
    pinnedText: "p".repeat(4000),
    toolSchemaText: "t".repeat(1000),
    catalogSignature: "usda-test-v1",
  });

  it("measures the static bound from the pinned region and the loop's ceilings", () => {
    // Half a token per character for the region the request carries...
    expect(bounds.toolSchemaTokens).toBe(500);
    // ...plus an allowance for the profile section, which the preflight cannot
    // see. That allowance has to cover what validation lets a profile reach:
    // 50 allergies and 50 medications at 100 characters each (profileValidation).
    expect(bounds.pinnedTokens).toBeGreaterThanOrEqual(
      tokensForChars(4000) + tokensForChars(10_000),
    );
    expect(bounds.catalogSignatureTokens).toBe("usda-test-v1".length / 2);
    expect(bounds.observationTokensPerStep).toBe(MAX_OBSERVATION_BYTES / 2);
    expect(bounds.steps).toBe(MAX_STEPS);
    expect(bounds.tier).toBe(ROUTE_TURN_TIER);
    expect(bounds.tier).toBe("flash");
  });

  it("prices the bound through computeCostUsd, so pricing has one source", () => {
    const promptTokens =
      MAX_STEPS * (bounds.pinnedTokens + bounds.toolSchemaTokens + bounds.catalogSignatureTokens) +
      bounds.observationTokensPerStep * ((MAX_STEPS * (MAX_STEPS - 1)) / 2);
    const expected = computeCostUsd("flash", {
      promptTokens,
      completionTokens: MAX_STEPS * bounds.outputTokensPerCall,
      totalTokens: promptTokens + MAX_STEPS * bounds.outputTokensPerCall,
    });
    expect(estimateWorstCaseTurnCostUsd({ bounds, requestChars: 0 })).toBeCloseTo(
      expected,
      12,
    );
  });

  it("grows with the request it is bounding", () => {
    const small = estimateWorstCaseTurnCostUsd({ bounds, requestChars: 100 });
    const large = estimateWorstCaseTurnCostUsd({ bounds, requestChars: 100_000 });
    expect(large).toBeGreaterThan(small);
  });

  it("charges every prompt token at the cache-miss rate (no usage ⇒ conservative)", () => {
    // With no cache split, computeCostUsd already charges the miss rate — the
    // same figure the estimate uses. A cache hit must come out strictly cheaper,
    // which is what makes the estimate an upper bound rather than a guess.
    const estimate = estimateWorstCaseTurnCostUsd({ bounds, requestChars: 0 });
    const pricedWithHits = computeCostUsd("flash", {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    });
    expect(pricedWithHits).toBe(0);
    expect(estimate).toBeGreaterThan(pricedWithHits);

    const promptTokens = 100_000;
    const noSplit = computeCostUsd("flash", {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
    });
    const allHit = computeCostUsd("flash", {
      promptTokens,
      completionTokens: 0,
      totalTokens: promptTokens,
      cacheHitTokens: promptTokens,
      cacheMissTokens: 0,
    });
    expect(noSplit).toBeGreaterThan(allHit);
  });

  it("prices a fully-loaded turn below the default per-turn cap, on either tier", () => {
    // The defaults only make sense if a legitimate worst case fits under them;
    // this is the calibration the comment in quota.ts claims.
    const flash = estimateWorstCaseTurnCostUsd({ bounds, requestChars: 8_000 });
    const pro = estimateWorstCaseTurnCostUsd({
      bounds: { ...bounds, tier: "pro" },
      requestChars: 8_000,
    });
    expect(pro).toBeGreaterThan(flash);
    expect(flash).toBeLessThan(QUOTA_DEFAULT_LIMITS.maxTurnCostUsd);
    expect(pro).toBeLessThan(QUOTA_DEFAULT_LIMITS.maxTurnCostUsd);
    // A request an order of magnitude past any real one is what the cap is for.
    const anomalous = estimateWorstCaseTurnCostUsd({
      bounds: { ...bounds, tier: "pro" },
      requestChars: 2_000_000,
    });
    expect(anomalous).toBeGreaterThan(QUOTA_DEFAULT_LIMITS.maxTurnCostUsd);
  });

  it("counts the S4 evidence subset as 0 and says the correction is outstanding", () => {
    // Issue #100: the evidence subset that S4 pins (RFC 0011 §3.7) is not
    // available yet, so it contributes nothing today. Asserting the number and
    // the note together is the point — the second pass is scheduled, not
    // forgotten.
    expect(bounds.evidenceTokens).toBe(0);
    const source = fs.readFileSync("src/lib/turnCostEstimate.ts", "utf-8");
    expect(source).toContain("EVIDENCE_SUBSET_TOKENS = 0");
    expect(source).toMatch(/0011/);
    expect(source).toMatch(/S4/);
    expect(source).toMatch(/calibrate/i);
  });
});

// ─── #99: the preflight, and where it sits ─────────────────────────────

describe("checkQuota (#99)", () => {
  const NOW = new Date("2026-07-26T12:00:00Z");

  function deps(
    usage: DailyUsage,
    overrides: Partial<QuotaGateDeps> = {},
  ): QuotaGateDeps & { readonly rejections: string[]; readonly failures: string[] } {
    const rejections: string[] = [];
    const failures: string[] = [];
    return {
      userId: "user-1",
      path: "/api/chat",
      limits: LIMITS,
      now: NOW,
      worstCaseTurnCostUsd: 0.01,
      readDailyUsage: async () => usage,
      logRejection: (line) => rejections.push(JSON.stringify(line)),
      logUnavailable: (line) => failures.push(JSON.stringify(line)),
      rejections,
      failures,
      ...overrides,
    };
  }

  it("admits a request under every budget, reporting the usage it read", async () => {
    const result = await checkQuota(deps({ turns: 3, costUsd: 0.02 }));
    expect(result.kind).toBe("allow");
    if (result.kind !== "allow") return;
    expect(result.usage).toEqual({ turns: 3, costUsd: 0.02 });
  });

  it("refuses over the limit with the typed body, and there is no adapter to call", async () => {
    // The dependency list is the assertion: a usage reader and two sinks. No
    // model port is in scope, so "no model call" holds by construction rather
    // than by a spy — and route.ts (below) returns before constructing one.
    const d = deps({ turns: 40, costUsd: 0.1 });
    const result = await checkQuota(d);
    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") return;
    expect(quotaRejectionBody(result.rejection)).toEqual({
      error: "quota_exceeded",
      scope: "daily_turns",
      limit: 40,
      current: 40,
      resetAt: "2026-07-27T00:00:00.000Z",
    });
    expect(d.rejections).toHaveLength(1);
  });

  it("reads the day that starts at the request's UTC midnight", async () => {
    const seen: string[] = [];
    await checkQuota(
      deps(EMPTY_USAGE, {
        readDailyUsage: async (_userId, dayStart) => {
          seen.push(dayStart.toISOString());
          return EMPTY_USAGE;
        },
      }),
    );
    expect(seen).toEqual(["2026-07-26T00:00:00.000Z"]);
  });

  it("refuses a too-expensive request without reading the counting source", async () => {
    let reads = 0;
    const result = await checkQuota(
      deps(EMPTY_USAGE, {
        worstCaseTurnCostUsd: 0.25,
        readDailyUsage: async () => {
          reads += 1;
          return EMPTY_USAGE;
        },
      }),
    );
    expect(result.kind).toBe("reject");
    if (result.kind === "reject") expect(result.rejection.scope).toBe("turn_cost");
    expect(reads).toBe(0);
  });

  it("fails closed when the counting source cannot be read", async () => {
    const d = deps(EMPTY_USAGE, {
      readDailyUsage: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await checkQuota(d);
    expect(result.kind).toBe("unavailable");
    expect(d.failures).toHaveLength(1);
    expect(d.failures[0]).toContain("connection refused");
  });
});

describe("route wiring (#99, #103)", () => {
  const routeSource = () => fs.readFileSync("app/api/chat/route.ts", "utf-8");

  it("checks the quota after the session gate and before any port exists", () => {
    const source = routeSource();
    const sessionGate = source.search(/if\s*\(\s*!session\s*\)/);
    const preflight = source.indexOf("await checkQuota(");
    const adapterCtor = source.indexOf("new DeepSeekAdapter");
    expect(sessionGate).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(-1);
    expect(adapterCtor).toBeGreaterThan(-1);
    expect(sessionGate).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(adapterCtor);

    // The refusal returns before the adapter, the tracer and the trace store:
    // no model call, and no turn row for the counting source to see (§5).
    const refusal = source.indexOf('quota.kind === "reject"');
    expect(refusal).toBeGreaterThan(preflight);
    expect(refusal).toBeLessThan(adapterCtor);
    expect(source).toMatch(/status:\s*429/);
    expect(source).toContain("quotaRejectionBody");
    expect(source).toMatch(/status:\s*503/);
  });

  it("writes one structured line per refusal, and keeps console out of the library", () => {
    const source = routeSource();
    expect(source).toMatch(/console\.warn\(`\[quota\] \$\{JSON\.stringify\(line\)\}`\)/);
    expect(source).toMatch(/console\.error\(`\[quota\] \$\{JSON\.stringify\(line\)\}`\)/);

    const quotaLib = fs.readFileSync("src/lib/quota.ts", "utf-8");
    expect(quotaLib).not.toContain("console.");
    expect(quotaLib).not.toMatch(/from "\.\.\/harness/);
  });

  it("keeps quota out of the turn seam: no harness module knows the word", () => {
    // RFC 0010 §3.3: refusal is runtime control, not agent behaviour. If the
    // harness learned about quota, STOP_REASONS and SCHEMA_VERSION would be
    // changing for an ops policy — this is the assertion that they do not.
    for (const file of [
      "src/harness/turn.ts",
      "src/harness/loop.ts",
      "src/harness/traceStore.ts",
      "src/harness/types.ts",
    ]) {
      expect(fs.readFileSync(file, "utf-8").toLowerCase()).not.toContain("quota");
    }
  });
});

// ─── #103: the log line ────────────────────────────────────────────────

describe("quotaRejectionLogLine (#103)", () => {
  it("carries the six fields the RFC names, and nothing else", () => {
    const verdict = decideQuota({
      limits: LIMITS,
      usage: { turns: 0, costUsd: 1.5 },
      worstCaseTurnCostUsd: 0.01,
      now: new Date("2026-07-26T12:34:56.789Z"),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;

    const line = quotaRejectionLogLine(verdict, {
      userId: "user-7",
      path: "/api/chat",
      at: new Date("2026-07-26T12:34:56.789Z"),
    });
    expect(line).toEqual({
      user_id: "user-7",
      scope: "daily_cost",
      limit: 1,
      current: 1.5,
      path: "/api/chat",
      at: "2026-07-26T12:34:56.789Z",
    });
    expect(Object.keys(line).sort()).toEqual([
      "at",
      "current",
      "limit",
      "path",
      "scope",
      "user_id",
    ]);
  });
});

// ─── Pricing sanity: the estimate's inputs still exist ─────────────────

describe("estimate inputs", () => {
  it("uses provider pricing the adapter actually exports", () => {
    const usage: ModelUsage = {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    };
    expect(computeCostUsd("flash", usage)).toBeCloseTo(0.28 + 0.42, 10);
    expect(computeCostUsd("pro", usage)).toBeCloseTo(0.56 + 1.68, 10);
  });
});
