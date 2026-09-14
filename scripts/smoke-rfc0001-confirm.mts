/**
 * Live Supabase smoke for RFC 0001 confirm/void RPCs — and, since #120, for the
 * grants those RPCs run on.
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/smoke-rfc0001-confirm.mts
 *
 * Requires migration 0009 applied (commit_proposal_and_insert_meal + void_proposal).
 * Creates two temporary auth users — one who commits and voids, one who tries to
 * read the first one's rows — then deletes both.
 *
 * Why this is the acceptance for migration 0014: the RPCs are security invoker,
 * so every statement inside them runs on the caller's grants, and the unit tests
 * inject a fake client that has no grants at all. Nothing else in the repository
 * exercises `grant select, insert, update on proposals` / `grant insert on
 * meal_logs` against a real database.
 *
 * Target selection: the process environment wins over `.env.local`, so exporting
 * a URL is how a run is aimed at the local stack instead of the project the file
 * points at (RFC 0008 §3.8 work; the other smoke script has the same rule).
 */

import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnvLocal, requireEnv, isLocalTarget } from "./lib/env";

function log(step: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function rpcExists(
  client: SupabaseClient,
  fn: string,
): Promise<{ exists: boolean; detail: string }> {
  const { error } = await client.rpc(fn, { p_proposal_id: "smoke-probe" });
  if (!error) return { exists: true, detail: "callable" };
  if (error.code === "PGRST202" || /Could not find the function/i.test(error.message)) {
    return { exists: false, detail: error.message };
  }
  // Function exists but rejected the call (expected for missing proposal)
  return { exists: true, detail: `${error.code ?? "err"}: ${error.message}` };
}

/** A denial, with the door that denied it named. */
const NO_TABLE_PRIVILEGE = /permission denied for (table|relation)/i;
/** A policy refused the row — the same SQLSTATE as the privilege check above. */
const RLS_DENIED = /row-level security/i;

/**
 * Report a statement that must be refused.
 *
 * Postgres answers both "no privilege on this table" and "a policy rejected this
 * row" with 42501, so the code alone cannot tell a closed grant from a working
 * policy — and migration 0014's claim is specifically the first kind. Checking
 * the message is what makes the assertion able to fail for the right reason; a
 * code-only version passes with the default grants restored (#124's lesson).
 */
async function denied(
  label: string,
  result: { error: { code?: string; message?: string } | null },
  pattern: RegExp,
): Promise<boolean> {
  const error = result.error;
  if (!error) {
    log(label, false, "the statement unexpectedly succeeded");
    return false;
  }
  const ok = error.code === "42501" && pattern.test(error.message ?? "");
  log(label, ok, `code=${error.code ?? "-"} message=${error.message ?? "-"}`);
  return ok;
}

async function main(): Promise<void> {
  const env = loadEnvLocal();
  const url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = requireEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== RFC 0001 confirm/void smoke ===");
  console.log(`project: ${url}`);

  // This script now creates and deletes two accounts, so a hosted target has to
  // be asked for explicitly — the accident it prevents is a `.env.local` aimed
  // at the real project turning a local run into one against real users. Same
  // rule as scripts/smoke-rfc0008-trace.mts.
  if (!isLocalTarget(url) && env.SMOKE_ALLOW_REMOTE !== "1") {
    console.log(`
refusing to run against ${url}

This script creates and deletes two auth accounts plus rows in proposals,
meal_logs and user_profile. Set SMOKE_ALLOW_REMOTE=1 to target a hosted project
on purpose (for example to check 0009/0014 in production).
`);
    process.exit(2);
  }

  // ── tables ──────────────────────────────────────────────────────────
  for (const table of ["proposals", "meal_logs"] as const) {
    const { error } = await admin.from(table).select("*", {
      count: "exact",
      head: true,
    });
    log(`table ${table}`, !error, error?.message);
    if (error) process.exitCode = 1;
  }

  // ── migration 0009 ──────────────────────────────────────────────────
  const commitFn = await rpcExists(admin, "commit_proposal_and_insert_meal");
  const voidFn = await rpcExists(admin, "void_proposal");
  log("rpc commit_proposal_and_insert_meal", commitFn.exists, commitFn.detail);
  log("rpc void_proposal", voidFn.exists, voidFn.detail);

  if (!commitFn.exists || !voidFn.exists) {
    console.log(`
BLOCKED: migration 0009 is not applied to this project.

Apply migrations the way the repository builds them — supabase/migrations is the
single source of truth, so nothing should be pasted into the Dashboard:

  supabase link --project-ref <ref>
  supabase db push

If this project was ever set up by pasting files by hand, its
supabase_migrations.schema_migrations history is empty, so \`db push\` would start
at 0001 and collide with the existing tables. Record the hand-applied ones once —
0001 through 0008 only: this branch only runs because 0009 is missing, and 0010
replaces the same function 0009 creates, so both are certainly absent and must
not be marked applied:

  supabase migration repair --status applied 0001 0002 0003 0004 0005 \\
    0006 0007 0008

Then \`supabase db push\` applies 0009 through 0011.

Local replay check: bash scripts/verify-migrations.sh

Then re-run:
  npx tsx --env-file=.env.local scripts/smoke-rfc0001-confirm.mts
`);
    process.exit(2);
  }

  // ── temp user ───────────────────────────────────────────────────────
  const email = `smoke-${randomUUID().slice(0, 8)}@example.com`;
  const password = `Smoke-${randomUUID().slice(0, 12)}aA1!`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    log("createUser", false, createErr?.message ?? "no user");
    process.exit(1);
  }
  const userId = created.user.id;
  log("createUser", true, `id=${userId.slice(0, 8)}…`);

  let failed = false;
  // The stranger is created inside the try and deleted in the finally, so a
  // failure before it exists must not try to delete it.
  let strangerId: string | undefined;
  try {
    const browser = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signed, error: signErr } = await browser.auth.signInWithPassword({
      email,
      password,
    });
    if (signErr || !signed.session) {
      log("signIn", false, signErr?.message ?? "no session");
      process.exit(1);
    }
    log("signIn", true);

    const user = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${signed.session.access_token}` },
      },
    });

    // Insert two proposals as this user (RLS)
    const proposalA = {
      id: `proposal-smoke-a-${randomUUID()}`,
      user_id: userId,
      food_id: "food-egg-001",
      food_name: "egg",
      canonical_name: "Egg, whole, raw",
      portion_g: 50,
      meal_type: "breakfast",
      kcal: 72,
      protein_g: 6.3,
      fat_g: 4.8,
      carbs_g: 0.4,
      nutrition_source: "smoke",
      match_type: "exact",
      allergen_tags: ["egg"],
      status: "proposed",
    };
    const proposalB = {
      ...proposalA,
      id: `proposal-smoke-b-${randomUUID()}`,
      food_name: "banana",
      food_id: "food-banana-001",
      allergen_tags: [],
    };

    for (const row of [proposalA, proposalB]) {
      const { error } = await user.from("proposals").insert(row);
      if (error) {
        log(`insert proposal ${row.id.slice(0, 24)}…`, false, error.message);
        failed = true;
      } else {
        log(`insert proposal ${row.food_name}`, true);
      }
    }
    if (failed) process.exit(1);

    // ── commit A ──────────────────────────────────────────────────────
    const { data: commitData, error: commitErr } = await user.rpc(
      "commit_proposal_and_insert_meal",
      { p_proposal_id: proposalA.id },
    );
    if (commitErr) {
      log("commit A", false, commitErr.message);
      failed = true;
    } else {
      const status = (commitData as { status?: string } | null)?.status;
      log("commit A return status", status === "committed", JSON.stringify(commitData));
      if (status !== "committed") failed = true;
    }

    const { data: propA } = await user
      .from("proposals")
      .select("status")
      .eq("id", proposalA.id)
      .maybeSingle();
    log("proposal A status committed", propA?.status === "committed", propA?.status);

    const { data: mealsA, error: mealErr } = await user
      .from("meal_logs")
      .select("id, proposal_id, food_name")
      .eq("proposal_id", proposalA.id);
    if (mealErr) {
      log("meal_logs for A", false, mealErr.message);
      failed = true;
    } else {
      log(
        "meal_logs for A",
        (mealsA?.length ?? 0) === 1,
        `rows=${mealsA?.length ?? 0}`,
      );
      if ((mealsA?.length ?? 0) !== 1) failed = true;
    }

    // ── re-commit A → not_committable ─────────────────────────────────
    const { data: reCommit, error: reErr } = await user.rpc(
      "commit_proposal_and_insert_meal",
      { p_proposal_id: proposalA.id },
    );
    if (reErr) {
      log("re-commit A (expect not_committable return)", false, reErr.message);
      failed = true;
    } else {
      const status = (reCommit as { status?: string } | null)?.status;
      log("re-commit A", status === "not_committable", JSON.stringify(reCommit));
      if (status !== "not_committable") failed = true;
    }

    // ── void B ────────────────────────────────────────────────────────
    const { data: voidData, error: voidErr } = await user.rpc("void_proposal", {
      p_proposal_id: proposalB.id,
    });
    if (voidErr) {
      log("void B", false, voidErr.message);
      failed = true;
    } else {
      const status = (voidData as { status?: string } | null)?.status;
      log("void B return status", status === "voided", JSON.stringify(voidData));
      if (status !== "voided") failed = true;
    }

    const { data: propB } = await user
      .from("proposals")
      .select("status")
      .eq("id", proposalB.id)
      .maybeSingle();
    log("proposal B status voided", propB?.status === "voided", propB?.status);

    const { data: mealsB } = await user
      .from("meal_logs")
      .select("id")
      .eq("proposal_id", proposalB.id);
    log("meal_logs for B empty", (mealsB?.length ?? 0) === 0, `rows=${mealsB?.length ?? 0}`);
    if ((mealsB?.length ?? 0) !== 0) failed = true;

    // ── missing id → not_committable ──────────────────────────────────
    const { data: miss, error: missErr } = await user.rpc(
      "commit_proposal_and_insert_meal",
      { p_proposal_id: "proposal-does-not-exist" },
    );
    if (missErr) {
      log("missing proposal", false, missErr.message);
      failed = true;
    } else {
      const status = (miss as { status?: string } | null)?.status;
      log("missing proposal", status === "not_committable", JSON.stringify(miss));
      if (status !== "not_committable") failed = true;
    }

    // ── 0014: the privilege layer, not just RLS ───────────────────────
    //
    // A profile row only exists if this smoke creates one, and a stranger
    // reading zero rows from an empty table proves nothing. So the owner gets a
    // row and confirms they can see it first; that read is the positive control
    // for the three cross-account checks below.
    const { error: profileSeedErr } = await admin.from("user_profile").insert({
      user_id: userId,
      allergies: ["peanut"],
      medications: [],
      goal_type: "maintain",
    });
    log("seed user_profile row for the owner", !profileSeedErr, profileSeedErr?.message);
    if (profileSeedErr) failed = true;

    const { data: ownProfile, error: ownProfileErr } = await user
      .from("user_profile")
      .select("id")
      .eq("user_id", userId);
    log(
      "owner reads own profile",
      !ownProfileErr && (ownProfile?.length ?? 0) === 1,
      ownProfileErr?.message ?? `rows=${ownProfile?.length ?? 0}`,
    );
    if (ownProfileErr || (ownProfile?.length ?? 0) !== 1) failed = true;

    const strangerEmail = `smoke-stranger-${randomUUID().slice(0, 8)}@example.com`;
    const strangerPassword = `Smoke-${randomUUID().slice(0, 12)}aA1!`;
    const { data: strangerCreated, error: strangerCreateErr } =
      await admin.auth.admin.createUser({
        email: strangerEmail,
        password: strangerPassword,
        email_confirm: true,
      });
    if (strangerCreateErr || !strangerCreated.user) {
      log("createUser stranger", false, strangerCreateErr?.message ?? "no user");
      process.exit(1);
    }
    strangerId = strangerCreated.user.id;

    const { data: strangerSigned, error: strangerSignErr } = await browser.auth
      .signInWithPassword({ email: strangerEmail, password: strangerPassword });
    if (strangerSignErr || !strangerSigned.session) {
      log("stranger signIn", false, strangerSignErr?.message ?? "no session");
      process.exit(1);
    }
    const stranger = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${strangerSigned.session.access_token}` },
      },
    });

    for (const table of ["proposals", "meal_logs", "user_profile"] as const) {
      const { data, error } = await stranger.from(table).select("id");
      const rows = data?.length ?? 0;
      log(
        `stranger reads ${table}`,
        !error && rows === 0,
        error?.message ?? `rows=${rows}`,
      );
      if (error || rows !== 0) failed = true;
    }

    // The other half of 0014: the default grants are gone, so these are refused
    // by the privilege check rather than by a policy. Both denials are 42501,
    // which is exactly why the message has to be asserted too — a code-only
    // check passes with the default grants still in place (#124).
    failed = !(await denied(
      "owner cannot delete meal_logs",
      await user.from("meal_logs").delete().eq("user_id", userId),
      NO_TABLE_PRIVILEGE,
    )) || failed;

    failed = !(await denied(
      "owner cannot update meal_logs",
      await user.from("meal_logs").update({ food_name: "tampered" }).eq("user_id", userId),
      NO_TABLE_PRIVILEGE,
    )) || failed;

    failed = !(await denied(
      "owner cannot write own profile directly",
      await user.from("user_profile").insert({ user_id: userId, allergies: [] }),
      NO_TABLE_PRIVILEGE,
    )) || failed;

    // Contrast, and the reason the message matters: inserting a proposal is a
    // *granted* privilege refused by RLS — same SQLSTATE, the other door.
    failed = !(await denied(
      "stranger cannot insert a proposal for the owner",
      await stranger.from("proposals").insert({ ...proposalA, id: `proposal-smoke-x-${randomUUID()}` }),
      RLS_DENIED,
    )) || failed;
  } finally {
    // Cleanup rows then users (service role). `user_profile.user_id` has no
    // foreign key to auth.users (0001), so it is deleted explicitly — otherwise
    // a smoke run leaves a profile row behind forever.
    await admin.from("meal_logs").delete().eq("user_id", userId);
    await admin.from("proposals").delete().eq("user_id", userId);
    await admin.from("user_profile").delete().eq("user_id", userId);
    if (strangerId) await admin.auth.admin.deleteUser(strangerId);
    await admin.auth.admin.deleteUser(userId);

    // Counted after the deletes rather than asserted as "no error": a cleanup
    // that removed nothing is also a successful delete statement.
    for (const table of ["proposals", "meal_logs", "user_profile"] as const) {
      const { data } = await admin.from(table).select("id").eq("user_id", userId);
      log(`cleanup ${table} empty`, (data?.length ?? 0) === 0, `rows=${data?.length ?? 0}`);
    }
    log("cleanup users", true);
  }

  console.log(failed ? "\n=== SMOKE FAILED ===" : "\n=== SMOKE PASSED ===");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
