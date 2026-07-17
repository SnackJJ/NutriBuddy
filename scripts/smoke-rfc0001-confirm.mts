/**
 * Live Supabase smoke for RFC 0001 confirm/void RPCs.
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/smoke-rfc0001-confirm.mts
 *
 * Requires migration 0009 applied (commit_proposal_and_insert_meal + void_proposal).
 * Creates a temporary auth user, exercises commit / void / not_committable, then deletes the user.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
      let k = t.slice(0, i).trim();
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
  const v = env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
}

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
BLOCKED: migration 0009 not applied.

Apply once in Supabase Dashboard → SQL Editor → paste and run:

  supabase/migrations/0009_commit_proposal_and_void.sql

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
  } finally {
    // Cleanup rows then user (service role)
    await admin.from("meal_logs").delete().eq("user_id", userId);
    await admin.from("proposals").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
    log("cleanup user+rows", true);
  }

  console.log(failed ? "\n=== SMOKE FAILED ===" : "\n=== SMOKE PASSED ===");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
