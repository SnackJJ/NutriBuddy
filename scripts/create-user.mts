/**
 * Create one account, by hand — the V1.0 sign-up path (S3 / #101 / RFC 0010 §3.2).
 *
 * Usage (from repo root, with .env.local loaded):
 *   npx tsx --env-file=.env.local scripts/create-user.mts friend@example.com
 *   npx tsx --env-file=.env.local scripts/create-user.mts --list
 *
 * Options:
 *   --password <pw>   set the password instead of generating one
 *   --list            list existing accounts and change nothing
 *   --help
 *
 * Why a script instead of a sign-up form: V1.0 is "me and a few friends"
 * (§3.2 plan A), so public sign-up is closed in Supabase Auth and accounts are
 * created here. That keeps the whole allowlist out of the codebase — no table,
 * no hook, no new identity-write path — at the cost of one manual step per person.
 * Plan B (an allowlist table plus a `before user created` hook) is what V1.1
 * adopts if registration reopens; it is not built now because it would serve an
 * unused flow.
 *
 * Why the service role is not a hole: `auth.admin.createUser` requires the
 * service-role key, which exists only on the server and in this operator's shell.
 * The public door is the Dashboard's sign-up toggle, and it stays shut; this
 * script walks past a door the operator holds the key to, which is the intent.
 *
 * `email_confirm: true` on purpose: with sign-up closed there is no confirmation
 * mail flow to complete, and handing the password over directly is the invite.
 *
 * Exit codes: 0 ok, 1 the Auth API refused, 2 missing config or bad arguments.
 */

import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isLocalTarget, loadEnvLocal, requireEnv } from "./lib/env";

const USAGE = `usage:
  create-user <email> [--password <pw>]
  create-user --list

Creates one account through the Supabase admin API. Without --password a random
one is generated and printed once — it is not stored anywhere.`;

interface CreateArgs {
  readonly kind: "create";
  readonly email: string;
  readonly password?: string;
}

interface ListArgs {
  readonly kind: "list";
}

type Args = CreateArgs | ListArgs;

class UsageError extends Error {}

/** Deliberately simple: an account exists for a person the operator knows. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let password: string | undefined;
  let list = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--password": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError("--password needs a value");
        }
        password = value;
        i += 1;
        break;
      }
      case "--list":
        list = true;
        break;
      case "--help":
      case "-h":
        throw new UsageError("requested help");
      default:
        if (flag.startsWith("--")) {
          throw new UsageError(`unknown argument "${flag}"`);
        }
        positional.push(flag);
        break;
    }
  }

  if (list) {
    if (positional.length > 0 || password !== undefined) {
      throw new UsageError("--list takes no other arguments");
    }
    return { kind: "list" };
  }

  if (positional.length !== 1) {
    throw new UsageError(
      positional.length === 0
        ? "an email address is required"
        : "exactly one email address is expected",
    );
  }

  const email = positional[0].trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new UsageError(`"${positional[0]}" does not look like an email address`);
  }
  if (password !== undefined && password.length < 8) {
    throw new UsageError("--password must be at least 8 characters");
  }

  return { kind: "create", email, password };
}

/**
 * A password the operator can read off the terminal and hand over. `base64url`
 * keeps it shell-safe, and 24 bytes of randomness is well past guessing.
 */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

function adminClient(
  url: string,
  serviceRoleKey: string,
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function listAccounts(
  admin: SupabaseClient,
): Promise<number> {
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) {
    console.error(`create-user: could not list accounts: ${error.message}`);
    return 1;
  }

  const users = data?.users ?? [];
  if (users.length === 0) {
    console.log("no accounts exist yet");
    return 0;
  }

  console.log(`${users.length} account(s):`);
  for (const user of users) {
    const email = user.email ?? "(no email)";
    const confirmed = user.email_confirmed_at ? "confirmed" : "unconfirmed";
    const lastSignIn = user.last_sign_in_at ?? "never signed in";
    console.log(
      `  ${email}  created=${user.created_at}  ${confirmed}  last_sign_in=${lastSignIn}`,
    );
  }
  if (users.length === 200) {
    console.log("  (a full page of 200 — there may be more)");
  }
  return 0;
}

async function createAccount(
  admin: SupabaseClient,
  args: CreateArgs,
): Promise<number> {
  const password = args.password ?? generatePassword();

  const { data, error } = await admin.auth.admin.createUser({
    email: args.email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    // A duplicate is the one refusal worth spelling out: it is the ordinary
    // outcome of running this twice, and Auth reports it as a validation error
    // that would otherwise read like a broken key.
    const message = error?.message ?? "no user returned";
    const duplicate = /already|exists|registered/i.test(message);
    console.error(
      `create-user: ${duplicate ? "an account for this address already exists" : "the Auth API refused the request"} — ${message}`,
    );
    return 1;
  }

  console.log(`created: ${data.user.email} (id ${data.user.id})`);
  if (args.password === undefined) {
    console.log(
      "password (shown once, hand it over over a private channel):",
    );
    console.log(`  ${password}`);
  }
  console.log(
    "next: the account can sign in immediately — email confirmation was marked done, so no mail is sent.",
  );
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = (err as Error).message;
    console.error(`create-user: ${message}`);
    console.error(USAGE);
    return message === "requested help" ? 0 : 2;
  }

  // The process environment wins over .env.local (scripts/lib/env.ts), so
  // exporting the variables is how a target is chosen explicitly — which is what
  // should decide where an account is created.
  const env = loadEnvLocal();
  let url: string;
  let serviceRoleKey: string;
  try {
    url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
    serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  } catch (err) {
    console.error(`create-user: ${(err as Error).message}`);
    console.error("  set it in .env.local or export it before running");
    return 2;
  }

  console.log(
    `target: ${url}${isLocalTarget(url) ? " (local stack)" : ""}`,
  );
  const admin = adminClient(url, serviceRoleKey);
  return args.kind === "list"
    ? listAccounts(admin)
    : createAccount(admin, args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(
      `create-user: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  });
