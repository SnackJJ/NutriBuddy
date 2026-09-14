// Trace retention — the 90-day rolling delete (S1 / #122 / RFC 0008 §3.8).
//
// The decision this implements is not "clean up eventually": traces are a
// full-fidelity record of meals and medication, so "keep everything forever" is
// a default nobody chose. §3.8 fixes it at 90 days, deleted by `turns.started_at`
// with `turn_events` following the foreign key.
//
// Two shapes matter and both are here rather than in the script:
//   * planning is pure and takes the clock as an argument, so "the cutoff is 90
//     days before now" is testable without a database and without waiting;
//   * applying is a separate call, so the default path can report what it would
//     delete and change nothing.
//
// `started_at`, not `finished_at`: a row whose terminal write was lost has no
// `finished_at` and would otherwise be immortal.

import type { SupabaseClient } from "@supabase/supabase-js";
import { TraceStoreError } from "./traceStore";

/** RFC 0008 §3.8. Changing this number is changing the privacy decision. */
export const DEFAULT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrunableTurn {
  readonly turnId: string;
  readonly startedAt: string;
}

export interface TracePruneSource {
  /**
   * Turns started before `cutoff`, oldest first, at most `limit`. Oldest-first
   * because a backlog is cleared in the order it accumulated, and because a
   * capped batch should be the batch that has waited longest.
   */
  listTurnsStartedBefore(
    cutoff: string,
    limit: number,
  ): Promise<PrunableTurn[]>;
  /** Delete these turns; returns how many `turns` rows went away (`turn_events` cascade). */
  deleteTurns(turnIds: readonly string[]): Promise<number>;
}

/** Everything older than `retentionDays` before `now`, as an ISO instant. */
export function pruneCutoff(now: Date, retentionDays = DEFAULT_RETENTION_DAYS): string {
  return new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
}

export interface PrunePlan {
  readonly cutoff: string;
  readonly retentionDays: number;
  readonly turns: readonly PrunableTurn[];
  /** Oldest `started_at` in the batch — the answer to "how far back does this go". */
  readonly oldest?: string;
  readonly newest?: string;
}

export interface PrunePlanOptions {
  readonly now: Date;
  readonly retentionDays?: number;
  /** Cap on rows inspected in one round. */
  readonly batchSize: number;
}

/**
 * A batch full to `batchSize` is not evidence of more rows, so it is not
 * reported as if it were: the caller loops until a plan comes back empty.
 */
export async function planPrune(
  source: TracePruneSource,
  options: PrunePlanOptions,
): Promise<PrunePlan> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = pruneCutoff(options.now, retentionDays);
  const turns = await source.listTurnsStartedBefore(cutoff, options.batchSize);
  return {
    cutoff,
    retentionDays,
    turns,
    oldest: turns[0]?.startedAt,
    newest: turns.at(-1)?.startedAt,
  };
}

export interface PruneResult {
  readonly cutoff: string;
  readonly retentionDays: number;
  readonly dryRun: boolean;
  /** Turns the plan covered — what a dry run prints. */
  readonly planned: number;
  /** Rows actually removed; 0 for a dry run. */
  readonly deleted: number;
  /** Why the loop stopped: `done`, `no-progress` or `round-limit`. */
  readonly stop: PruneStop;
}

/**
 * `no-progress` is the round that planned rows and removed none. It cannot come
 * from "nothing was old enough" — that is `done` — so it means the delete is not
 * doing what the read sees (a policy, a grant, a trigger), and continuing would
 * only loop on it.
 */
export type PruneStop = "done" | "no-progress" | "round-limit";

/**
 * Apply a plan in rounds until nothing is left older than the cutoff.
 *
 * Round-by-round rather than one giant `IN (...)`: the id list goes into a URL,
 * and a first run against a year of accumulated traces would otherwise build a
 * request that PostgREST rejects — after having deleted nothing.
 */
export async function applyPrune(
  source: TracePruneSource,
  options: PrunePlanOptions & { readonly maxRounds?: number },
): Promise<PruneResult> {
  const maxRounds = options.maxRounds ?? 1000;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  let planned = 0;
  let deleted = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const plan = await planPrune(source, options);
    if (plan.turns.length === 0) {
      return {
        cutoff: plan.cutoff,
        retentionDays,
        dryRun: false,
        planned,
        deleted,
        stop: "done",
      };
    }

    planned += plan.turns.length;
    const removed = await source.deleteTurns(plan.turns.map((turn) => turn.turnId));
    deleted += removed;
    if (removed === 0) {
      return {
        cutoff: plan.cutoff,
        retentionDays,
        dryRun: false,
        planned,
        deleted,
        stop: "no-progress",
      };
    }
  }

  return {
    cutoff: pruneCutoff(options.now, retentionDays),
    retentionDays,
    dryRun: false,
    planned,
    deleted,
    stop: "round-limit",
  };
}

// ── reading and deleting ───────────────────────────────────────────────────

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
 * Supabase-backed prune source. Service role: it deletes rows belonging to
 * accounts that are not the caller's, which is what RLS withholds on purpose.
 */
export function createSupabaseTracePruneSource(
  client: SupabaseClient,
): TracePruneSource {
  return {
    async listTurnsStartedBefore(cutoff, limit) {
      const { data, error } = await client
        .from("turns")
        .select("id, started_at")
        .lt("started_at", cutoff)
        .order("started_at", { ascending: true })
        .limit(Math.max(0, limit));
      if (error) throw readError(error, "listTurnsStartedBefore");
      return (data ?? []).map((row: Record<string, unknown>) => ({
        turnId: String(row.id),
        startedAt: String(row.started_at),
      }));
    },

    async deleteTurns(turnIds) {
      if (turnIds.length === 0) return 0;
      // `.select("id")` is what makes the count real: a delete with no returned
      // rows cannot distinguish "removed 40" from "removed nothing".
      const { data, error } = await client
        .from("turns")
        .delete()
        .in("id", [...turnIds])
        .select("id");
      if (error) throw readError(error, "deleteTurns");
      return (data ?? []).length;
    },
  };
}
