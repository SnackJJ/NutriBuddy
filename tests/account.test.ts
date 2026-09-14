// Account deletion (S5 / #121).
//
// Two things are worth pinning without a database: that the module counts rather
// than assumes (a leftover row must make `clean` false, not be reported as
// success), and that an unreadable count is `unknown` rather than zero — the one
// substitution that would turn "I could not check" into "nothing is there".

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SCOPED_TABLES,
  AccountDeletionError,
  SHARED_TABLES,
  deleteAccount,
} from "../src/lib/account";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FakeState {
  /** Rows per table, optionally per user. */
  readonly tables: Record<string, number>;
  readonly shared?: Record<string, number>;
  readonly deleteError?: string;
  /** Tables whose count query fails. */
  readonly unreadable?: readonly string[];
}

function fakeClient(state: FakeState & { deleted?: string[] }) {
  const deleted = state.deleted ?? [];
  const client = {
    auth: {
      admin: {
        async deleteUser(userId: string) {
          deleted.push(userId);
          if (state.deleteError) return { error: { message: state.deleteError } };
          // Model the cascade: scoped tables drop to zero, shared tables stay.
          for (const table of ACCOUNT_SCOPED_TABLES) state.tables[table] = 0;
          return { error: null };
        },
      },
    },
    from(table: string) {
      let filtered = false;
      const builder = {
        select: () => builder,
        eq: () => {
          filtered = true;
          return builder;
        },
        then: (resolve: (value: unknown) => void) => {
          if (state.unreadable?.includes(table)) {
            resolve({ count: null, error: { message: `permission denied for table ${table}` } });
            return;
          }
          const counts = SHARED_TABLES.includes(table as never)
            ? (state.shared ?? {})
            : state.tables;
          void filtered;
          resolve({ count: counts[table] ?? 0, error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, deleted };
}

describe("deleteAccount", () => {
  it("reports clean when every scoped table is empty and the corpus is untouched", async () => {
    const state: FakeState & { deleted?: string[] } = {
      tables: Object.fromEntries(ACCOUNT_SCOPED_TABLES.map((table) => [table, 3])),
      shared: { sources: 13, source_sections: 372 },
      deleted: [],
    };
    const { client, deleted } = fakeClient(state);

    const report = await deleteAccount(client, "user-1");

    expect(deleted).toEqual(["user-1"]);
    expect(report.clean).toBe(true);
    for (const table of ACCOUNT_SCOPED_TABLES) {
      expect(report.remaining[table]).toBe(0);
    }
    expect(report.shared.sources).toEqual({ before: 13, after: 13 });
  });

  it("is not clean when a row survives, which is the bug this feature can hide", async () => {
    const state: FakeState = {
      tables: { ...Object.fromEntries(ACCOUNT_SCOPED_TABLES.map((table) => [table, 1])), user_profile: 1 },
      shared: { sources: 13, source_sections: 372 },
    };
    // A cascade that half-works: `user_profile` keeps its row.
    const client = fakeClient(state).client;
    const original = (client as unknown as { auth: { admin: { deleteUser: () => Promise<{ error: null }> } } })
      .auth.admin.deleteUser;
    (client as unknown as { auth: { admin: { deleteUser: () => Promise<unknown> } } }).auth.admin.deleteUser =
      async () => {
        await original();
        state.tables.user_profile = 1;
        return { error: null };
      };

    const report = await deleteAccount(client, "user-1");
    expect(report.clean).toBe(false);
    expect(report.remaining.user_profile).toBe(1);
  });

  it("treats an unreadable count as unknown rather than as zero", async () => {
    const state: FakeState = {
      tables: Object.fromEntries(ACCOUNT_SCOPED_TABLES.map((table) => [table, 0])),
      shared: { sources: 13, source_sections: 372 },
      unreadable: ["turns"],
    };
    const report = await deleteAccount(fakeClient(state).client, "user-1");

    expect(report.remaining.turns).toBe("unknown");
    // Not clean: "could not verify" is not the same claim as "verified empty".
    expect(report.clean).toBe(false);
  });

  it("raises rather than reporting a success when the deletion itself fails", async () => {
    const state: FakeState = {
      tables: Object.fromEntries(ACCOUNT_SCOPED_TABLES.map((table) => [table, 2])),
      shared: {},
      deleteError: "database is not accepting connections",
    };
    await expect(deleteAccount(fakeClient(state).client, "user-1")).rejects.toBeInstanceOf(
      AccountDeletionError,
    );
  });

  it("names every table the check covers, including the trace tables", () => {
    // If a new account-scoped table arrives without a cascade, this list is where
    // someone notices that "delete my account" stopped being true.
    expect([...ACCOUNT_SCOPED_TABLES]).toEqual([
      "user_profile",
      "meal_logs",
      "proposals",
      "turns",
      "turn_events",
    ]);
  });
});
