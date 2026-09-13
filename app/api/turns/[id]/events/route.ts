import { type NextRequest } from "next/server";
import { createUserSupabase } from "@/lib/supabase";
import { createSupabaseTraceStore } from "@/harness/supabaseTraceStore";
import { assertSessionSubject, getSessionFromHeader } from "@/lib/auth";
import {
  encodeNdjson,
  isTurnId,
  loadTurnReplay,
  parseSinceParam,
} from "@/lib/turnReplay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/turns/:id/events?since=<seq> — replay one turn's events as NDJSON
 * (RFC 0008 §5).
 *
 * Reads go through the session-scoped client, not the service role: the
 * owner-only select policies on `turns` / `turn_events` are the authorization
 * (migration 0011 §3.3). A turn the caller cannot see is a 404 — identical to a
 * turn that does not exist, which is the point.
 *
 * This is what makes a refresh mid-turn survivable: the client asks for the
 * whole turn once to rebuild the conversation, then keeps asking with
 * `since=<lastSeq>` until the still-running turn's terminal event lands.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return jsonError("unauthorized", 401);
  }

  // Same rule as the chat route (RFC 0001): the JWT subject must match the
  // session user, so a token that claims someone else cannot read their trace.
  try {
    assertSessionSubject(session);
  } catch {
    return jsonError("unauthorized", 401);
  }

  const turnId = params.id;
  // Not a uuid, so certainly not a turn this caller owns; answering 404 keeps
  // the "not yours" and "does not exist" cases indistinguishable, and avoids a
  // round trip to PostgREST that would only fail on the cast.
  if (!isTurnId(turnId)) {
    return jsonError("not_found", 404);
  }

  const since = parseSinceParam(request.nextUrl.searchParams.get("since"));
  if (!since.ok) {
    return jsonError("invalid_since", 400);
  }

  const store = createSupabaseTraceStore({
    client: createUserSupabase(session.accessToken),
    userId: session.userId,
    turnId,
    log: (message, detail) => console.error(`[trace] ${message}`, detail),
  });

  try {
    const outcome = await loadTurnReplay(store, turnId, since.sinceSeq);
    if (outcome.kind === "not_found") {
      return jsonError("not_found", 404);
    }

    // An empty body is a 200 on purpose: "your turn, nothing new yet" is not an
    // error, and the client distinguishes it from the 404 above.
    return new Response(encodeNdjson(outcome.events), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-store",
      },
    });
  } catch (err) {
    // Read faults are infrastructure, not authorization: say so instead of
    // letting the client believe the turn is gone.
    console.error("[turns] replay failed", err);
    return jsonError("replay_unavailable", 503);
  }
}
