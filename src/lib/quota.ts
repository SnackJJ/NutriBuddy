// Quota gate for the chat request boundary (RFC 0010 §3.3 — S3 / #97, #99, #103).
//
// Why this is not part of the turn seam: a quota refusal is a runtime control,
// not agent behaviour. Sending it through `turn()` would manufacture a turn with
// no content and drag two contracts that must not move for an ops policy —
// STOP_REASONS and SCHEMA_VERSION (RFC 0010 §3.3).
//
// The decision itself is a pure function of (limits, usage, worst-case turn
// cost, now). Counting and rejection reporting sit behind ports, so every
// boundary case — UTC day boundary, `limit = 0`, usage exactly at the limit —
// is testable without a database and without a model adapter.
//
// Soft limit, by decision and not by omission (§3.3): two concurrent requests
// can read the same usage and both be admitted. Provider-side spend caps are the
// hard ceiling. A distributed lock would buy one turn of accuracy in exchange
// for a failure mode nobody can debug.

/** Which budget refused the request. Also the `scope` of the 429 body. */
export type QuotaScope = "daily_turns" | "daily_cost" | "turn_cost";

export interface QuotaLimits {
  /** Turns admitted per UTC day. */
  readonly dailyTurns: number;
  /** Accumulated model spend admitted per UTC day, in USD. */
  readonly dailyCostUsd: number;
  /** Worst-case cost a single turn may be estimated at, in USD. */
  readonly maxTurnCostUsd: number;
}

export const QUOTA_ENV_KEYS = {
  dailyTurns: "QUOTA_DAILY_TURNS",
  dailyCostUsd: "QUOTA_DAILY_COST_USD",
  maxTurnCostUsd: "QUOTA_MAX_TURN_COST_USD",
} as const;

/**
 * Defaults for an env that sets nothing. They are finite on purpose: an absent
 * or unreadable value must never mean "no cap", because waiting for the bill is
 * the exact failure this slice removes (RFC 0010 §1).
 *
 * Calibration: the worst-case single-turn estimate in turnCostEstimate.ts — the
 * full pinned region, every observation at its byte ceiling, the provider's
 * maximum output on every step, no prompt cache hits — lands near $0.07 for a
 * normal request on the tier the route runs (flash) and near $0.20 if that turn
 * ran on pro. $0.50 per turn therefore admits a legitimate turn on either tier
 * with room to spare and still refuses one whose shape is the anomaly this check
 * exists for (a request hundreds of kilobytes larger than any real one). $1.00 a
 * day is roughly a hundred ordinary turns, and §9.2 makes cost the binding cap
 * with the turn count as the anti-spam one.
 */
export const QUOTA_DEFAULT_LIMITS: QuotaLimits = {
  dailyTurns: 40,
  dailyCostUsd: 1,
  maxTurnCostUsd: 0.5,
};

/**
 * Read the limits from an injected env.
 *
 * A value that is present but unreadable falls back to the default rather than
 * to zero or to infinity: a typo must not open the gate, and it must not lock
 * the operator out of their own app either. The default is a real cap, so this
 * direction of failure is safe. `0` is a legal value and is read literally —
 * see {@link decideQuota} for what it means.
 */
export function parseQuotaLimits(
  env: Record<string, string | undefined> = process.env,
): QuotaLimits {
  return {
    dailyTurns: readLimit(env[QUOTA_ENV_KEYS.dailyTurns], QUOTA_DEFAULT_LIMITS.dailyTurns),
    dailyCostUsd: readLimit(env[QUOTA_ENV_KEYS.dailyCostUsd], QUOTA_DEFAULT_LIMITS.dailyCostUsd),
    maxTurnCostUsd: readLimit(
      env[QUOTA_ENV_KEYS.maxTurnCostUsd],
      QUOTA_DEFAULT_LIMITS.maxTurnCostUsd,
    ),
  };
}

function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Usage aggregated from the `turns` rows of one UTC day. */
export interface DailyUsage {
  /** Every turn row started that day, including turns that failed. */
  readonly turns: number;
  /** Summed `turns.cost_usd`. */
  readonly costUsd: number;
}

/** The exact 429 body of RFC 0010 §3.3 / §5. */
export interface QuotaRejection {
  readonly error: "quota_exceeded";
  readonly scope: QuotaScope;
  readonly limit: number;
  readonly current: number;
  readonly resetAt: string;
}

export type QuotaVerdict = { readonly ok: true } | ({ readonly ok: false } & QuotaRejection);

/** The usage of a day nothing has happened in — see the preflight in {@link checkQuota}. */
const EMPTY_USAGE: DailyUsage = { turns: 0, costUsd: 0 };

export interface QuotaDecisionInput {
  readonly limits: QuotaLimits;
  /** Usage accumulated *before* the request being decided, for `now`'s UTC day. */
  readonly usage: DailyUsage;
  /** Worst-case cost of the turn this request would run (turnCostEstimate.ts). */
  readonly worstCaseTurnCostUsd: number;
  readonly now: Date;
}

/**
 * Decide one request against the three budgets.
 *
 * Boundary reading (RFC 0010 §6, "恰好等于上限 → 放行；超 1 → 拒"): `current` is
 * what the day has already spent, so a request is refused once the day has
 * *reached* the limit (`current >= limit`) — admitting it would push the day to
 * limit + 1. The request that lands the day exactly on the limit (current =
 * limit - 1) is admitted, and the refusal that follows carries `current == limit`,
 * which is the shape of the example body in §3.3.
 *
 * `limit = 0` therefore means "deny this scope outright": the first request
 * already reads `current >= 0`. That is the useful reading of a zero — an
 * operator who sets it wants the door shut, not one free turn, and it is what
 * makes a zero a legal emergency switch instead of a typo.
 *
 * Scope order is turn_cost → daily_cost → daily_turns: a request too expensive
 * on its own is a property of the request and is answered without touching the
 * database, and cost precedes the turn count because §9.2 makes cost the binding
 * budget — the reported scope should name the budget that actually bound.
 */
export function decideQuota(input: QuotaDecisionInput): QuotaVerdict {
  const resetAt = utcDayReset(input.now).toISOString();

  if (input.worstCaseTurnCostUsd >= input.limits.maxTurnCostUsd) {
    return reject(
      "turn_cost",
      input.limits.maxTurnCostUsd,
      input.worstCaseTurnCostUsd,
      resetAt,
    );
  }
  if (input.usage.costUsd >= input.limits.dailyCostUsd) {
    return reject("daily_cost", input.limits.dailyCostUsd, input.usage.costUsd, resetAt);
  }
  if (input.usage.turns >= input.limits.dailyTurns) {
    return reject("daily_turns", input.limits.dailyTurns, input.usage.turns, resetAt);
  }

  return { ok: true };
}

function reject(
  scope: QuotaScope,
  limit: number,
  current: number,
  resetAt: string,
): QuotaVerdict {
  return { ok: false, error: "quota_exceeded", scope, limit, current, resetAt };
}

/**
 * Start of `now`'s UTC day — the `started_at >=` bound of the usage read, and
 * the half-open lower edge of the counting window (RFC 0010 §5: the day boundary
 * is UTC, so it does not follow the user's timezone or the server's).
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The instant the day's usage goes back to zero; also the `resetAt` of a refusal. */
export function utcDayReset(now: Date): Date {
  const start = utcDayStart(now);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * The one structured line a refusal writes (RFC 0010 §3.4 / #103).
 *
 * `at` is the decision instant rather than the log call's, so the line and the
 * `resetAt` it accompanies describe the same moment.
 *
 * `path` is carried because the gate is wired at the request boundary and a
 * second caller (a future write route) would otherwise be indistinguishable in
 * the log; `user_id` is what makes "who was refused, when, and for which budget"
 * answerable by grep rather than by correlation across two systems.
 */
export interface QuotaLogLine {
  readonly user_id: string;
  readonly scope: QuotaScope;
  readonly limit: number;
  readonly current: number;
  readonly path: string;
  readonly at: string;
}

export function quotaRejectionLogLine(
  rejection: QuotaRejection,
  context: { readonly userId: string; readonly path: string; readonly at: Date },
): QuotaLogLine {
  return {
    user_id: context.userId,
    scope: rejection.scope,
    limit: rejection.limit,
    current: rejection.current,
    path: context.path,
    at: context.at.toISOString(),
  };
}

/** Cause of an unanswerable gate, logged next to the 503 the caller returns. */
export interface QuotaFailureLog {
  readonly user_id: string;
  readonly path: string;
  readonly at: string;
  readonly cause: string;
}

export interface QuotaGateDeps {
  readonly userId: string;
  /** `pathname` of the request that was refused — see {@link QuotaLogLine}. */
  readonly path: string;
  readonly limits: QuotaLimits;
  readonly now: Date;
  readonly worstCaseTurnCostUsd: number;
  /**
   * Counts the day's usage. Ports, not a client: the counting source is the
   * `turns` table (RFC 0010 §3.3) and no second source may be introduced.
   */
  readonly readDailyUsage: (userId: string, dayStart: Date) => Promise<DailyUsage>;
  /** One line per refusal. Required: a refusal nobody can find is unobservable. */
  readonly logRejection: (line: QuotaLogLine) => void;
  /** The counting source failed. Logged here; the caller maps the HTTP shape. */
  readonly logUnavailable: (line: QuotaFailureLog) => void;
}

export type QuotaGateResult =
  | { readonly kind: "allow"; readonly usage: DailyUsage }
  | { readonly kind: "reject"; readonly rejection: QuotaRejection }
  | { readonly kind: "unavailable" };

/**
 * Run the preflight for one request: per-request scope first, then the day's
 * usage, then the decision.
 *
 * The order matters twice over. `turn_cost` is decided from the request alone,
 * so a request that is too large never queries the database. And the usage read
 * happens once per request, before any port is assembled — a refused request
 * runs no model call and writes no turn row, which is what makes it invisible to
 * the counting source it was refused by (RFC 0010 §5).
 *
 * An unreadable counting source fails closed: a gate that opens when its source
 * is down is not a cap. The turn would in any case lose its trace row, so
 * refusing it costs the user nothing that was going to work.
 */
export async function checkQuota(deps: QuotaGateDeps): Promise<QuotaGateResult> {
  // Decided against zero usage, so only the budgets that need no counting can
  // fire here: the per-request cost, and a daily budget configured as zero.
  // Anything else has to wait for the read below, and this call is what keeps a
  // request that is already refusable from reaching the database.
  const preflight = decideQuota({
    limits: deps.limits,
    usage: EMPTY_USAGE,
    worstCaseTurnCostUsd: deps.worstCaseTurnCostUsd,
    now: deps.now,
  });
  if (!preflight.ok) {
    return refuse(deps, preflight);
  }

  let usage: DailyUsage;
  try {
    usage = await deps.readDailyUsage(deps.userId, utcDayStart(deps.now));
  } catch (err) {
    deps.logUnavailable({
      user_id: deps.userId,
      path: deps.path,
      at: deps.now.toISOString(),
      cause: err instanceof Error ? err.message : String(err),
    });
    return { kind: "unavailable" };
  }

  const verdict = decideQuota({
    limits: deps.limits,
    usage,
    worstCaseTurnCostUsd: deps.worstCaseTurnCostUsd,
    now: deps.now,
  });
  if (verdict.ok) {
    return { kind: "allow", usage };
  }
  return refuse(deps, verdict);
}

function refuse(
  deps: QuotaGateDeps,
  rejection: QuotaRejection,
): QuotaGateResult {
  deps.logRejection(
    quotaRejectionLogLine(rejection, {
      userId: deps.userId,
      path: deps.path,
      at: deps.now,
    }),
  );
  return { kind: "reject", rejection };
}

/**
 * The refusal body, field for field as RFC 0010 §3.3 specifies it. Returned
 * rather than serialised here so the route owns its HTTP surface and tests can
 * assert the body without parsing a stream.
 */
export function quotaRejectionBody(rejection: QuotaRejection): QuotaRejection {
  return {
    error: "quota_exceeded",
    scope: rejection.scope,
    limit: rejection.limit,
    current: rejection.current,
    resetAt: rejection.resetAt,
  };
}
