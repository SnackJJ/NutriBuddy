// TraceStore — the persistence port for the authoritative turn event stream
// (S1 / RFC 0008 §3.2).
//
// Why a port and not route-level wiring: `seq` is allocated inside the turn
// generator (turn.ts createEventMetadata), and the terminal event must carry a
// legal seq, so the only place that can persist the stream in order is inside
// turn() — it appends before each yield. The store binds its turnId at
// construction, so the port method takes only the event.
//
// The three methods are deliberately narrow:
//   append       — turn_start creates the turn row, turn_end finalizes it, and
//                  both happen inside one write (RFC 0008 §3.4), so no state
//                  exists where a turn_end event is stored but the turn still
//                  looks like it is running.
//   listByTurn   — replay by seq, used by GET /api/turns/:id/events
//   listTurns    — recent turns for one user (export scripts; no UI in S1)

import type { AnyTurnEvent } from "./turn";

/**
 * Turn-level metadata that is NOT carried by the event stream, so it has to be
 * bound by the caller (the RPC's `p_meta` parameter, RFC 0008 §3.4).
 */
export interface TurnMeta {
  readonly appVersion?: string;
  readonly sourceVersion?: string;
  readonly skillId?: string;
  readonly skillVersion?: string;
}

/** A `turns` row, as far as readers care (RFC 0008 §4). */
export interface TurnSummary {
  readonly turnId: string;
  readonly userId: string;
  readonly inputKind: string;
  readonly schemaVersion: string;
  readonly startedAt: string;
  /** Null until #114 starts stamping releases; the RPC takes it from `p_meta`. */
  readonly appVersion?: string;
  readonly finishedAt?: string;
  readonly stopReason?: string;
  readonly steps?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
}

/**
 * Error codes a TraceStore may surface. They mirror the Postgres codes the
 * Supabase implementation reads out of PostgREST so both implementations (and
 * the tests that drive them) can agree on how a failure is classified
 * (RFC 0008 §3.7).
 */
export type TraceErrorCode =
  /** Unknown turn — an assembly/ordering bug. Do not retry. */
  | "23503"
  /** Missing/invalid payload shape. Do not retry. */
  | "22P02"
  /** Permission denied. Do not retry. */
  | "42501"
  /**
   * Integrity conflict: a turn_start that belongs to another user, or a seq
   * already stored with different bytes. Not retryable — retrying cannot make
   * either go away.
   */
  | "23514";

export class TraceStoreError extends Error {
  readonly code: TraceErrorCode;

  constructor(code: TraceErrorCode, message: string) {
    super(message);
    this.name = "TraceStoreError";
    this.code = code;
  }
}

export interface TraceStore {
  /** Bound at construction; turn() never holds it. */
  readonly turnId: string;
  /** turn_start creates the row, turn_end finalizes it, everything else appends. */
  append(event: AnyTurnEvent): Promise<void>;
  listByTurn(turnId: string, sinceSeq?: number): Promise<AnyTurnEvent[]>;
  /**
   * Recent turns for the store's own user — the store is user-bound, so the
   * caller cannot ask for someone else's turns (RLS is the same rule at the
   * database).
   */
  listTurns(limit: number): Promise<TurnSummary[]>;
}
