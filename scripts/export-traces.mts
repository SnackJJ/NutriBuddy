/**
 * Trace export — the minimum query surface (S1 / #91 / RFC 0008 §T9, §3.8).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/export-traces.mts --turn <turnId>
 *   npx tsx --env-file=.env.local scripts/export-traces.mts --user <userId> --date 2026-09-13
 *   npx tsx --env-file=.env.local scripts/export-traces.mts --user <userId> --limit 20
 *
 * Options:
 *   --turn <uuid>        export one turn by id (no --user needed)
 *   --user <uuid>        export this account's turns; needs --date, or exports
 *                        the newest --limit turns
 *   --date YYYY-MM-DD    one UTC day (half-open), the date the turn started
 *   --limit N            cap on turns (default 50); the newest N are kept
 *   --out <dir>          also write <name>.md and <name>.json there
 *   --json               print JSON instead of the markdown summary
 *   --with-text          keep free text (meals, drugs, symptoms) — LOCAL
 *                        DEBUGGING ONLY; the default export withholds it
 *   --help
 *
 * Reads with the service role: it names the account to export, which is exactly
 * what RLS withholds from a user-facing client. It writes nothing.
 *
 * Exit codes: 0 ok, 1 bad usage or no such turn, 2 missing configuration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  collectExportedTurns,
  createSupabaseTraceExportSource,
  pseudonymizeUserId,
  renderExportedJson,
  renderExportedMarkdown,
  utcDayWindow,
  TurnNotFoundError,
  type RenderOptions,
  type TraceExportQuery,
} from "../src/harness/traceExport";
import { isLocalTarget, loadEnvLocal, requireEnv } from "./lib/env";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;

const USAGE = `usage:
  export-traces --turn <turnId> [--out <dir>] [--json] [--with-text]
  export-traces --user <userId> --date YYYY-MM-DD [--limit N] [...]
  export-traces --user <userId> [--limit N] [...]

See the header of scripts/export-traces.mts for what each flag means.`;

interface Args {
  readonly turn?: string;
  readonly user?: string;
  readonly date?: string;
  readonly limit: number;
  readonly out?: string;
  readonly json: boolean;
  readonly withText: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  let turn: string | undefined;
  let user: string | undefined;
  let date: string | undefined;
  let out: string | undefined;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let withText = false;

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
      case "--turn":
        turn = value();
        break;
      case "--user":
        user = value();
        break;
      case "--date":
        date = value();
        break;
      case "--out":
        out = value();
        break;
      case "--limit": {
        const raw = value();
        limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new UsageError(`--limit must be a positive integer, got "${raw}"`);
        }
        break;
      }
      case "--json":
        json = true;
        break;
      case "--with-text":
        withText = true;
        break;
      case "--help":
      case "-h":
        throw new UsageError("requested help");
      default:
        throw new UsageError(`unknown argument "${flag}"`);
    }
  }

  if (!turn && !user) throw new UsageError("needs --turn or --user");
  if (turn && user) throw new UsageError("--turn and --user are mutually exclusive");
  if (date && !user) throw new UsageError("--date needs --user");

  return { turn, user, date, limit, out, json, withText };
}

/**
 * Which turns the run covers. A user with no date means "the newest limit
 * turns"; the window then starts at the epoch, which is a bound nobody has to
 * remember rather than a second query shape.
 */
function toQuery(args: Args, now: Date): TraceExportQuery {
  if (args.turn) return { kind: "turn", turnId: args.turn };
  const window = args.date
    ? utcDayWindow(args.date)
    : { since: new Date(0).toISOString(), until: new Date(now.getTime() + DAY_MS).toISOString() };
  return { kind: "range", userId: args.user as string, limit: args.limit, ...window };
}

function outputName(args: Args, userId: string | undefined): string {
  if (args.turn) return args.turn;
  const who = pseudonymizeUserId(userId as string);
  return args.date ? `turns-${args.date}-${who}` : `turns-recent-${who}`;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`export-traces: ${message}`);
    console.error(USAGE);
    // Asking for help is not an error, even though it travels the same path.
    return message === "requested help" ? 0 : 1;
  }

  const env = loadEnvLocal();
  let url: string;
  let serviceRoleKey: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  } catch (err) {
    console.error(`export-traces: ${(err as Error).message}`);
    console.error("  set it in .env.local or export it before running");
    return 2;
  }

  if (args.withText && !isLocalTarget(url)) {
    console.error(
      `export-traces: warning — --with-text against ${url} writes meals and drugs to disk unredacted`,
    );
  }

  const now = new Date();
  const query = toQuery(args, now);
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const source = createSupabaseTraceExportSource(client);

  let turns;
  try {
    turns = await collectExportedTurns(source, query, {
      withText: args.withText,
    });
  } catch (err) {
    if (err instanceof TurnNotFoundError) {
      console.error(`export-traces: no turn ${err.turnId} (wrong id, or never persisted)`);
      return 1;
    }
    console.error(`export-traces: ${(err as Error).message}`);
    return 1;
  }

  const options: RenderOptions = {
    exportedAt: now.toISOString(),
    source: url,
    withText: args.withText,
  };

  // A full page is indistinguishable from a complete window unless it is said
  // out loud, and "this user has 50 turns" is a wrong conclusion to hand a
  // reader silently.
  if (query.kind === "range" && turns.length === query.limit) {
    console.error(
      `export-traces: warning — stopped at --limit ${query.limit}; older turns in this window were not exported`,
    );
  }

  if (args.out) {
    const name = outputName(args, args.user);
    mkdirSync(args.out, { recursive: true });
    const markdownPath = join(args.out, `${name}.md`);
    const jsonPath = join(args.out, `${name}.json`);
    writeFileSync(markdownPath, renderExportedMarkdown(turns, options), "utf8");
    writeFileSync(jsonPath, renderExportedJson(turns, options), "utf8");
    console.log(`${turns.length} turn(s) → ${markdownPath}`);
    console.log(`${turns.length} turn(s) → ${jsonPath}`);
    return 0;
  }

  process.stdout.write(
    args.json
      ? renderExportedJson(turns, options)
      : renderExportedMarkdown(turns, options),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`export-traces: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
