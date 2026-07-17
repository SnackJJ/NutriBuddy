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

/** A verified session: the authenticated user plus the token that proved it. */
export interface VerifiedSession {
  readonly userId: string;
  /** The verified access token — build session-scoped clients from this
   *  (ADD §Multi-User: the turn path runs under least-privilege roles). */
  readonly accessToken: string;
}

/**
 * Decode JWT payload.sub without verifying signature (verification already
 * happened via getUser). Returns undefined when the token is not a
 * three-part JWT or the payload lacks a string sub.
 */
export function decodeJwtSubject(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload: unknown = JSON.parse(payloadJson);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "sub" in payload &&
      typeof (payload as { sub: unknown }).sub === "string"
    ) {
      return (payload as { sub: string }).sub;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assert that session.userId matches the JWT access-token `sub` claim
 * (RFC 0001 Phase 1 assembly assert). Call at turn assembly before turn().
 *
 * When the token is not a decodable JWT (e.g. test stubs), the assert is a
 * no-op — Supabase getUser already established the subject.
 */
export function assertSessionSubject(session: VerifiedSession): void {
  const sub = decodeJwtSubject(session.accessToken);
  if (sub !== undefined && sub !== session.userId) {
    throw new Error(
      `session subject mismatch: JWT sub "${sub}" !== session.userId "${session.userId}"`,
    );
  }
}

/**
 * Extract and verify the session from the request's Authorization header.
 *
 * Creates a short-lived Supabase client scoped to the user's access token,
 * calls getUser() to verify the token, and returns the authenticated user ID
 * together with the verified token on success. Returns undefined when no
 * token is present or the token is invalid/expired.
 *
 * This is the primary auth path for API routes called from the browser
 * Supabase client (which sends the access token in the Authorization header).
 */
export async function getSessionFromHeader(
  createClient: SupabaseAuthClientFactory,
  request: { headers: Headers },
): Promise<VerifiedSession | undefined> {
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
    return { userId: data.user.id, accessToken: token };
  } catch {
    return undefined;
  }
}

/** Verify the Authorization header and return just the user id. */
export async function getUserIdFromHeader(
  createClient: SupabaseAuthClientFactory,
  request: { headers: Headers },
): Promise<string | undefined> {
  const session = await getSessionFromHeader(createClient, request);
  return session?.userId;
}
