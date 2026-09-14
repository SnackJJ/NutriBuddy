// Trace aggregation for the eval report (S2 / #93 / RFC 0009 §4).
//
// The instrumented data has existed since #51: every `model_call` carries
// `latencyMs`, `usage` and `costUsd`, every turn row carries the SQL-aggregated
// cost and latency. What was missing was the aggregation, and the one thing this
// file must not do is a second aggregation of the same facts — `turns.cost_usd`
// and `turns.latency_ms` are read from the row the RPC computed (RFC 0008 §3.4).
//
// Two things are deliberately *not* shared with SupabaseTraceStore:
//   * the reader is not user-bound. An eval report describes a window of traffic,
//     not one account, and the operator running it has the service role anyway —
//     the runtime store's binding exists so the request path cannot widen, and
//     widening it for a report would trade that guarantee for nothing;
//   * it reads `created_at` alongside `payload`, because trace write latency is
//     the difference between the two and no other reader needs it.
//
// What this module produces is privacy-preserving by construction: counts,
// percentiles and gate names — no user ids, no utterances, no observations. That
// is the form the report may carry into git while raw traces stay out (§6).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyTurnEvent, GateCheckpoint, GateVerdict } from "../harness/turn";
import type { ModelUsage } from "../harness/types";
import { TraceStoreError, type TurnSummary } from "../harness/traceStore";
import { TURN_COLUMNS, toTurnSummary } from "../harness/supabaseTraceStore";
import {
  countBy,
  distribution,
  topByCount,
  type CountEntry,
  type Distribution,
  type MetricDefinition,
} from "./summary";

/** How many distinct checkNames the gate distribution keeps. */
export const TOP_CHECK_NAMES = 10;

/** One `turn_events` row: the payload plus when the database wrote it. */
export interface TraceEventRow {
  readonly payload: AnyTurnEvent;
  readonly createdAt: string;
}

/** A turn reduced to the numbers the report aggregates. */
export interface TurnSample {
  readonly turnId: string;
  readonly stopReason?: string;
  /** From the turn row, where the RPC aggregated it. */
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly steps?: number;
  readonly modelCalls: readonly {
    readonly latencyMs?: number;
    readonly usage?: ModelUsage;
  }[];
  readonly gates: readonly {
    readonly checkpoint: GateCheckpoint;
    readonly verdict: GateVerdict;
    readonly checkName: string;
  }[];
}

export interface TraceWindowQuery {
  /** Inclusive lower bound (ISO), compared against `turns.started_at`. */
  readonly since: string;
  /** Exclusive upper bound (ISO). */
  readonly until: string;
  readonly limit: number;
}

/**
 * What the aggregation needs from a trace store, narrowed to two reads so an
 * in-memory implementation can drive the tests and a database implementation can
 * drive the report (issue #93: "S1 落地后仅替换数据源，不动调用方").
 */
export interface TraceAggregateSource {
  listTurns(query: TraceWindowQuery): Promise<TurnSummary[]>;
  listEvents(turnId: string): Promise<readonly TraceEventRow[]>;
}

function readError(error: unknown, operation: string): TraceStoreError {
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code = typeof record.code === "string" ? record.code : "unknown";
  const message =
    typeof record.message === "string" ? record.message : String(error);
  return new TraceStoreError(code, `${operation}: ${message}`);
}

/** Service-role reader for a window of traffic across all accounts. */
export function createSupabaseTraceAggregateSource(
  client: SupabaseClient,
): TraceAggregateSource {
  return {
    async listTurns({ since, until, limit }) {
      // Newest `limit` in the window, returned oldest-first: a report describes
      // the recent end of a window, and an ascending LIMIT would describe the
      // oldest end instead.
      const { data, error } = await client
        .from("turns")
        .select(TURN_COLUMNS)
        .gte("started_at", since)
        .lt("started_at", until)
        .order("started_at", { ascending: false })
        .limit(Math.max(0, limit));
      if (error) throw readError(error, "listTurns");
      return (data ?? [])
        .map((row: Record<string, unknown>) => toTurnSummary(row))
        .reverse();
    },

    async listEvents(turnId) {
      const { data, error } = await client
        .from("turn_events")
        .select("payload, created_at")
        .eq("turn_id", turnId)
        .order("seq", { ascending: true });
      if (error) throw readError(error, "listEvents");
      return (data ?? []).map((row: Record<string, unknown>) => ({
        payload: row.payload as AnyTurnEvent,
        createdAt: String(row.created_at),
      }));
    },
  };
}

/**
 * When each event reached the database, measured against its own timestamp.
 *
 * Negative differences are clamped to zero: the producer's clock and the
 * database's are different clocks, so a "negative latency" is skew, not speed.
 * The clamping is stated rather than hidden because it is the one place where
 * this metric can be exactly wrong.
 */
export function traceWriteLatencyMs(rows: readonly TraceEventRow[]): number[] {
  const latencies: number[] = [];
  for (const row of rows) {
    const written = Date.parse(row.createdAt);
    const produced = Date.parse(row.payload.timestamp);
    if (!Number.isFinite(written) || !Number.isFinite(produced)) continue;
    latencies.push(Math.max(0, written - produced));
  }
  return latencies;
}

export function sampleTurn(
  turn: TurnSummary,
  rows: readonly TraceEventRow[],
): TurnSample {
  const events = rows.map((row) => row.payload);

  const modelCalls = events
    .filter(
      (event): event is Extract<AnyTurnEvent, { type: "model_call" }> =>
        event.type === "model_call",
    )
    .map((event) => ({
      latencyMs: event.latencyMs,
      usage: event.usage,
    }));

  const gates = events
    .filter(
      (event): event is Extract<AnyTurnEvent, { type: "gate_verdict" }> =>
        event.type === "gate_verdict",
    )
    .map((event) => ({
      checkpoint: event.checkpoint,
      verdict: event.verdict,
      checkName: event.checkName,
    }));

  const terminal = events.find(
    (event): event is Extract<AnyTurnEvent, { type: "turn_end" }> =>
      event.type === "turn_end",
  );

  return {
    turnId: turn.turnId,
    stopReason: turn.stopReason ?? terminal?.result.stopReason,
    costUsd: turn.costUsd,
    latencyMs: turn.latencyMs,
    steps: turn.steps ?? terminal?.result.steps,
    modelCalls,
    gates,
  };
}

export interface TraceMetrics {
  readonly window: { readonly since: string; readonly until: string };
  readonly turns: number;
  readonly turnLatency: Distribution;
  readonly modelCallLatency: Distribution;
  readonly traceWriteLatency: Distribution;
  readonly cost: {
    readonly n: number;
    readonly totalUsd: number;
    /** Per-turn sum of `model_call.costUsd`, including regenerate attempts. */
    readonly perTurn: Distribution;
    readonly tokenIn: number;
    readonly tokenOut: number;
    readonly cacheHitTokens: number;
    readonly promptTokens: number;
    /** Cached share of the prompt; undefined when no prompt tokens were reported. */
    readonly cacheHitRate?: number;
  };
  readonly stopReasons: readonly CountEntry[];
  readonly steps: Distribution;
  readonly gates: {
    readonly checkpointVerdict: readonly CountEntry[];
    readonly topCheckNames: readonly CountEntry[];
  };
  readonly definitions: readonly MetricDefinition[];
}

export interface TurnSampleWithWrites {
  readonly turn: TurnSample;
  readonly writeLatenciesMs: readonly number[];
}

/**
 * Turn latency is the row's `latency_ms`, which the RPC computed in SQL from the
 * two event timestamps (RFC 0008 §3.4). A turn whose terminal write never landed
 * has no such column value, and is left out of the distribution instead of being
 * recomputed here: a second computation of the same number is the second source
 * of truth that decision forbids.
 */
function turnLatencyMs(turn: TurnSample): number | undefined {
  return typeof turn.latencyMs === "number" ? turn.latencyMs : undefined;
}

export function aggregateTraces(
  samples: readonly TurnSampleWithWrites[],
  window: { readonly since: string; readonly until: string },
  definitions: readonly MetricDefinition[],
): TraceMetrics {
  const turns = samples.map((entry) => entry.turn);

  const turnLatencies = turns
    .map(turnLatencyMs)
    .filter((value): value is number => value !== undefined);

  const modelCallLatencies = turns
    .flatMap((turn) => turn.modelCalls.map((call) => call.latencyMs))
    .filter((value): value is number => value !== undefined);

  const writeLatencies = samples.flatMap((entry) => [...entry.writeLatenciesMs]);

  // Cost comes from the turn rows, not from the model_call events: the RPC
  // already summed them in SQL, and RFC 0008 §3.4 makes that column the single
  // source — S2 and S3 read it rather than recomputing it. Tokens and cache
  // hits have no column, so those are the one thing read from the events.
  const perTurnCosts = turns
    .map((turn) => turn.costUsd)
    .filter((value): value is number => value !== undefined);

  const usage = turns.flatMap((turn) =>
    turn.modelCalls
      .map((call) => call.usage)
      .filter((value): value is ModelUsage => value !== undefined),
  );
  const promptTokens = usage.reduce((total, u) => total + u.promptTokens, 0);
  const completionTokens = usage.reduce((total, u) => total + u.completionTokens, 0);
  const cacheHitTokens = usage.reduce((total, u) => total + (u.cacheHitTokens ?? 0), 0);

  const allGates = turns.flatMap((turn) => turn.gates);

  return {
    window,
    turns: turns.length,
    turnLatency: distribution(turnLatencies),
    modelCallLatency: distribution(modelCallLatencies),
    traceWriteLatency: distribution(writeLatencies),
    cost: {
      // `n` is the turns that carried a cost column, which is the population the
      // per-turn distribution describes — not the turn count of the window.
      n: perTurnCosts.length,
      totalUsd: perTurnCosts.reduce((total, value) => total + value, 0),
      perTurn: distribution(perTurnCosts),
      tokenIn: promptTokens,
      tokenOut: completionTokens,
      cacheHitTokens,
      promptTokens,
      cacheHitRate: promptTokens > 0 ? cacheHitTokens / promptTokens : undefined,
    },
    stopReasons: countBy(
      turns
        .map((turn) => turn.stopReason)
        .filter((value): value is string => typeof value === "string"),
      turns.length,
    ),
    steps: distribution(
      turns
        .map((turn) => turn.steps)
        .filter((value): value is number => typeof value === "number"),
    ),
    gates: {
      checkpointVerdict: countBy(
        allGates.map((gate) => `${gate.checkpoint}/${gate.verdict}`),
      ),
      topCheckNames: topByCount(
        allGates.map((gate) => gate.checkName),
        TOP_CHECK_NAMES,
      ),
    },
    definitions,
  };
}

/**
 * Read a window and aggregate it. Sequential per turn on purpose: the reads are
 * one operator's report against a database, and a fan-out would buy latency
 * nobody is waiting on while making the failure mode a partial read.
 */
export async function collectTraceMetrics(
  source: TraceAggregateSource,
  query: TraceWindowQuery,
  definitions: readonly MetricDefinition[],
): Promise<TraceMetrics> {
  const turns = await source.listTurns(query);
  const samples: TurnSampleWithWrites[] = [];
  for (const turn of turns) {
    const rows = await source.listEvents(turn.turnId);
    samples.push({
      turn: sampleTurn(turn, rows),
      writeLatenciesMs: traceWriteLatencyMs(rows),
    });
  }
  return aggregateTraces(samples, { since: query.since, until: query.until }, definitions);
}
