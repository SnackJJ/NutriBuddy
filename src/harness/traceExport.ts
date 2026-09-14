// Trace export — the minimum query surface over persisted traces (S1 / #91 /
// RFC 0008 §T9, §3.8).
//
// Why this is not SupabaseTraceStore: the runtime store is deliberately
// user-bound and turn-bound (§3.2) so the request path cannot name a turn that
// is not the session user's, and its `listTurns(limit)` has no date range. An
// operator export needs to name the subject and a window. It reads with the
// service role, which is exactly why it lives in an operator tool and never on
// the request path — the store's binding is a guarantee, and loosening it for
// convenience would trade that guarantee for one caller.
//
// Redaction (§3.8 makes "exports are desensitized" a decision, not a wish):
//   * identity — user ids become deterministic `u_<sha256 prefix>` pseudonyms,
//     so the same person stays followable across turns without the export
//     carrying an auth user id;
//   * free text — a string field named content/feedback/reply/message/text/
//     prompt/utterance/evidence becomes `{redacted:"text",chars,sha256}`. The
//     hash keeps "was this the same sentence" answerable and the length keeps a
//     sanity signal, while the words themselves — meals, drugs, symptoms — do
//     not leave the database.
// Everything else is kept on purpose: gate verdicts, check names, reason codes,
// model usage, timings, catalog ids and numbers are code-generated facts, and
// they are what answers "why was this turn blocked". `withText` is the explicit
// opt-out for local debugging and is never the default.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnyTurnEvent, GateCheckpoint, GateVerdict } from "./turn";
import { TraceStoreError, type TurnSummary } from "./traceStore";
import { TURN_COLUMNS, toTurnSummary } from "./supabaseTraceStore";

/**
 * Field names carrying free text, matched at any depth.
 *
 * A key-name rule rather than a path list, and applied to anything not
 * recognised as a structured field: the failure mode of a path list is a
 * newly-added text field quietly shipping unredacted, which is the one mistake
 * this module exists to prevent.
 */
const FREE_TEXT_KEYS = new Set([
  "content",
  "feedback",
  "reply",
  "message",
  "text",
  "prompt",
  "utterance",
  "evidence",
]);

/** Identity fields, in the two spellings that appear in payloads and rows. */
const IDENTITY_KEYS = new Set(["user_id", "userId"]);

export interface RedactionOptions {
  /** Keep free text as-is — the full-fidelity form, for local debugging only. */
  readonly withText?: boolean;
}

export interface RedactionMarker {
  readonly redacted: "text";
  readonly chars: number;
  readonly sha256: string;
}

/** Prefix marking a value that is a pseudonym rather than an identifier. */
export const PSEUDONYM_PREFIX = "u_";

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Stable pseudonym for a user id. Deterministic on purpose: an operator reading
 * two exports has to be able to tell "same account" from "another account", and
 * a per-export salt would destroy exactly that. A v4 uuid cannot be recovered
 * from a 48-bit prefix.
 */
export function pseudonymizeUserId(userId: string): string {
  return `${PSEUDONYM_PREFIX}${digest(userId, 12)}`;
}

export function textMarker(text: string): RedactionMarker {
  return { redacted: "text", chars: text.length, sha256: digest(text, 8) };
}

export function isRedactionMarker(value: unknown): value is RedactionMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { redacted?: unknown }).redacted === "text"
  );
}

/**
 * Redact one JSON value (event, event array, or anything shaped like them).
 *
 * `undefined` and non-object leaves pass through untouched: the export has to
 * stay a faithful JSON rendering of what is stored, minus identity and text.
 */
export function redactTraceValue(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactTraceValue(entry, options));
  }
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && IDENTITY_KEYS.has(key)) {
      out[key] = pseudonymizeUserId(entry);
      continue;
    }
    if (!options.withText && typeof entry === "string" && FREE_TEXT_KEYS.has(key)) {
      out[key] = textMarker(entry);
      continue;
    }
    out[key] = redactTraceValue(entry, options);
  }
  return out;
}

/**
 * How a turn ended, as a headline a reader can act on. `unfinished` is not
 * "still running": a turn with no `turn_end` event is also what a lost write
 * looks like, and the export cannot tell the two apart.
 */
export type TurnStatus = "blocked" | "crashed" | "unfinished" | "finished";

export interface ExportedGate {
  readonly seq: number;
  readonly timestamp: string;
  readonly checkpoint: GateCheckpoint;
  readonly verdict: GateVerdict;
  readonly checkName: string;
  readonly reasonCode?: string;
  /** String, or a redaction marker when free text is withheld. */
  readonly evidence: unknown;
}

export interface ExportedTimelineRow {
  readonly seq: number;
  readonly type: string;
  readonly timestamp: string;
  readonly detail: string;
}

export interface ExportedTurn {
  readonly turnId: string;
  /** Pseudonym, never the raw user id. */
  readonly user: string;
  readonly inputKind: string;
  readonly schemaVersion: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly appVersion?: string;
  readonly stopReason?: string;
  readonly steps?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly status: TurnStatus;
  /** One line answering "why did this turn end this way". */
  readonly why: string;
  readonly gates: readonly ExportedGate[];
  readonly timeline: readonly ExportedTimelineRow[];
  /** The redacted events, in seq order — the replayable part of the export. */
  readonly events: readonly unknown[];
}

function gateFrom(event: Extract<AnyTurnEvent, { type: "gate_verdict" }>, options: RedactionOptions): ExportedGate {
  return {
    seq: event.seq,
    timestamp: event.timestamp,
    checkpoint: event.checkpoint,
    verdict: event.verdict,
    checkName: event.checkName,
    reasonCode: event.reasonCode,
    evidence: options.withText ? event.evidence : textMarker(event.evidence),
  };
}

/** One-line gist per event type: the timeline is for scanning, not for replay. */
function timelineDetail(event: AnyTurnEvent, options: RedactionOptions): string {
  switch (event.type) {
    case "turn_start": {
      const input = event.input;
      if (input.tag !== "utterance") return `input=${input.tag}`;
      const text = options.withText
        ? `"${input.content}"`
        : `<text ${input.content.length} chars>`;
      return `input=utterance ${text}`;
    }
    case "step": {
      const agentEvent = event.agentEvent;
      if (agentEvent.type === "act") {
        return `act ${agentEvent.toolCall?.name ?? "(unnamed tool)"}`;
      }
      const content = agentEvent.content ?? "";
      const text = options.withText ? content : `<text ${content.length} chars>`;
      return `${agentEvent.type} ${text}`;
    }
    case "gate_verdict":
      return `${event.checkpoint} ${event.verdict} ${event.checkName}`;
    case "model_call": {
      const cost = event.costUsd === undefined ? "-" : `$${event.costUsd}`;
      return `model=${event.model} latency=${event.latencyMs ?? "-"}ms cost=${cost}`;
    }
    case "turn_end":
      return `stopReason=${event.result.stopReason} steps=${event.result.steps}`;
  }
}

/**
 * Build the exportable view of one turn.
 *
 * `events` is authoritative for gates and terminal detail; `turn` supplies the
 * row-level numbers, which the RPC aggregates in SQL (§3.4) and which therefore
 * must not be recomputed here.
 */
export function buildExportedTurn(
  turn: TurnSummary,
  events: readonly AnyTurnEvent[],
  options: RedactionOptions = {},
): ExportedTurn {
  const gates = events
    .filter(
      (event): event is Extract<AnyTurnEvent, { type: "gate_verdict" }> =>
        event.type === "gate_verdict",
    )
    .map((event) => gateFrom(event, options));

  const terminal = events.find(
    (event): event is Extract<AnyTurnEvent, { type: "turn_end" }> =>
      event.type === "turn_end",
  );

  const nonPassing = gates.filter((gate) => gate.verdict !== "pass");
  const first = nonPassing[0];

  const status: TurnStatus =
    terminal === undefined
      ? "unfinished"
      : turn.stopReason === "crash"
        ? "crashed"
        : nonPassing.length > 0 || turn.stopReason === "gate_blocked"
          ? "blocked"
          : "finished";

  let why: string;
  if (status === "unfinished") {
    why =
      "no turn_end event: the turn is still running, or its terminal write was lost";
  } else if (status === "crashed") {
    why = `stopReason=crash after ${terminal?.result.steps ?? "-"} step(s)`;
  } else if (first !== undefined) {
    const more = nonPassing.length > 1 ? `, +${nonPassing.length - 1} more` : "";
    why = `${first.checkpoint} gate ${first.verdict} at seq ${first.seq} (checkName=${first.checkName}${
      first.reasonCode ? `, reasonCode=${first.reasonCode}` : ""
    }${more})`;
  } else if (turn.stopReason === "gate_blocked") {
    // Worth stating plainly: the terminal says a gate blocked the turn and no
    // blocking verdict was recorded, which is a trace-integrity finding rather
    // than a gate outcome.
    why = "stopReason=gate_blocked, but no non-passing gate_verdict was recorded";
  } else {
    why = `stopReason=${turn.stopReason ?? "-"} steps=${turn.steps ?? "-"}`;
  }

  return {
    turnId: turn.turnId,
    user: pseudonymizeUserId(turn.userId),
    inputKind: turn.inputKind,
    schemaVersion: turn.schemaVersion,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
    appVersion: turn.appVersion,
    stopReason: turn.stopReason,
    steps: turn.steps,
    costUsd: turn.costUsd,
    latencyMs: turn.latencyMs,
    status,
    why,
    gates,
    timeline: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      timestamp: event.timestamp,
      detail: timelineDetail(event, options),
    })),
    events: events.map((event) => redactTraceValue(event, options)),
  };
}

// ── reading ────────────────────────────────────────────────────────────────

export interface TurnRangeQuery {
  readonly userId: string;
  /** Inclusive lower bound (ISO). */
  readonly since: string;
  /** Exclusive upper bound (ISO). */
  readonly until: string;
  /**
   * Cap on how many turns come back. The **newest** `limit` turns in the window
   * are returned, ordered oldest-first: an operator looking at a day wants the
   * day, and one scanning a user's history wants the recent end, never the
   * oldest `limit` rows.
   */
  readonly limit: number;
}

/**
 * The reads the export needs, which the runtime port deliberately does not
 * offer: a turn by id regardless of owner, a user's turns in a time window, and
 * that turn's events.
 */
export interface TraceExportSource {
  findTurn(turnId: string): Promise<TurnSummary | undefined>;
  listTurnsInRange(query: TurnRangeQuery): Promise<TurnSummary[]>;
  listByTurn(turnId: string): Promise<AnyTurnEvent[]>;
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

/**
 * Supabase-backed export source. Needs a **service-role** client: it reads rows
 * belonging to whichever user the operator names, which is precisely what RLS
 * withholds from a user-facing client.
 */
export function createSupabaseTraceExportSource(
  client: SupabaseClient,
): TraceExportSource {
  return {
    async findTurn(turnId) {
      const { data, error } = await client
        .from("turns")
        .select(TURN_COLUMNS)
        .eq("id", turnId)
        .maybeSingle();
      if (error) throw readError(error, "findTurn");
      return data ? toTurnSummary(data as Record<string, unknown>) : undefined;
    },

    async listTurnsInRange({ userId, since, until, limit }) {
      // Descending + limit, reversed before returning: Postgres applies LIMIT
      // after ORDER BY, so ascending would truncate to the *oldest* rows.
      const { data, error } = await client
        .from("turns")
        .select(TURN_COLUMNS)
        .eq("user_id", userId)
        .gte("started_at", since)
        .lt("started_at", until)
        .order("started_at", { ascending: false })
        .limit(Math.max(0, limit));
      if (error) throw readError(error, "listTurnsInRange");
      return (data ?? [])
        .map((row: Record<string, unknown>) => toTurnSummary(row))
        .reverse();
    },

    async listByTurn(turnId) {
      const { data, error } = await client
        .from("turn_events")
        .select("payload")
        .eq("turn_id", turnId)
        .order("seq", { ascending: true });
      if (error) throw readError(error, "listByTurn");
      return (data ?? []).map(
        (row: { readonly payload: unknown }) => row.payload as AnyTurnEvent,
      );
    },
  };
}

/** Half-open UTC day window — the only place the date filter is defined. */
export function utcDayWindow(date: string): { since: string; until: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  }
  const since = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`date is not a real calendar day: "${date}"`);
  }
  return {
    since: since.toISOString(),
    until: new Date(since.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export type TraceExportQuery =
  | { readonly kind: "turn"; readonly turnId: string }
  | ({ readonly kind: "range" } & TurnRangeQuery);

export class TurnNotFoundError extends Error {
  readonly turnId: string;

  constructor(turnId: string) {
    super(`no turn ${turnId}`);
    this.name = "TurnNotFoundError";
    this.turnId = turnId;
  }
}

/**
 * Read and shape the export. Sequential by design: this runs against the
 * database an operator is inspecting, and a burst of parallel reads buys
 * nothing a human waiting on a command line can perceive.
 */
export async function collectExportedTurns(
  source: TraceExportSource,
  query: TraceExportQuery,
  options: RedactionOptions = {},
): Promise<ExportedTurn[]> {
  let turns: TurnSummary[];
  if (query.kind === "turn") {
    const found = await source.findTurn(query.turnId);
    if (!found) throw new TurnNotFoundError(query.turnId);
    turns = [found];
  } else {
    turns = await source.listTurnsInRange({
      userId: query.userId,
      since: query.since,
      until: query.until,
      limit: query.limit,
    });
  }

  const exported: ExportedTurn[] = [];
  for (const turn of turns) {
    const events = await source.listByTurn(turn.turnId);
    exported.push(buildExportedTurn(turn, events, options));
  }
  return exported;
}

// ── rendering ──────────────────────────────────────────────────────────────

export interface RenderOptions extends RedactionOptions {
  readonly exportedAt: string;
  readonly source: string;
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string") return value;
  return String(value);
}

function inline(value: unknown): string {
  if (isRedactionMarker(value)) {
    return `<text ${value.chars} chars, sha256 ${value.sha256}>`;
  }
  if (typeof value === "string") {
    return `\`${value.replace(/\|/g, "\\|").replace(/\n/g, " ")}\``;
  }
  return `\`${JSON.stringify(value)}\``;
}

/**
 * The human-readable half of the export: headline first (what happened, why),
 * then the gates, then the timeline. If a reader stops after ten lines they
 * should still know whether the turn was blocked and which check blocked it.
 */
export function renderExportedMarkdown(
  turns: readonly ExportedTurn[],
  options: RenderOptions,
): string {
  const lines: string[] = [
    "# Trace export",
    "",
    `- exported at: ${options.exportedAt}`,
    `- source: ${options.source}`,
    `- redaction: ${
      options.withText
        ? "**off** (--with-text: free text included — local debugging only)"
        : "free text withheld, user ids pseudonymized"
    }`,
    `- turns: ${turns.length}`,
    "",
  ];

  if (turns.length === 0) {
    lines.push("_No turns matched._", "");
    return lines.join("\n");
  }

  for (const turn of turns) {
    lines.push(`## \`${turn.turnId}\` — ${turn.status.toUpperCase()}`, "");
    lines.push("| field | value |", "| --- | --- |");
    lines.push(`| user | \`${turn.user}\` |`);
    lines.push(`| input | ${turn.inputKind} |`);
    lines.push(`| started | ${turn.startedAt} |`);
    lines.push(`| finished | ${scalar(turn.finishedAt)} |`);
    lines.push(`| latency | ${scalar(turn.latencyMs)} ms |`);
    lines.push(`| steps | ${scalar(turn.steps)} |`);
    lines.push(
      `| cost | ${turn.costUsd === undefined ? "-" : `$${turn.costUsd}`} |`,
    );
    lines.push(`| stopReason | ${scalar(turn.stopReason)} |`);
    lines.push(`| app version | ${scalar(turn.appVersion)} |`);
    lines.push("", `why: ${turn.why}`, "");

    lines.push("### gates", "");
    if (turn.gates.length === 0) {
      lines.push("_No gate_verdict events._", "");
    } else {
      lines.push(
        "| seq | checkpoint | verdict | checkName | reasonCode | evidence |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      for (const gate of turn.gates) {
        lines.push(
          `| ${gate.seq} | ${gate.checkpoint} | ${gate.verdict} | \`${gate.checkName}\` | ${
            gate.reasonCode ? `\`${gate.reasonCode}\`` : "-"
          } | ${inline(gate.evidence)} |`,
        );
      }
      lines.push("");
    }

    lines.push("### timeline", "");
    lines.push("| seq | type | detail |", "| --- | --- | --- |");
    for (const row of turn.timeline) {
      lines.push(`| ${row.seq} | ${row.type} | ${inline(row.detail)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderExportedJson(
  turns: readonly ExportedTurn[],
  options: RenderOptions,
): string {
  return `${JSON.stringify(
    {
      exportedAt: options.exportedAt,
      source: options.source,
      redaction: options.withText ? "none" : "text-withheld",
      turns,
    },
    null,
    2,
  )}\n`;
}
