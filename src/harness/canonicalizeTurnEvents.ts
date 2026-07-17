// Canonicalizer for schema-versioned turn event streams (RFC 0001 Appendix A).
//
// Produces a JSON-stable structure for golden snapshots: timestamps and cost
// noise are neutralized; proposal/tool-call ids are bijectively rewritten so
// cross-event lineage assertions survive normalization.

import type { AnyTurnEvent } from "./turn";

const TS_PLACEHOLDER = "<ts>";

/** Structured keys whose string values participate in id bijection. */
const ID_KEYS = new Set([
  "proposalId",
  "proposal_id",
  "tool_call_id",
  // Nested tool call id on agentEvent.toolCall / toolCalls entries.
  // Handled when key === "id" under a tool-call-shaped parent (see walk).
]);

const TIME_KEYS = new Set([
  "timestamp",
  "createdAt",
  "created_at",
  "loggedAt",
  "logged_at",
]);

const STRIP_OR_ZERO_KEYS = new Set(["latencyMs", "costUsd"]);

export type CanonicalTurnEvent = unknown;

/**
 * Canonicalize a turn event stream for golden comparison.
 *
 * - `timestamp` / known time fields → `"<ts>"`
 * - `latencyMs` / `costUsd` → `0`
 * - proposal / tool-call ids → `"<id:N>"` first-seen bijection within the stream
 * - catalog food ids are left intact (fixture ground truth)
 */
export function canonicalizeTurnEvents(
  events: readonly AnyTurnEvent[],
): CanonicalTurnEvent[] {
  const idMap = new Map<string, string>();

  const allocate = (raw: string): string => {
    const existing = idMap.get(raw);
    if (existing !== undefined) {
      return existing;
    }
    const placeholder = `<id:${idMap.size}>`;
    idMap.set(raw, placeholder);
    return placeholder;
  };

  // Pass 1: discover ids in first-seen order (structured fields only).
  for (const event of events) {
    collectIds(event as unknown, allocate, undefined);
  }

  // Pass 2: rewrite.
  return events.map((event) => rewrite(event as unknown, idMap, undefined));
}

/**
 * Extract the commit-gate subsequence used for K5/K6/K7 shape equality.
 * Compares checkpoint + verdict + checkName only (no free-text evidence).
 */
export function commitGateShape(
  events: readonly AnyTurnEvent[],
): readonly {
  readonly checkpoint: string;
  readonly verdict: string;
  readonly checkName: string;
}[] {
  return events
    .filter(
      (e): e is Extract<AnyTurnEvent, { type: "gate_verdict" }> =>
        e.type === "gate_verdict" && e.checkpoint === "commit",
    )
    .map((e) => ({
      checkpoint: e.checkpoint,
      verdict: e.verdict,
      checkName: e.checkName,
    }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallParent(parentKey: string | undefined): boolean {
  return (
    parentKey === "toolCall" ||
    parentKey === "toolCalls" ||
    parentKey === "tool_calls"
  );
}

function collectIds(
  value: unknown,
  allocate: (raw: string) => string,
  parentKey: string | undefined,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectIds(item, allocate, parentKey);
    }
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (ID_KEYS.has(key)) {
        allocate(child);
      } else if (key === "id" && isToolCallParent(parentKey)) {
        allocate(child);
      }
    }
    collectIds(child, allocate, key);
  }
}

function rewrite(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
  parentKey: string | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, idMap, parentKey));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (STRIP_OR_ZERO_KEYS.has(key)) {
      out[key] = 0;
      continue;
    }

    if (typeof child === "string") {
      if (TIME_KEYS.has(key)) {
        out[key] = TS_PLACEHOLDER;
        continue;
      }

      if (ID_KEYS.has(key) || (key === "id" && isToolCallParent(parentKey))) {
        out[key] = idMap.get(child) ?? child;
        continue;
      }

      if (key === "evidence") {
        out[key] = rewriteEvidence(child, idMap);
        continue;
      }

      out[key] = child;
      continue;
    }

    out[key] = rewrite(child, idMap, key);
  }

  return out;
}

/** Rewrite known raw ids inside evidence using the bijection (longest-first). */
function rewriteEvidence(
  evidence: string,
  idMap: ReadonlyMap<string, string>,
): string {
  if (idMap.size === 0) {
    return evidence;
  }

  const pairs = [...idMap.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = evidence;
  for (const [raw, placeholder] of pairs) {
    if (raw.length === 0) {
      continue;
    }
    result = result.split(raw).join(placeholder);
  }
  return result;
}
