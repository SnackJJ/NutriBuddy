import { type NextRequest } from "next/server";
import { createServerSupabase, createUserSupabase } from "@/lib/supabase";
import { getSessionFromHeader } from "@/lib/auth";
import { ACCOUNT_SCOPED_TABLES, deleteAccount } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delete the signed-in account (S5 / #121).
 *
 * The identity comes from the session, never from the body: a deletion endpoint
 * that accepts a user id is an endpoint that deletes someone else's account the
 * first time a caller can be talked into sending a different one. The service-role
 * client is only used for the deletion itself, after the session check.
 *
 * The response reports what was removed per table rather than "ok": deletion is
 * irreversible, and a caller (or an operator reading a log) should be able to see
 * that the cascade actually ran. `clean: false` is a bug report, not a warning.
 */
export async function DELETE(request: NextRequest): Promise<Response> {
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const report = await deleteAccount(createServerSupabase(), session.userId);
    if (!report.clean) {
      // The account is gone either way; this line is how a missing cascade gets
      // noticed instead of surviving as an orphaned row nobody queries.
      console.error("[account] deletion left rows behind", {
        userId: report.userId,
        remaining: report.remaining,
        shared: report.shared,
      });
    }
    return new Response(
      JSON.stringify({
        deleted: true,
        remaining: report.remaining,
        clean: report.clean,
        tables: ACCOUNT_SCOPED_TABLES,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[account] deletion failed", err);
    return new Response(JSON.stringify({ error: "deletion_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
