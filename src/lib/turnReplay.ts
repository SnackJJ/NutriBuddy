// Turn replay: what `GET /api/turns/:id/events` answers (RFC 0008 §5).
//
// Three outcomes are part of the contract, and the client depends on the
// difference between the last two:
//   * no session                      → 401
//   * the turn row is not the caller's → 404 ("this is not your turn")
//   * the caller's turn, nothing after `since` → 200 with an empty body
//     ("nothing new yet" — the turn may still be running)
//
// The decisions live here rather than in the route so they can be tested without
// a database, a session or Next.js.

import type { AnyTurnEvent } from "@/harness/turn";
import type { TraceStore } from "@/harness/traceStore";

/** Route frames and turn events are framed the same way (§5). */
export function encodeNdjson(frames: readonly unknown[]): string {
  return frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
}

/** `turns.id` is a uuid; anything else cannot be a turn we could return. */
const TURN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTurnId(value: string): boolean {
  return TURN_ID_PATTERN.test(value);
}

export type SinceParam =
  | { readonly ok: true; readonly sinceSeq?: number }
  | { readonly ok: false };

/**
 * `since` is the client's lastSeq. Absent means "from the beginning" — and that
 * is deliberately not the same as `since=0`, which means "after seq 0" and would
 * skip `turn_start`, the event the page needs for the user's own message.
 *
 * A malformed value is rejected rather than defaulted: treating garbage as 0
 * would silently replay a whole turn.
 */
export function parseSinceParam(value: string | null): SinceParam {
  if (value === null || value.trim() === "") return { ok: true };
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? { ok: true, sinceSeq: parsed } : { ok: false };
}

export type ReplayOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "events"; readonly events: readonly AnyTurnEvent[] };

/**
 * Read one turn's events for the store's own user.
 *
 * The visibility check comes first because `listByTurn` cannot answer it: RLS
 * makes someone else's turn look exactly like a turn with no new events.
 */
export async function loadTurnReplay(
  store: TraceStore,
  turnId: string,
  sinceSeq?: number,
): Promise<ReplayOutcome> {
  const turn = await store.findTurn(turnId);
  if (!turn) return { kind: "not_found" };

  const events = await store.listByTurn(turnId, sinceSeq);
  return { kind: "events", events };
}

/** The two event types that end a turn: the seam's own, and the route's frame. */
export function isTerminalEvent(type: string): boolean {
  return type === "turn_end" || type === "terminal";
}

/** Anything a replay can carry, as far as the fold below cares. */
export interface ReplayEvent {
  readonly type: string;
  readonly seq?: number;
  readonly timestamp?: string;
  /** Tagged turn input; only the utterance shape carries a user message. */
  readonly input?: {
    readonly tag?: string;
    readonly content?: string;
    readonly [key: string]: unknown;
  };
}

export interface ReplayedTurnFold {
  /** The user's own message, taken from `turn_start.input` (§5). */
  readonly userText?: string;
  /** When the turn started, which dates how long it can still be running. */
  readonly startedAtMs?: number;
  readonly sawTerminal: boolean;
  /** Highest seq delivered, so the next poll asks only for what is new. */
  readonly lastSeq?: number;
}

/**
 * Fold a replayed stream into the four facts a resuming page needs.
 *
 * Pure so that the rules which decide whether an interrupted turn comes back —
 * including "the first replay may already contain the terminal event" — are
 * testable without a browser.
 */
export function foldReplayedTurn(
  events: readonly ReplayEvent[],
): ReplayedTurnFold {
  let userText: string | undefined;
  let startedAtMs: number | undefined;
  let lastSeq: number | undefined;
  let sawTerminal = false;

  for (const event of events) {
    if (event.type === "turn_start") {
      const input = event.input;
      if (input?.tag === "utterance" && typeof input.content === "string") {
        userText = input.content;
      }
      const parsed = event.timestamp ? Date.parse(event.timestamp) : NaN;
      if (Number.isFinite(parsed)) startedAtMs = parsed;
    }

    if (typeof event.seq === "number") {
      lastSeq = lastSeq === undefined ? event.seq : Math.max(lastSeq, event.seq);
    }

    if (isTerminalEvent(event.type)) sawTerminal = true;
  }

  return { userText, startedAtMs, sawTerminal, lastSeq };
}
