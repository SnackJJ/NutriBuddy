import { type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/supabase";
import { createMemoryStore, createSupabaseProfileGateway } from "@/lib/memoryStore";
import { handleGetProfile, handleUpdateProfile } from "@/lib/profileApi";

function createStore() {
  const client = createServerSupabase();
  const gateway = createSupabaseProfileGateway(client);
  return createMemoryStore({ gateway });
}

/** GET /api/profile?userId=… — fetch current profile. */
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "userId query parameter is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const store = createStore();
  return handleGetProfile(userId, store);
}

/** PUT /api/profile — update profile (body includes userId + patch fields). */
export async function PUT(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { userId, ...patchBody } = body as Record<string, unknown>;
  if (!userId || typeof userId !== "string") {
    return new Response(
      JSON.stringify({ error: "userId is required in request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const store = createStore();
  return handleUpdateProfile(userId, patchBody, store);
}
