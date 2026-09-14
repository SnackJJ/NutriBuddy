// SupabaseTraceStore — the server-side TraceStore (S1 / #88 / RFC 0008 §3.7).
//
// Every write is one `append_turn_event` RPC call: the migration turns
// turn_start into "insert the turn row", turn_end into "finalize it", and both
// happen in the same statement, so no state exists where an event is stored but
// the turn still looks like it is running (§3.4).
//
// What this file owns and nothing else does:
//   * the per-write timeout — supabase-js's fetch has none, so a half-dead
//     database would hang until the function limit (§3.7);
//   * the failure classification, **by code class rather than an enumerated
//     list** (0011 static review, suggestion 7): the RPC raises 23503 / 22P02 /
//     42501 / 23514 today and 22007 / 23502 tomorrow, and a newly added code
//     must not silently fall into "retry";
//   * the single retry, which is safe because the RPC is idempotent on
//     `(turn_id, seq)`.
//
// It deliberately does not classify anything for the in-memory store: that
// would be a second source of truth for the same contract (#90).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyTurnEvent } from "./turn";
import {
  TraceStoreError,
  type TraceStore,
  type TurnMeta,
  type TurnSummary,
} from "./traceStore";

const APPEND_RPC = "append_turn_event";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Server-side structured log line — RFC 0008 §3.6 calls this the only reliable
 * channel once the database is the thing that is broken. Required rather than
 * defaulted: a silent default would let a lost write go unrecorded, and the
 * harness itself stays free of console output.
 */
export type TraceLog = (
  message: string,
  detail: Readonly<Record<string, unknown>>,
) => void;

export interface SupabaseTraceStoreOptions {
  readonly client: SupabaseClient;
  /** Bound once, like the session user the RPC writes: the store is user-bound (§3.2). */
  readonly userId: string;
  readonly turnId: string;
  /** Metadata the event stream does not carry — the RPC's `p_meta` (§3.4). */
  readonly meta?: TurnMeta;
  readonly timeoutMs?: number;
  readonly log: TraceLog;
}

/** One write attempt's outcome, before any retry decision. */
type WriteOutcome =
  | { readonly kind: "stored" }
  /**
   * The row is already there. Only reachable if a first attempt committed and
   * its response was lost — which is exactly what "success" means here (§3.7).
   */
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "failed";
      /** SQLSTATE from Postgres, or the class this store assigns to transport faults. */
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * SQLSTATE class 08 — connection failure. Used for faults that never reached
 * Postgres (DNS, TLS, refused socket), which §3.7 groups with the network case.
 */
const CONNECTION_FAILURE = "08006";
/** SQLSTATE for a canceled statement — the client-side write budget expiring. */
const STATEMENT_TIMEOUT = "57014";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return textOf(value) ?? "unknown trace write failure";
}

/**
 * Classify a failed attempt.
 *
 * Two things drive this, and neither is an enumerated list of codes:
 *   * an absent SQLSTATE means the failure never reached Postgres — a proxy, a
 *     gateway, a dead socket, or our own write budget expiring. That is the
 *     transport class §3.7 retries once.
 *   * a present but unrecognized SQLSTATE is not retried: retrying a state
 *     nobody has seen is how a bad write becomes a loop.
 *
 * Note where the inputs come from: postgrest-js *resolves* a `rpc()` call even
 * when the request never completed (it reports `{ error: { code: "" },
 * status: 0 }`), so the status has to be read off the response and a timeout is
 * recognised from the abort signal rather than from a thrown `TimeoutError`.
 */
function classifyFailure(input: {
  readonly error?: unknown;
  readonly status?: number;
  /** The write budget expired (or the caller aborted) during this attempt. */
  readonly timedOut?: boolean;
}): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  const record = asRecord(input.error);
  const code = textOf(record?.code);
  const message = textOf(record?.message) ?? describe(input.error);

  if (code !== undefined) {
    // A SQLSTATE is authoritative: the database answered, so a signal that
    // happens to be aborted by now must not relabel a real integrity error as a
    // retryable timeout.
    if (code === "23505") return { code, message, retryable: false };
    if (code.startsWith("08") || code === STATEMENT_TIMEOUT) {
      return { code, message, retryable: true };
    }
    if (
      code.startsWith("22") ||
      code.startsWith("23") ||
      code.startsWith("42")
    ) {
      return { code, message, retryable: false };
    }
    // A code outside every class above is normally "stop", but a gateway status
    // still means the request may never have reached Postgres — the shape
    // PostgREST's own PGRST001/PGRST002 take when its pooler cannot reach the
    // database, which is exactly the wake-up window §3.7 names. That is the
    // 5xx class the RFC retries.
    if (input.status === 502 || input.status === 503 || input.status === 504) {
      return { code, message, retryable: true };
    }
    return { code, message, retryable: false };
  }

  // No SQLSTATE at all: our write budget expired, or the request never reached
  // PostgREST (proxy, DNS, TLS).
  if (input.timedOut) {
    return { code: STATEMENT_TIMEOUT, message, retryable: true };
  }
  if (input.status === 502 || input.status === 503 || input.status === 504) {
    return { code: String(input.status), message, retryable: true };
  }
  return { code: CONNECTION_FAILURE, message, retryable: true };
}

/**
 * `p_meta` is read by the RPC with camelCase keys (`p_meta->>'appVersion'`),
 * which is also the shape `InMemoryTraceStore` binds. Sending snake_case here
 * would leave every `turns.app_version` null without failing anything.
 */
function metaPayload(meta: TurnMeta | undefined): Record<string, string> {
  const payload: Record<string, string> = {};
  if (meta?.appVersion) payload.appVersion = meta.appVersion;
  if (meta?.sourceVersion) payload.sourceVersion = meta.sourceVersion;
  if (meta?.skillId) payload.skillId = meta.skillId;
  if (meta?.skillVersion) payload.skillVersion = meta.skillVersion;
  return payload;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Exported because the operator export path (#91) reads the same rows: two
 * copies of the column list would drift silently, and a missing column shows up
 * as `undefined` rather than as an error.
 */
export const TURN_COLUMNS =
  "id, user_id, input_kind, schema_version, started_at, app_version, finished_at, stop_reason, steps, cost_usd, latency_ms";

export function toTurnSummary(row: Record<string, unknown>): TurnSummary {
  return {
    turnId: String(row.id),
    userId: String(row.user_id),
    inputKind: String(row.input_kind),
    schemaVersion: String(row.schema_version),
    startedAt: String(row.started_at),
    appVersion: textOf(row.app_version),
    finishedAt: textOf(row.finished_at),
    stopReason: textOf(row.stop_reason),
    steps: numeric(row.steps),
    costUsd: numeric(row.cost_usd),
    latencyMs: numeric(row.latency_ms),
  };
}

export class SupabaseTraceStore implements TraceStore {
  readonly turnId: string;

  private readonly client: SupabaseClient;
  private readonly userId: string;
  private readonly meta: TurnMeta | undefined;
  private readonly timeoutMs: number;
  private readonly log: TraceLog;
  private failed = false;

  constructor(options: SupabaseTraceStoreOptions) {
    this.client = options.client;
    this.userId = options.userId;
    this.turnId = options.turnId;
    this.meta = options.meta;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log;
  }

  get persistFailed(): boolean {
    return this.failed;
  }

  async append(event: AnyTurnEvent): Promise<void> {
    const first = await this.write(event);
    if (first.kind !== "failed") return;

    if (!first.retryable) {
      this.giveUp(event.seq, first);
      throw new TraceStoreError(
        first.code,
        `append: ${first.message} (seq ${event.seq})`,
      );
    }

    this.log("trace write failed; retrying once", {
      turnId: this.turnId,
      seq: event.seq,
      code: first.code,
      message: first.message,
    });

    const second = await this.write(event);
    if (second.kind !== "failed") return;

    this.giveUp(event.seq, second);
    throw new TraceStoreError(
      second.code,
      `append: ${second.message} (seq ${event.seq}, after retry)`,
    );
  }

  /**
   * A lost event is the one thing the client cannot see in the stream, so it is
   * also the one thing that must always be logged (§3.6 ①).
   */
  private giveUp(
    seq: number,
    failure: { readonly code: string; readonly message: string },
  ): void {
    this.failed = true;
    this.log("trace write given up; the event is not in the database", {
      turnId: this.turnId,
      seq,
      code: failure.code,
      message: failure.message,
    });
  }

  private async write(event: AnyTurnEvent): Promise<WriteOutcome> {
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: { readonly error?: unknown; readonly status?: number };
    try {
      response = await this.client
        .rpc(APPEND_RPC, {
          p_turn_id: this.turnId,
          p_user_id: this.userId,
          p_event: event,
          p_meta: metaPayload(this.meta),
        })
        .abortSignal(signal);
    } catch (err) {
      // postgrest-js resolves a failed fetch into `{ error: { code: "" } }`
      // instead of rejecting, so this is the belt for a client with a custom
      // fetch. The write may or may not have committed, which is why the retry
      // is idempotent rather than skipped.
      return {
        kind: "failed",
        ...classifyFailure({ error: { message: describe(err) }, timedOut: signal.aborted }),
      };
    }

    if (!response.error) return { kind: "stored" };

    const classified = classifyFailure({
      error: response.error,
      status: response.status,
      timedOut: signal.aborted,
    });
    if (classified.code === "23505") return { kind: "duplicate" };
    return { kind: "failed", ...classified };
  }

  async listByTurn(turnId: string, sinceSeq?: number): Promise<AnyTurnEvent[]> {
    // `user_id` is filtered explicitly as well as by RLS: the store is
    // user-bound, and the service-role client used for writes bypasses RLS.
    let query = this.client
      .from("turn_events")
      .select("payload")
      .eq("user_id", this.userId)
      .eq("turn_id", turnId);
    if (sinceSeq !== undefined) query = query.gt("seq", sinceSeq);

    const { data, error } = await query.order("seq", { ascending: true });
    if (error) throw this.readError(error, "listByTurn");

    return (data ?? []).map(
      (row: { readonly payload: unknown }) => row.payload as AnyTurnEvent,
    );
  }

  async listTurns(limit: number): Promise<TurnSummary[]> {
    const { data, error } = await this.client
      .from("turns")
      .select(TURN_COLUMNS)
      .eq("user_id", this.userId)
      .order("started_at", { ascending: false })
      .limit(Math.max(0, limit));
    if (error) throw this.readError(error, "listTurns");

    return (data ?? []).map((row: Record<string, unknown>) =>
      toTurnSummary(row),
    );
  }

  async findTurn(turnId: string): Promise<TurnSummary | undefined> {
    const { data, error } = await this.client
      .from("turns")
      .select(TURN_COLUMNS)
      // `user_id` again as well as RLS: a read through the service role (export
      // scripts, #91) must not be able to see another user's turn either.
      .eq("user_id", this.userId)
      .eq("id", turnId)
      .maybeSingle();
    if (error) throw this.readError(error, "findTurn");

    return data ? toTurnSummary(data as Record<string, unknown>) : undefined;
  }

  private readError(error: unknown, operation: string): TraceStoreError {
    const classified = classifyFailure({ error });
    return new TraceStoreError(
      classified.code,
      `${operation}: ${classified.message}`,
    );
  }
}

export function createSupabaseTraceStore(
  options: SupabaseTraceStoreOptions,
): SupabaseTraceStore {
  return new SupabaseTraceStore(options);
}
