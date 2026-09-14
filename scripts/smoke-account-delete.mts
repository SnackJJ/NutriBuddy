/**
 * Live check for account deletion (S5 / #121).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/smoke-account-delete.mts
 *
 * What it proves, and why it is written this way: the issue's DoD explicitly
 * forbids verifying with the deleted user's JWT, because that would pass whether
 * or not the rows survived. So the verification is a **service-role** count of the
 * five account-scoped tables after the deletion, plus a count of the shared corpus
 * tables before and after — the corpus is not the user's data and must be
 * untouched.
 *
 * It creates one temporary account, writes a row into each legacy table and a turn
 * into the trace tables, deletes the account through the same function the endpoint
 * uses, and reports what is left.
 *
 * Exit codes: 0 all clean, 1 something survived, 2 configuration missing.
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ACCOUNT_SCOPED_TABLES, SHARED_TABLES, deleteAccount } from "../src/lib/account";
import { SCHEMA_VERSION } from "../src/harness/turn";
import { SupabaseTraceStore } from "../src/harness/supabaseTraceStore";
import { isLocalTarget, loadEnvLocal, requireEnv } from "./lib/env";

let failures = 0;

function check(step: string, ok: boolean, detail: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step} — ${detail}`);
  if (!ok) failures += 1;
}

async function main(): Promise<number> {
  const env = loadEnvLocal();
  let url: string;
  let serviceKey: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    serviceKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  } catch (err) {
    console.error(`smoke-account-delete: ${(err as Error).message}`);
    return 2;
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== account deletion smoke (RFC 0007 §4 / #121) ===");
  console.log(`target: ${url}${isLocalTarget(url) ? " (local stack)" : ""}`);

  // Deletion is irreversible and creates an account; a hosted target has to be
  // asked for deliberately, as in the other smokes.
  if (!isLocalTarget(url) && env.SMOKE_ALLOW_REMOTE !== "1") {
    console.log(`
refusing to run against ${url}

This script creates and deletes an auth account. Set SMOKE_ALLOW_REMOTE=1 to
target a hosted project on purpose.
`);
    return 2;
  }

  const email = `delete-smoke-${randomUUID().slice(0, 8)}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: `Smoke-${randomUUID().slice(0, 12)}aA1!`,
    email_confirm: true,
  });
  if (createError || !created.user) {
    console.error(`createUser failed: ${createError?.message ?? "no user"}`);
    return 1;
  }
  const userId = created.user.id;
  console.log(`temp user: ${userId}\n`);

  // One row per legacy table — the three that had no foreign key until 0016.
  const { error: profileError } = await admin.from("user_profile").insert({
    user_id: userId,
    allergies: ["peanut"],
    medications: ["warfarin"],
  });
  check("wrote a user_profile row", !profileError, profileError?.message ?? "ok");

  const proposalId = `proposal-smoke-${randomUUID()}`;
  const { error: proposalError } = await admin.from("proposals").insert({
    id: proposalId,
    user_id: userId,
    food_id: "food-chicken-breast-001",
    food_name: "chicken breast",
    canonical_name: "chicken breast",
    portion_g: 100,
    meal_type: "lunch",
    kcal: 165,
    protein_g: 31,
    fat_g: 3.6,
    carbs_g: 0,
    nutrition_source: "smoke",
    match_type: "exact",
    allergen_tags: [],
    status: "proposed",
  });
  check("wrote a proposals row", !proposalError, proposalError?.message ?? "ok");

  const { error: mealError } = await admin.from("meal_logs").insert({
    user_id: userId,
    food_name: "chicken breast",
    portion_g: 100,
    meal_type: "lunch",
    kcal: 165,
    protein_g: 31,
    fat_g: 3.6,
    carbs_g: 0,
    proposal_id: proposalId,
    food_id: "food-chicken-breast-001",
    match_type: "exact",
    allergen_tags: [],
  });
  check("wrote a meal_logs row", !mealError, mealError?.message ?? "ok");

  // And a turn, so the trace cascade is exercised too.
  const turnId = randomUUID();
  const store = new SupabaseTraceStore({ client: admin, userId, turnId, log: () => {} });
  await store.append({
    schema: SCHEMA_VERSION,
    type: "turn_start",
    seq: 0,
    timestamp: new Date().toISOString(),
    input: { tag: "utterance", content: "delete me" },
  });
  await store.append({
    schema: SCHEMA_VERSION,
    type: "turn_end",
    seq: 1,
    timestamp: new Date().toISOString(),
    result: { reply: "bye", steps: 1, stopReason: "end_turn" },
  });
  const { count: turnEvents } = await admin
    .from("turn_events")
    .select("*", { count: "exact", head: true })
    .eq("turn_id", turnId);
  check("wrote a turn with events", (turnEvents ?? 0) > 0, `${turnEvents ?? 0} event(s)`);

  // ── the deletion, through the function the endpoint calls ────────────────
  let report;
  try {
    report = await deleteAccount(admin, userId);
  } catch (err) {
    check("deleteAccount", false, (err as Error).message);
    return 1;
  }

  console.log("");
  for (const table of ACCOUNT_SCOPED_TABLES) {
    const remaining = report.remaining[table];
    check(
      `${table} is empty afterwards`,
      remaining === 0,
      remaining === "unknown" ? "could not be counted" : `${remaining} row(s)`,
    );
  }

  for (const table of SHARED_TABLES) {
    const entry = report.shared[table];
    check(
      `${table} (shared corpus) is unchanged`,
      entry.before !== "unknown" && entry.before === entry.after,
      `${entry.before} → ${entry.after}`,
    );
  }

  // The account itself is gone: signing in must fail, which is the one check that
  // does use auth rather than a table count.
  const anonKey = requireEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: "definitely-not-the-password",
  });
  check(
    "the account no longer exists",
    signInError !== null,
    signInError?.message ?? "sign-in unexpectedly succeeded",
  );

  console.log(
    failures === 0
      ? "\nOK: deletion removed every account-scoped row and left the corpus alone."
      : `\nFAILED: ${failures} check(s)`,
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`smoke-account-delete: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
