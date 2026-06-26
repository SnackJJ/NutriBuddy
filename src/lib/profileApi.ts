import type { MemoryStore, ProfilePatch } from "./memoryStore";
import { profileFormSchema } from "./profileValidation";

/**
 * Core handler for GET /api/profile?userId=…
 * Extracted with DI so unit tests can inject a fake MemoryStore.
 */
export async function handleGetProfile(
  userId: string,
  store: MemoryStore,
): Promise<Response> {
  try {
    const profile = await store.getProfile(userId);
    const body = JSON.stringify({ profile });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Core handler for PUT /api/profile
 * Validates the patch body with Zod, then delegates to MemoryStore.
 */
export async function handleUpdateProfile(
  userId: string,
  body: unknown,
  store: MemoryStore,
): Promise<Response> {
  try {
    const parsed = profileFormSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          details: parsed.error.issues,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Only include keys that were present in the raw input — don't let Zod defaults
    // (e.g. allergies=[]) overwrite existing store values.
    const rawKeys = new Set(Object.keys(body as Record<string, unknown>));
    const data = parsed.data as Record<string, unknown>;
    const patch = Object.fromEntries(
      Object.entries(data).filter(([k]) => rawKeys.has(k)),
    ) as ProfilePatch;

    const profile = await store.updateProfile(userId, patch);
    return new Response(JSON.stringify({ profile }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
