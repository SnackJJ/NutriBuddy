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
    const rawInput = body as Record<string, unknown>;
    const patch: ProfilePatch = {};
    for (const key of Object.keys(rawInput)) {
      if (key in parsed.data && rawInput[key as keyof typeof parsed.data] !== undefined) {
        (patch as Record<string, unknown>)[key] = parsed.data[key as keyof typeof parsed.data];
      }
    }
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
