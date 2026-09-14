/**
 * Trace retention — delete turns older than 90 days (S1 / #122 / RFC 0008 §3.8).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/prune-traces.mts            # dry run
 *   npx tsx --env-file=.env.local scripts/prune-traces.mts --apply    # delete
 *
 * Options:
 *   --days N     retention window (default 90 — the number §3.8 decides)
 *   --batch N    rows planned per round (default 500)
 *   --apply      perform the delete; without it nothing is written
 *   --help
 *
 * Cadence: run monthly, by hand. No pg_cron on purpose (§3.8) — a scheduled job
 * inside the database is one more thing that can silently stop, and a monthly
 * command whose absence is noticed is a cheaper failure.
 *
 * `turn_events` follows `turns` through the foreign key (`on delete cascade`),
 * so this deletes one table. `started_at` is the key: a turn whose terminal
 * write was lost has no `finished_at` and would otherwise never expire.
 *
 * Exit codes: 0 ok, 1 the delete did not do what the read saw, 2 missing config.
 */

import { createClient } from "@supabase/supabase-js";
import {
  applyPrune,
  createSupabaseTracePruneSource,
  DEFAULT_RETENTION_DAYS,
  planPrune,
} from "../src/harness/tracePrune";
import { loadEnvLocal, requireEnv } from "./lib/env";

const USAGE = `usage:
  prune-traces [--days N] [--batch N] [--apply]

Without --apply it reports what would go and changes nothing.`;

interface Args {
  readonly days: number;
  readonly batch: number;
  readonly apply: boolean;
}

class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  let days = DEFAULT_RETENTION_DAYS;
  let batch = 500;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${flag} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (flag) {
      case "--days":
        days = positiveInt(flag, value());
        break;
      case "--batch":
        batch = positiveInt(flag, value());
        break;
      case "--apply":
        apply = true;
        break;
      case "--help":
      case "-h":
        throw new UsageError("requested help");
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }

  return { days, batch, apply };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`prune-traces: ${message}`);
    console.error(USAGE);
    return message === "requested help" ? 0 : 1;
  }

  const env = loadEnvLocal();
  let url: string;
  let serviceRoleKey: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  } catch (err) {
    console.error(`prune-traces: ${(err as Error).message}`);
    console.error("  set it in .env.local or export it before running");
    return 2;
  }

  if (args.days < DEFAULT_RETENTION_DAYS) {
    console.error(
      `prune-traces: warning — ${args.days} days is shorter than the documented retention (${DEFAULT_RETENTION_DAYS}, RFC 0008 §3.8)`,
    );
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const source = createSupabaseTracePruneSource(client);
  const now = new Date();

  console.log(`target: ${url}`);
  console.log(`cutoff: ${args.days} days before ${now.toISOString()}`);

  try {
    if (!args.apply) {
      const plan = await planPrune(source, {
        now,
        retentionDays: args.days,
        batchSize: args.batch,
      });
      console.log(`would delete: ${plan.turns.length} turn(s)`);
      if (plan.oldest) {
        console.log(`  oldest: ${plan.oldest}`);
        console.log(`  newest: ${plan.newest}`);
      }
      if (plan.turns.length === args.batch) {
        console.log(
          `  (a full batch of ${args.batch} — there may be more; raise --batch to see the total)`,
        );
      }
      console.log("dry run: nothing was deleted. Re-run with --apply.");
      return 0;
    }

    const result = await applyPrune(source, {
      now,
      retentionDays: args.days,
      batchSize: args.batch,
    });
    console.log(
      `deleted: ${result.deleted} turn(s) (planned ${result.planned}; turn_events followed the foreign key)`,
    );

    if (result.stop === "no-progress") {
      console.error(
        "prune-traces: a batch was planned but nothing was deleted — check grants on public.turns",
      );
      return 1;
    }
    if (result.stop === "round-limit") {
      console.error(
        "prune-traces: stopped at the round limit with rows still older than the cutoff — re-run to continue",
      );
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`prune-traces: ${(err as Error).message}`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`prune-traces: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
