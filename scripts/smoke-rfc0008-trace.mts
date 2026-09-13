/**
 * Live Supabase smoke for the trace authorization surface (S1 / #124 / D9).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/smoke-rfc0008-trace.mts
 *
 * What it proves, with real JWTs against a real database — the two things no
 * fake client can show:
 *   * RFC 0008 §3.3 "the subject cannot rewrite its own audit": a user cannot
 *     insert into `turn_events` (no grant at all) and cannot call
 *     `append_turn_event` (EXECUTE revoked from PUBLIC), while the service role
 *     can do both.
 *   * D9 "cross-account reads are impossible": another user's JWT selects zero
 *     rows and finds no turn, even holding the turnId.
 *
 * Exact error codes are asserted on purpose. `PGRST202` ("could not find the
 * function") means PostgREST's schema cache is stale, not that authorization
 * worked, and must fail this script rather than pass it (0011 static review,
 * fix 5).
 *
 * It creates two temporary users, writes one scripted turn for the first, and
 * deletes both users again — including on failure, so a red run does not leave
 * accounts behind.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { turn } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import { SupabaseTraceStore } from "../src/harness/supabaseTraceStore";
import type { ModelAdapter } from "../src/harness/types";

/**
 * Environment values, with the process environment taking precedence.
 *
 * The other smoke script lets `.env.local` win, which is fine when that file
 * points at the project you mean. Here it matters more: this script creates and
 * deletes test accounts, and a `.env.local` aimed at production would silently
 * turn a local run into one against real users. Passing variables explicitly
 * therefore selects the target.
 */
function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      if (env[k]) continue;
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      env[k] = v;
    }
  } catch {
    // process.env only
  }
  return env;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

let failures = 0;

/**
 * A denied write, with the door that denied it named.
 *
 * Postgres reports both "you have no privilege on this table" and "a row-level
 * security policy rejected this row" as 42501, so an assertion that only checks
 * the code cannot tell the two apart — and would pass even if the grant this
 * migration revoked had been put back. The message is what discriminates.
 */
function deniedWith(
  error: { code?: string; message?: string } | null,
  pattern: RegExp,
): { ok: boolean; detail: string } {
  if (!error) return { ok: false, detail: "the write unexpectedly succeeded" };
  const detail = `code=${error.code ?? "-"} message=${error.message ?? "-"}`;
  return { ok: error.code === "42501" && pattern.test(error.message ?? ""), detail };
}

const NO_TABLE_PRIVILEGE = /permission denied for (table|relation)/i;
const NO_FUNCTION_PRIVILEGE = /permission denied for function/i;

function check(step: string, ok: boolean, detail: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step} — ${detail}`);
  if (!ok) failures += 1;
}

const env = loadEnvLocal();
const url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
const anonKey = requireEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
const serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");

/**
 * This script creates and deletes accounts, so a hosted target has to be asked
 * for explicitly — the accident it prevents is a `.env.local` aimed at the real
 * project turning a local run into one against production.
 */
const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost)([:\/]|$)/.test(url);
if (!isLocalTarget && env.SMOKE_ALLOW_REMOTE !== "1") {
  console.log(`
refusing to run against ${url}

This script creates and deletes two auth accounts. Set SMOKE_ALLOW_REMOTE=1 to
target a hosted project on purpose (for example to check D9 in production).
`);
  process.exit(2);
}

/** Where a value came from, because a mixed-source environment is how a run ends
 *  up pointed at the wrong project. */
function sourceOf(key: string): string {
  return process.env[key] ? "environment" : ".env.local";
}

console.log(
  `target: ${url} (NEXT_PUBLIC_SUPABASE_URL from ${sourceOf("NEXT_PUBLIC_SUPABASE_URL")}, ` +
    `SERVICE_ROLE_KEY from ${sourceOf("SUPABASE_SERVICE_ROLE_KEY")})\n`,
);

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A signed-in user, plus a client carrying only their JWT — what the app has. */
interface TempUser {
  readonly id: string;
  readonly client: SupabaseClient;
}

const createdUserIds: string[] = [];

async function makeUser(label: string): Promise<TempUser> {
  const email = `trace-smoke-${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Smoke-${randomUUID().slice(0, 12)}aA1!`;

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`could not create ${label}: ${created.error?.message}`);
  }
  createdUserIds.push(created.data.user.id);

  const signedIn = await createClient(url, anonKey).auth.signInWithPassword({
    email,
    password,
  });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`could not sign in ${label}: ${signedIn.error?.message}`);
  }

  return {
    id: created.data.user.id,
    client: createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` },
      },
    }),
  };
}

/** Writes one scripted turn through the real seam, as the server does. */
async function writeTurn(userId: string, turnId: string): Promise<number> {
  const store = new SupabaseTraceStore({
    client: admin,
    userId,
    turnId,
    log: (message, detail) => console.error(`[trace] ${message}`, detail),
  });

  const adapter: ModelAdapter = {
    generate: async () => ({
      content: "Chicken breast has 31g protein per 100g.",
      stop: true,
    }),
  };

  const generator = turn(
    { tag: "utterance", content: "how much protein in chicken breast?" },
    { adapter, tracer: new Tracer(), trace: store },
  );

  let count = 0;
  let next = await generator.next();
  while (!next.done) {
    count += 1;
    next = await generator.next();
  }

  if (store.persistFailed) {
    throw new Error("the service role could not persist the turn");
  }
  return count;
}

async function countRows(
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(column, value);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

try {
  // ── preflight: the trace surface has to exist ────────────────────────
  const { error: probeError } = await admin
    .from("turn_events")
    .select("turn_id", { head: true, count: "exact" })
    .limit(1);
  if (probeError) {
    const staleCache = probeError.code === "PGRST205" || /schema cache/i.test(probeError.message);
    console.log(
      staleCache
        ? `
BLOCKED: PostgREST cannot see the trace tables (${probeError.code}).

Its schema cache is stale — the tables exist in the database. Reload it:

  psql "$LOCAL_DB_URL" -c "notify pgrst, 'reload schema'"

…or restart the stack. scripts/verify-migrations.sh does this after a reset.
`
        : `
BLOCKED: the trace tables are not reachable (${probeError.code ?? "-"} ${probeError.message}).

If this project is missing the migrations, apply them the way the repository
builds them (never by pasting SQL into the Dashboard):

  supabase link --project-ref <ref>
  supabase db push

Otherwise check the target URL and the service-role key above — the script is
talking to a project whose API rejected it.

Local replay check: bash scripts/verify-migrations.sh
`,
    );
    process.exit(2);
  }

  // The RPC, not just the table: a random unknown turn proves the function is
  // reachable *and* that its ordering guard runs, without writing anything. A
  // fixed probe id could collide with a fixture and actually insert a row.
  const rpcProbe = await admin.rpc("append_turn_event", {
    p_turn_id: randomUUID(),
    p_user_id: randomUUID(),
    p_event: {
      schema: "probe",
      seq: 1,
      timestamp: new Date().toISOString(),
      type: "step",
    },
  });
  if (rpcProbe.error?.code === "PGRST202") {
    console.log(`
BLOCKED: append_turn_event is missing from PostgREST's schema cache (PGRST202).

That means the cache is stale, not that authorization works — the assertions
below would then fail for the wrong reason. Reload it:

  psql "$LOCAL_DB_URL" -c "notify pgrst, 'reload schema'"

…or restart the stack. scripts/verify-migrations.sh does this after a reset.
`);
    process.exit(2);
  }
  // Anything else is not an environment problem but a finding: the service role
  // is the writer this whole design depends on, and the probe depends on grants
  // the assertions below do not.
  check(
    "service_role can reach append_turn_event (unknown turn → 23503)",
    rpcProbe.error?.code === "23503",
    rpcProbe.error
      ? `code=${rpcProbe.error.code ?? "-"} message=${rpcProbe.error.message}`
      : "the probe unexpectedly succeeded",
  );

  const owner = await makeUser("owner");
  const stranger = await makeUser("stranger");
  const turnId = randomUUID();

  // ── the writer of record: service role ───────────────────────────────
  const eventCount = await writeTurn(owner.id, turnId);
  check(
    "service_role writes the turn",
    eventCount > 0,
    `${eventCount} events persisted for turn ${turnId}`,
  );

  const ownerEvents = await owner.client
    .from("turn_events")
    .select("seq")
    .eq("turn_id", turnId);
  check(
    "owner reads their own events through RLS",
    ownerEvents.error === null && (ownerEvents.data?.length ?? 0) === eventCount,
    ownerEvents.error
      ? ownerEvents.error.message
      : `${ownerEvents.data?.length ?? 0} rows`,
  );

  // ── D9: another account cannot see it, even holding the turnId ────────
  const strangerEvents = await stranger.client
    .from("turn_events")
    .select("seq")
    .eq("turn_id", turnId);
  check(
    "stranger reads zero rows",
    strangerEvents.error === null && (strangerEvents.data?.length ?? 0) === 0,
    strangerEvents.error
      ? strangerEvents.error.message
      : `${strangerEvents.data?.length ?? 0} rows`,
  );

  const ownerTurn = await owner.client
    .from("turns")
    .select("id")
    .eq("id", turnId)
    .maybeSingle();
  check(
    "owner can see their own turn row",
    ownerTurn.error === null && ownerTurn.data !== null,
    ownerTurn.error ? ownerTurn.error.message : "row visible",
  );

  const strangerTurn = await stranger.client
    .from("turns")
    .select("id")
    .eq("id", turnId)
    .maybeSingle();
  check(
    "stranger cannot even see the turn row",
    strangerTurn.error === null && strangerTurn.data === null,
    strangerTurn.error ? strangerTurn.error.message : "no row",
  );

  // ── §3.3: the subject cannot rewrite its own audit ────────────────────
  const forged = await stranger.client.from("turn_events").insert({
    turn_id: turnId,
    user_id: stranger.id,
    seq: 999,
    schema_version: "forged",
    type: "step",
    payload: {},
  });
  const forgedVerdict = deniedWith(forged.error, NO_TABLE_PRIVILEGE);
  check(
    "stranger cannot insert an event (table privilege, before RLS)",
    forgedVerdict.ok,
    forgedVerdict.detail,
  );

  const ownerForged = await owner.client.from("turn_events").insert({
    turn_id: turnId,
    user_id: owner.id,
    seq: 999,
    schema_version: "forged",
    type: "step",
    payload: {},
  });
  const ownerForgedVerdict = deniedWith(ownerForged.error, NO_TABLE_PRIVILEGE);
  check(
    "owner cannot insert into their own trace either",
    ownerForgedVerdict.ok,
    ownerForgedVerdict.detail,
  );

  const rpcAsStranger = await stranger.client.rpc("append_turn_event", {
    p_turn_id: turnId,
    p_user_id: stranger.id,
    p_event: {},
  });
  const rpcAsStrangerVerdict = deniedWith(
    rpcAsStranger.error,
    NO_FUNCTION_PRIVILEGE,
  );
  check(
    "stranger cannot call append_turn_event (EXECUTE revoked from PUBLIC)",
    rpcAsStrangerVerdict.ok,
    rpcAsStrangerVerdict.detail,
  );

  const rpcAsOwner = await owner.client.rpc("append_turn_event", {
    p_turn_id: turnId,
    p_user_id: owner.id,
    p_event: {},
  });
  const rpcAsOwnerVerdict = deniedWith(rpcAsOwner.error, NO_FUNCTION_PRIVILEGE);
  check(
    "owner cannot call append_turn_event either",
    rpcAsOwnerVerdict.ok,
    rpcAsOwnerVerdict.detail,
  );
} catch (err) {
  // A throw here is a failed run, not a crash to read a stack trace from.
  failures += 1;
  console.log(
    `[FAIL] the run did not complete — ${err instanceof Error ? err.message : String(err)}`,
  );
} finally {
  // ── cleanup, and proof that it cleaned up ────────────────────────────
  // Counted before deleting, so the cascade assertion below cannot pass on a
  // turn that was never written.
  const traceRowsBefore = new Map<string, number>();
  for (const id of createdUserIds) {
    traceRowsBefore.set(
      id,
      (await countRows("turns", "user_id", id)) +
        (await countRows("turn_events", "user_id", id)),
    );
  }

  for (const id of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      failures += 1;
      console.log(
        `[FAIL] could not delete temp user ${id} — ${error.message} (delete it by hand)`,
      );
    }
  }

  for (const id of createdUserIds) {
    const before = traceRowsBefore.get(id) ?? 0;
    const after =
      (await countRows("turns", "user_id", id)) +
      (await countRows("turn_events", "user_id", id));

    // Only the owner has a turn, so only the owner can prove the cascade; the
    // stranger's zero would be zero either way.
    if (before > 0) {
      check(
        "deleting the user took the trace with it (0011 cascade)",
        after === 0,
        `${before} rows before, ${after} after`,
      );
    }

    // Leak check only: the pre-0011 tables have no cascade to auth.users yet
    // (migration 0015 owns that, #121), and these users never wrote to them, so
    // this cannot fail today and says nothing about 0015.
    const legacyRows =
      (await countRows("user_profile", "user_id", id)) +
      (await countRows("meal_logs", "user_id", id)) +
      (await countRows("proposals", "user_id", id));
    check(
      "[leak check] no rows in the pre-0011 tables",
      legacyRows === 0,
      `${legacyRows} rows left for ${id}`,
    );
  }
}

console.log(
  failures === 0
    ? "\nOK: the trace surface is write-only for the service role and invisible across accounts."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
