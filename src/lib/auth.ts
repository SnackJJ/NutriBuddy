// Supabase Auth helpers for server-side session extraction (issue #48 / ADD §Multi-User).
//
// Replaces the client-asserted X-User-Id header with real Supabase session
// verification. The authenticated user identity enters the harness at the
// turn seam — it is never model-fillable.
//
// Two approaches are supported:
//   1. Authorization header: `Bearer <access_token>` (from Supabase client SDK)
//   2. Cookie-based session (Next.js server components / middleware)
//
// On failure, returns undefined — the route handler treats unauthenticated
// requests as anonymous (no store wiring, no tool wiring).

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Extract and verify user identity from the request's Authorization header.
 *
 * Creates a short-lived Supabase client scoped to the user's access token,
 * calls getUser() to verify the token, and returns the authenticated user ID
 * on success. Returns undefined when no token is present or the token is
 * invalid/expired.
 *
 * This is the primary auth path for API routes called from the browser
 * Supabase client (which sends the access token in the Authorization header).
 */
export async function getUserIdFromHeader(
  createClient: (
    token: string,
  ) => SupabaseClient,
  request: { headers: Headers },
): Promise<string | undefined> {
  const header = request.headers.get("Authorization");
  if (!header) {
    return undefined;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return undefined;
  }

  const token = match[1];

  try {
    const client = createClient(token);
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) {
      return undefined;
    }
    return data.user.id;
  } catch {
    return undefined;
  }
}
