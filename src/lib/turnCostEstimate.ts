// Worst-case cost of a single turn (RFC 0010 §3.3 — S3 / #100).
//
// Purpose, and its limit: this bounds one turn, it does not predict daily usage.
// A turn that can cost an order of magnitude more than a normal one is a bug or
// an attack, and both should be refused before the model call rather than found
// on the invoice. Everyday burn is what the daily budgets in quota.ts are for.
//
// The bound is built from what the pinned region, the catalog signature and the
// loop's own ceilings allow — never from the model's output:
//   * the pinned region is byte-stable by design (ADD §ContextAssembler, AOT), so
//     its token upper bound is computable once at cold start;
//   * every observation is capped by MAX_OBSERVATION_BYTES, and worst case every
//     step carries the sum of all observations so far;
//   * the loop runs at most MAX_STEPS steps, each with one model call;
//   * prompt tokens are charged at the cache-MISS rate and no completion is
//     treated as cached, because a bound that assumes cache hits is a bound that
//     holds only while the cache is warm.
//
// Money is counted by computeCostUsd over TIER_PRICING_USD, so a pricing change
// moves this estimate with it (RFC 0010 §2: pricing exists, aggregation and
// interception did not).

import { computeCostUsd } from "../harness/modelAdapter";
import { MAX_STEPS } from "../harness/loop";
import { MAX_OBSERVATION_BYTES } from "../catalog/queryCatalog";
import type { ModelTier } from "../harness/types";

/**
 * Characters per token, rounded up to a whole token. Half a token per character
 * is deliberately pessimistic for English (a real ratio is around one token per
 * four characters) and still pessimistic for CJK, where a character is often a
 * token. Pessimism is the safe direction for a ceiling: over-counting refuses a
 * turn that would have been affordable, under-counting lets an anomaly through,
 * and the defaults in quota.ts are calibrated against this number.
 */
const TOKENS_PER_CHAR = 0.5;

/**
 * Upper bound on the safety-constraint (profile) section of the pinned region.
 *
 * It cannot be measured at the preflight: the profile is read from Postgres
 * *after* the gate, and reading it is port assembly (RFC 0010 §3.3 puts the
 * checkpoint before any port exists).
 *
 * Derived from what can reach the section rather than guessed: `gate.ts`
 * renders the allergy and medication lists verbatim, and `profileValidation.ts`
 * caps each list at 50 entries of 100 characters, so the two lists are at most
 * 10,000 characters; the drug-interaction lines rendered beside them add a few
 * hundred more each, bounded here at another 4,000. A profile that exceeds this
 * is one the profile API would have refused.
 */
const PROFILE_REGION_TOKENS_UPPER_BOUND = tokensForChars(14_000);

/**
 * The retrieval evidence subset that S4 will pin into the region (RFC 0011 §3.7:
 * at most 40 sections, at most 6k tokens).
 *
 * Counted as 0 today, and this is a known under-count rather than a decision:
 * S3 and S4 are parallel branches, and the number to put here is whatever S4
 * actually pins. Until S4 lands, a turn whose cost is dominated by injected
 * evidence is not covered by this estimate. Calibrate this constant against the
 * shipped §3.7 subset when S4 lands (issue #100 keeps that as a second pass —
 * the bound must be corrected, not assumed to still hold).
 */
const EVIDENCE_SUBSET_TOKENS = 0;

/**
 * Upper bound on one response's completion tokens.
 *
 * The adapter sends no `max_tokens` (modelAdapter.ts), so this is the pinned
 * models' documented maximum output per response — the same provider
 * documentation `TIER_PRICING_USD` is mirrored from — rather than a knob this
 * repo controls. It is the largest number the provider will emit, which is
 * exactly what a worst case wants; if a `max_tokens` pin is ever added here,
 * this constant must come down to it.
 */
const MAX_OUTPUT_TOKENS_PER_CALL = 8192;

/**
 * The tier a chat turn runs at when the route pins none: `run()` in loop.ts
 * defaults to flash, and `app/api/chat/route.ts` passes no tier. Bound per tier
 * here rather than taking the more expensive one, so the estimate prices the
 * model that will actually be called; a route that starts pinning pro must pass
 * that tier through.
 */
export const ROUTE_TURN_TIER: ModelTier = "flash";

export interface TurnCostBounds {
  readonly tier: ModelTier;
  /** Pinned region: system prompt + profile ceiling + template catalog + tool defs. */
  readonly pinnedTokens: number;
  /**
   * The `tools` array sent beside the messages. The pinned region only lists the
   * tool names, but the provider charges for the full JSON schemas, so they are
   * a second prompt block rather than part of `pinnedTokens`.
   */
  readonly toolSchemaTokens: number;
  /** Catalog signature stamped on the turn (the snapshot version the run is pinned to). */
  readonly catalogSignatureTokens: number;
  /** S4's pinned evidence subset — 0 until S4 lands. */
  readonly evidenceTokens: number;
  /** One observation, at its byte ceiling. */
  readonly observationTokensPerStep: number;
  readonly outputTokensPerCall: number;
  readonly steps: number;
}

export interface TurnCostBoundInput {
  /**
   * `assemblePinnedRegion(...)` output for the prompt, template section and tool
   * list this route uses — everything except the profile section.
   */
  readonly pinnedText: string;
  /** `JSON.stringify(toolSchemas)` — see {@link TurnCostBounds.toolSchemaTokens}. */
  readonly toolSchemaText?: string;
  /** e.g. `catalog.snapshot.version`. */
  readonly catalogSignature: string;
  readonly tier?: ModelTier;
}

/**
 * Measure the static part of the bound. Called once at module load in the route:
 * the pinned region is AOT-stable, so measuring it per request would be work
 * whose result cannot change.
 */
export function buildTurnCostBounds(input: TurnCostBoundInput): TurnCostBounds {
  return {
    tier: input.tier ?? ROUTE_TURN_TIER,
    pinnedTokens:
      tokensForChars(input.pinnedText.length) + PROFILE_REGION_TOKENS_UPPER_BOUND,
    toolSchemaTokens: tokensForChars(input.toolSchemaText?.length ?? 0),
    catalogSignatureTokens: tokensForChars(input.catalogSignature.length),
    evidenceTokens: EVIDENCE_SUBSET_TOKENS,
    observationTokensPerStep: tokensForBytes(MAX_OBSERVATION_BYTES),
    outputTokensPerCall: MAX_OUTPUT_TOKENS_PER_CALL,
    steps: MAX_STEPS,
  };
}

/** Upper bound as a whole token: a fractional token still competes for the window. */
export function tokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) * TOKENS_PER_CHAR);
}

/**
 * Bytes to tokens. UTF-8 bytes are an upper bound on characters for every
 * encoding this content can use (one byte per ASCII character), so charging a
 * token per two bytes cannot under-count an observation that fills its ceiling.
 */
export function tokensForBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) * TOKENS_PER_CHAR);
}

export interface WorstCaseTurnInput {
  readonly bounds: TurnCostBounds;
  /** Characters of this request: the utterance plus the history it carries. */
  readonly requestChars: number;
}

/**
 * The estimate: every step re-sends everything the previous steps accumulated,
 * emits the provider's maximum output, and pays the cache-miss rate.
 *
 * Prompt tokens at step k are `base + k * observation`, so the sum over
 * `steps` calls is `steps * base + observation * steps * (steps - 1) / 2` — the
 * closed form of "the context grows by one observation per step".
 */
export function estimateWorstCaseTurnCostUsd(input: WorstCaseTurnInput): number {
  const { bounds } = input;
  const base =
    bounds.pinnedTokens +
    bounds.toolSchemaTokens +
    bounds.catalogSignatureTokens +
    bounds.evidenceTokens +
    tokensForChars(input.requestChars);
  const steps = Math.max(0, bounds.steps);
  const promptTokens =
    steps * base + bounds.observationTokensPerStep * ((steps * (steps - 1)) / 2);

  return computeCostUsd(bounds.tier, {
    promptTokens,
    completionTokens: steps * bounds.outputTokensPerCall,
    totalTokens: promptTokens + steps * bounds.outputTokensPerCall,
    // No cache split: see the header. computeCostUsd then charges every prompt
    // token at the miss rate.
  });
}
