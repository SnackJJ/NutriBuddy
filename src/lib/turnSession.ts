// The client's memory of an unfinished turn (RFC 0008 §5).
//
// A refresh mid-turn must not lose the answer: the server keeps producing it
// (§3.5), so the page only has to remember *which* turn it was watching and how
// far it got. `turnId + lastSeq` live in sessionStorage — per tab, because two
// tabs are two conversations, and in session, because a closed tab has no
// in-flight turn to resume.
//
// The state is written once when the route's `turn_meta` frame arrives and
// cleared when a terminal event lands, so anything found here on mount means a
// turn was interrupted.

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Key under which the in-flight turn is remembered. */
export const PENDING_TURN_KEY = "nutribuddy.pendingTurn";

export interface PendingTurn {
  readonly turnId: string;
  /**
   * Highest seq the page has already rendered, or undefined when the turn was
   * interrupted before its first event. Undefined means "replay everything",
   * which is also what delivers `turn_start.input` for the user's own message.
   */
  readonly lastSeq?: number;
}

function isPendingTurn(value: unknown): value is PendingTurn {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { turnId?: unknown; lastSeq?: unknown };
  if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) {
    return false;
  }
  return (
    candidate.lastSeq === undefined ||
    (typeof candidate.lastSeq === "number" &&
      Number.isInteger(candidate.lastSeq) &&
      candidate.lastSeq >= 0)
  );
}

/**
 * Storage access is wrapped because it can throw (`SecurityError` when a browser
 * blocks site data). Bookkeeping is a side channel: it must never be able to
 * fail a turn the server is already producing.
 */
function safeGet(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: KeyValueStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage unavailable or full: the turn continues, only resumability is lost.
  }
}

function safeRemove(storage: KeyValueStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // As above.
  }
}

/**
 * The interrupted turn, if any. Anything unreadable is treated as absent rather
 * than repaired: a corrupt entry cannot tell us which turn to resume, and
 * guessing would replay a stranger's id.
 */
export function readPendingTurn(
  storage: KeyValueStorage,
): PendingTurn | undefined {
  const raw = safeGet(storage, PENDING_TURN_KEY);
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingTurn(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Called when the route's `turn_meta` frame arrives (before the first event). */
export function beginTurn(storage: KeyValueStorage, turnId: string): void {
  safeSet(storage, PENDING_TURN_KEY, JSON.stringify({ turnId }));
}

/**
 * Called for every event that carries a seq. Monotonic on purpose: a replay can
 * interleave with live events after a reconnect, and the page must never move
 * its own high-water mark backwards.
 *
 * The turnId is checked rather than assumed: a late event from a turn the page
 * has already moved past must not resurrect its entry.
 */
export function recordEventSeq(
  storage: KeyValueStorage,
  turnId: string,
  seq: number,
): void {
  if (!Number.isInteger(seq) || seq < 0) return;
  const pending = readPendingTurn(storage);
  if (!pending || pending.turnId !== turnId) return;
  if (pending.lastSeq !== undefined && pending.lastSeq >= seq) return;

  safeSet(
    storage,
    PENDING_TURN_KEY,
    JSON.stringify({ turnId: pending.turnId, lastSeq: seq }),
  );
}

/** Called when the turn reaches a terminal event: there is nothing to resume. */
export function completeTurn(storage: KeyValueStorage): void {
  safeRemove(storage, PENDING_TURN_KEY);
}

/**
 * `GET /api/turns/:id/events` — without `since` the replay starts at the
 * beginning, which is what a freshly mounted page needs: a reloaded page has no
 * earlier events, and `turn_start` is among them. `since` is for the polls that
 * follow, so a still-running turn is not re-read from scratch every second.
 */
export function replayUrl(turnId: string, sinceSeq?: number): string {
  const base = `/api/turns/${encodeURIComponent(turnId)}/events`;
  return sinceSeq === undefined ? base : `${base}?since=${sinceSeq}`;
}
