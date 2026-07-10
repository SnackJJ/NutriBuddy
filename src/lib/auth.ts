// Supabase Auth helpers for server-side session extraction (issue #48 / ADD §Multi-User).
//
// Replaces the client-asserted X-User-Id header with real Supabase session
// verification at the turn seam. On failure, callers treat the request as
// anonymous and do not wire user-scoped stores or tools.

import type { SupabaseClient } from "@supabase/supabase-js";

type SupabaseAuthClientFactory = (token: string) => SupabaseClient;

const AUTHORIZATION_HEADER = "Authorization";
const BEARER_TOKEN_PATTERN = /^Bearer\s+(.+)$/i;

function extractBearerToken(headers: Headers): string | undefined {
  const header = headers.get(AUTHORIZATION_HEADER);
  if (!header) {
    return undefined;
  }

  const match = header.match(BEARER_TOKEN_PATTERN);
  if (!match || !match[1]) {
    return undefined;
  }

  return match[1];
}

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
  createClient: SupabaseAuthClientFactory,
  request: { headers: Headers },
): Promise<string | undefined> {
  const token = extractBearerToken(request.headers);
  if (!token) {
    return undefined;
  }

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
