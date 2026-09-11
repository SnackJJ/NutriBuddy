// InMemoryTraceStore — the in-memory TraceStore used by tests (S1 / RFC 0008 §3.2).
//
// It mirrors the SQL contract of migration 0011 rather than inventing its own:
//   * turn_start creates the row; turn_end finalizes it (cost aggregated from
//     model_call events, latency = turn_end - turn_start, same as the RPC).
//   * non-start events resolve their owner from the stored turn row and never
//     from the caller, so a mis-wired store cannot write events that a second
//     user would be able to read.
//   * an event whose seq already exists is ignored (the RPC's
//     `on conflict (turn_id, seq) do nothing`) — retries are idempotent.
//   * a non-start event for an unknown turn raises 23503, mirroring the RPC's
//     ordering guard.
//
// Keeping that contract here is what lets one contract suite drive both this
// implementation and the Supabase one.

import type { AnyTurnEvent } from "./turn";
import {
  TraceStoreError,
  type TraceStore,
  type TurnMeta,
  type TurnSummary,
} from "./traceStore";

interface TurnRow {
  readonly turnId: string;
  readonly userId: string;
  readonly inputKind: string;
  readonly schemaVersion: string;
  readonly startedAt: string;
  readonly appVersion?: string;
  finishedAt?: string;
  stopReason?: string;
  steps?: number;
  costUsd?: number;
  latencyMs?: number;
  readonly events: AnyTurnEvent[];
}

/** Shared store of rows, so several TraceStores can be exercised against one another. */
export class InMemoryTraceDb {
  readonly rows = new Map<string, TurnRow>();
}

export interface InMemoryTraceStoreOptions {
  readonly turnId: string;
  /** Bound once, like the server-side session user in the real write path. */
  readonly userId: string;
  readonly db?: InMemoryTraceDb;
  /** Metadata the event stream does not carry (RPC `p_meta`). */
  readonly meta?: TurnMeta;
  /** Injected write failure for reaction tests: throw at `seq`, `times` times. */
  readonly failAt?: { readonly seq: number; readonly times: number };
}

function cloneEvent(event: AnyTurnEvent): AnyTurnEvent {
  return JSON.parse(JSON.stringify(event)) as AnyTurnEvent;
}

export class InMemoryTraceStore implements TraceStore {
  readonly turnId: string;

  private readonly userId: string;
  private readonly db: InMemoryTraceDb;
  private readonly appVersion: string | undefined;
  private readonly failAtSeq: number | undefined;
  private failuresLeft: number;

  constructor(opts: InMemoryTraceStoreOptions) {
    this.turnId = opts.turnId;
    this.userId = opts.userId;
    this.db = opts.db ?? new InMemoryTraceDb();
    this.appVersion = opts.meta?.appVersion;
    this.failAtSeq = opts.failAt?.seq;
    this.failuresLeft = opts.failAt?.times ?? 0;
  }

  async append(event: AnyTurnEvent): Promise<void> {
    const raw = event as {
      readonly type?: unknown;
      readonly seq?: unknown;
      readonly schema?: unknown;
      readonly timestamp?: unknown;
      readonly input?: { readonly tag?: unknown };
    };

    // No silent defaults: the RPC raises 22P02 for the same malformed payloads
    // (RFC 0008 §3.7), and both implementations must agree.
    if (
      typeof raw.type !== "string" ||
      typeof raw.seq !== "number" ||
      typeof raw.schema !== "string" ||
      typeof raw.timestamp !== "string"
    ) {
      throw new TraceStoreError(
        "22P02",
        "append: event lacks type/seq/schema/timestamp — malformed payload",
      );
    }

    if (raw.type === "turn_start") {
      if (raw.seq !== 0) {
        throw new TraceStoreError(
          "22P02",
          `append: turn_start must have seq 0, got ${raw.seq}`,
        );
      }
      if (typeof raw.input?.tag !== "string") {
        throw new TraceStoreError("22P02", "append: turn_start lacks input.tag");
      }
    }

    if (this.failAtSeq !== undefined && raw.seq === this.failAtSeq) {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw new Error(`injected trace write failure at seq ${raw.seq}`);
      }
    }

    if (raw.type === "turn_start" && !this.db.rows.has(this.turnId)) {
      // appVersion is not part of the event stream — it arrives via TurnMeta,
      // exactly like the RPC's `p_meta` parameter (RFC 0008 §3.4).
      const start = event as Extract<AnyTurnEvent, { type: "turn_start" }>;
      this.db.rows.set(this.turnId, {
        turnId: this.turnId,
        userId: this.userId,
        inputKind: start.input.tag,
        schemaVersion: start.schema,
        startedAt: start.timestamp,
        appVersion: this.appVersion,
        events: [],
      });
    }

    const row = this.db.rows.get(this.turnId);
    if (!row) {
      throw new TraceStoreError(
        "23503",
        `append: unknown turn ${this.turnId} — turn_start must be written first`,
      );
    }

    // A turn_start retry must not be able to hand this turn to another user.
    if (raw.type === "turn_start" && row.userId !== this.userId) {
      throw new TraceStoreError(
        "23514",
        `append: turn ${this.turnId} belongs to another user`,
      );
    }

    const stored = row.events.find((e) => e.seq === raw.seq);
    if (stored) {
      // Same bytes = a retry after a lost response: a no-op, like `do nothing`.
      // Different bytes = the assembly layer reused a seq: never silent.
      if (JSON.stringify(stored) !== JSON.stringify(event)) {
        throw new TraceStoreError(
          "23514",
          `append: seq ${raw.seq} already stored with a different payload`,
        );
      }
      return;
    }

    row.events.push(cloneEvent(event));
    row.events.sort((a, b) => a.seq - b.seq);

    if (event.type === "turn_end") {
      row.finishedAt = event.timestamp;
      row.stopReason = event.result.stopReason;
      row.steps = event.result.steps;
      row.costUsd = sumModelCallCostUsd(row.events);
      row.latencyMs = latencyMs(row.events);
    }
  }

  async listByTurn(turnId: string, sinceSeq?: number): Promise<AnyTurnEvent[]> {
    const row = this.db.rows.get(turnId);
    // Unknown turn and someone else's turn are indistinguishable to a caller,
    // mirroring RLS: the route turns both into 404 (RFC 0008 §5).
    if (!row || row.userId !== this.userId) return [];
    return row.events
      .filter((e) => sinceSeq === undefined || e.seq > sinceSeq)
      .map(cloneEvent);
  }

  async listTurns(limit: number): Promise<TurnSummary[]> {
    return [...this.db.rows.values()]
      .filter((row) => row.userId === this.userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(0, limit))
      .map((row) => ({
        turnId: row.turnId,
        userId: row.userId,
        inputKind: row.inputKind,
        schemaVersion: row.schemaVersion,
        startedAt: row.startedAt,
        appVersion: row.appVersion,
        finishedAt: row.finishedAt,
        stopReason: row.stopReason,
        steps: row.steps,
        costUsd: row.costUsd,
        latencyMs: row.latencyMs,
      }));
  }
}

// ── aggregation, mirroring the RPC's SQL (RFC 0008 §3.4) ───────────────────

/** Sum of model_call costs, including every regenerate attempt. */
export function sumModelCallCostUsd(events: readonly AnyTurnEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type !== "model_call") continue;
    if (typeof event.costUsd === "number") total += event.costUsd;
  }
  return total;
}

/** turn_end minus turn_start in whole milliseconds. */
export function latencyMs(events: readonly AnyTurnEvent[]): number | undefined {
  const start = events.find((e) => e.type === "turn_start");
  const end = events.find((e) => e.type === "turn_end");
  if (!start || !end) return undefined;
  const delta = Date.parse(end.timestamp) - Date.parse(start.timestamp);
  return Number.isFinite(delta) ? delta : undefined;
}
