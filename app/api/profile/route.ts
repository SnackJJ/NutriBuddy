import { type NextRequest } from "next/server";
import { createServerSupabase, createUserSupabase } from "@/lib/supabase";
import { createMemoryStore, createSupabaseProfileGateway } from "@/lib/memoryStore";
import { handleGetProfile, handleUpdateProfile } from "@/lib/profileApi";
import { getSessionFromHeader } from "@/lib/auth";

// The store runs on the service-role client on purpose: migration 0007
// removed the authenticated write policies on user_profile, so this
// validated API is the sole write door (ADD §Memory). Identity, however,
// comes exclusively from the verified session below (issue #65) — the
// client can no longer assert a userId.
function createStore() {
  const client = createServerSupabase();
  const gateway = createSupabaseProfileGateway(client);
  return createMemoryStore({ gateway });
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "Authentication required" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

/** GET /api/profile — fetch the authenticated user's profile. */
export async function GET(request: NextRequest): Promise<Response> {
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return unauthorized();
  }

  const store = createStore();
  return handleGetProfile(session.userId, store);
}

/** PUT /api/profile — update the authenticated user's profile. */
export async function PUT(request: NextRequest): Promise<Response> {
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Strip any client-sent userId so it can neither select the target row
  // nor leak into the patch.
  const { userId: _ignored, ...patchBody } = body as Record<string, unknown>;

  const store = createStore();
  return handleUpdateProfile(session.userId, patchBody, store);
}
