// Daily usage for the quota gate, aggregated from the `turns` table (#98 /
// RFC 0010 §3.3).
//
// The counting source is the trace table S1 already writes (migration 0011),
// filtered by `(user_id, started_at)` — the exact shape of
// `turns_user_time_idx`, so the read is an index range scan and not a table
// scan. No counting table exists and none is added: a second aggregate is a
// second source of truth, and the two would disagree the first time a trace
// write was lost.
//
// What "a turn" means here is "a row in `turns`", which is why a refused request
// is invisible to this reader: the gate runs before the turn row is created, so
// a refusal cannot feed the counter that produced it (RFC 0010 §5).
//
// A deliberate under-count, matching §3.3's acceptance of overshoot: a turn that
// is still running has no `finished_at`, and the RPC fills `cost_usd` only on
// `turn_end` (0011), so an in-flight turn counts as one turn and zero dollars.
// Reading `turn_events` to price unfinished turns would be a second cost
// aggregation in TypeScript, which RFC 0008 §3.4 forbids.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailyUsage } from "./quota";

/**
 * Rows asked for per request. PostgREST caps a response at the project's
 * `max_rows` — 1000 in `supabase/config.toml`, and lower is possible — so the
 * reader pages by what it *received* rather than by what it asked for. A short
 * page is therefore not evidence of the end: with a server cap below this number
 * every page would be short, and stopping there would under-count cost, which is
 * the budget §9.2 makes binding.
 */
const COST_PAGE_SIZE = 1000;

/**
 * Page ceiling. A day beyond this many turns is far past any quota, and the
 * reader refuses rather than reporting a partial sum: the gate treats an
 * unreadable count as unanswerable (fail closed), and a silently low number is
 * the one outcome worse than a 503.
 */
const MAX_PAGES = 100;

export class DailyUsageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyUsageReadError";
  }
}

export interface DailyUsageReader {
  /** Usage of the UTC day that starts at `dayStart`. */
  readDailyUsage(userId: string, dayStart: Date): Promise<DailyUsage>;
}

/** `numeric` columns arrive as strings through PostgREST; NULL means unpriced. */
function toCostUsd(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Build the reader over a Supabase client. The caller passes the
 * session-scoped client (issue #62 / ADD §Multi-User): the read is one user's
 * rows and RLS already says the same thing, so the service role would be a
 * wider door than the query needs.
 */
export function createSupabaseDailyUsageReader(
  client: SupabaseClient,
): DailyUsageReader {
  return {
    async readDailyUsage(userId: string, dayStart: Date): Promise<DailyUsage> {
      const since = dayStart.toISOString();
      let counted: number | undefined;
      let read = 0;
      let costUsd = 0;
      let complete = false;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        // `count: "exact"` rides along with the cost page so the turn count is
        // the database's number, not the number of rows this loop happened to
        // read.
        const { data, error, count } = await client
          .from("turns")
          .select("cost_usd", { count: "exact" })
          .eq("user_id", userId)
          .gte("started_at", since)
          // `started_at` is not unique, so `id` breaks ties: without a total
          // order a ranged page can repeat or skip a row.
          .order("started_at", { ascending: true })
          .order("id", { ascending: true })
          .range(read, read + COST_PAGE_SIZE - 1);

        if (error) {
          throw new DailyUsageReadError(`readDailyUsage: ${describe(error)}`);
        }

        const rows = data ?? [];
        if (typeof count === "number") {
          counted = count;
        }
        for (const row of rows) {
          costUsd += toCostUsd((row as { cost_usd?: unknown }).cost_usd);
        }
        read += rows.length;

        // Done when the range came back empty, or when the total the database
        // reported has been read. There is no "short page" exit on purpose: see
        // COST_PAGE_SIZE.
        if (rows.length === 0 || (counted !== undefined && read >= counted)) {
          complete = true;
          break;
        }
      }

      if (!complete) {
        throw new DailyUsageReadError(
          `readDailyUsage: still reading after ${MAX_PAGES} pages (${read} rows) — refusing to report a partial sum`,
        );
      }

      return { turns: counted ?? read, costUsd };
    },
  };
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return error instanceof Error ? error.message : String(error);
}
