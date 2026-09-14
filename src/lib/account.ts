// Account deletion (S5 / #121).
//
// One function, one door: the service role deletes the auth user, and every table
// that belongs to that user follows through foreign keys (`turns` / `turn_events`
// since 0011, the three legacy tables since 0016). The alternative — a routine
// that deletes rows table by table — is a routine that forgets a table the day
// someone adds one, and forgetting means a "deleted" account whose meal history is
// still in the database.
//
// What this module owns is the *order* and the *verification*: deletion is
// irreversible, so the caller gets back what was actually removed rather than a
// boolean, and a failure to read a count is reported as unknown rather than as
// zero.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Tables that must not hold rows for the deleted account afterwards.
 *
 * Named explicitly because the check is the point of the feature: if a table is
 * added to the product without a foreign key to `auth.users`, this list is where
 * someone notices that "delete my account" stopped being true.
 */
export const ACCOUNT_SCOPED_TABLES = [
  "user_profile",
  "meal_logs",
  "proposals",
  "turns",
  "turn_events",
] as const;

/** Tables that must be *unchanged* by a deletion: the shared corpus. */
export const SHARED_TABLES = ["sources", "source_sections"] as const;

export type AccountScopedTable = (typeof ACCOUNT_SCOPED_TABLES)[number];

export interface AccountDeletionReport {
  readonly userId: string;
  readonly deleted: boolean;
  /** Rows per table after the deletion; every entry must be 0. */
  readonly remaining: Readonly<Record<string, number | "unknown">>;
  /** Corpus row counts before and after, which must be identical. */
  readonly shared: Readonly<Record<string, { readonly before: number | "unknown"; readonly after: number | "unknown" }>>;
  /** True when every scoped table is empty and the shared tables are unchanged. */
  readonly clean: boolean;
}

async function countRows(
  client: SupabaseClient,
  table: string,
  userId?: string,
): Promise<number | "unknown"> {
  let query = client.from(table).select("*", { count: "exact", head: true });
  if (userId !== undefined) query = query.eq("user_id", userId);
  const { count, error } = await query;
  if (error) return "unknown";
  return count ?? 0;
}

async function countsFor(
  client: SupabaseClient,
  tables: readonly string[],
  userId?: string,
): Promise<Record<string, number | "unknown">> {
  const entries = await Promise.all(
    tables.map(async (table) => [table, await countRows(client, table, userId)] as const),
  );
  return Object.fromEntries(entries);
}

export class AccountDeletionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AccountDeletionError";
    this.code = code;
  }
}

/**
 * Delete an account and report what is left.
 *
 * The service-role client is required, and the caller is responsible for having
 * authenticated the request: this function deletes whatever user id it is given,
 * which is exactly why it lives next to the endpoint rather than in the session
 * path.
 */
export async function deleteAccount(
  client: SupabaseClient,
  userId: string,
): Promise<AccountDeletionReport> {
  const sharedBefore = await countsFor(client, SHARED_TABLES);

  const { error } = await client.auth.admin.deleteUser(userId);
  if (error) {
    throw new AccountDeletionError(
      "delete_failed",
      `could not delete the account: ${error.message}`,
    );
  }

  // Counted rather than assumed: the cascade is a schema property, and this is
  // where a schema that stopped providing it becomes visible instead of silent.
  const remaining = await countsFor(client, ACCOUNT_SCOPED_TABLES, userId);
  const sharedAfter = await countsFor(client, SHARED_TABLES);

  const shared = Object.fromEntries(
    SHARED_TABLES.map((table) => [
      table,
      { before: sharedBefore[table], after: sharedAfter[table] },
    ]),
  );

  const clean =
    Object.values(remaining).every((count) => count === 0) &&
    Object.values(shared).every(
      (entry) => entry.before !== "unknown" && entry.before === entry.after,
    );

  return { userId, deleted: true, remaining, shared, clean };
}
