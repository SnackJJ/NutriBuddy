import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserIdFromHeader } from "../src/lib/auth";

interface FakeAuthOptions {
  readonly userId?: string;
  readonly error?: Error;
  readonly onToken?: (token: string) => void;
}

function fakeCreateClient(
  options: FakeAuthOptions = {},
): (token: string) => SupabaseClient {
  return (token) => {
    options.onToken?.(token);

    return {
      auth: {
        getUser: async () => {
          if (options.error) {
            return { data: { user: null }, error: options.error };
          }

          if (!options.userId) {
            return { data: { user: null }, error: new Error("No user") };
          }

          return {
            data: { user: { id: options.userId } },
            error: null,
          };
        },
      },
    } as unknown as SupabaseClient;
  };
}

function makeRequest(authHeader?: string): { headers: Headers } {
  const headers = new Headers();
  if (authHeader) {
    headers.set("Authorization", authHeader);
  }

  return { headers };
}

describe("getUserIdFromHeader", () => {
  it("returns the user ID from a valid Bearer token", async () => {
    const createClient = fakeCreateClient({
      userId: "b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
    });
    const request = makeRequest(
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-token",
    );

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBe("b4e0a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c");
  });

  it("returns undefined when there is no Authorization header", async () => {
    const createClient = fakeCreateClient({ userId: "some-user" });

    const userId = await getUserIdFromHeader(createClient, makeRequest());

    expect(userId).toBeUndefined();
  });

  it("returns undefined when Authorization header is not Bearer format", async () => {
    const createClient = fakeCreateClient({ userId: "some-user" });
    const request = makeRequest("Basic dXNlcjpwYXNz");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBeUndefined();
  });

  it("returns undefined when Bearer token is empty", async () => {
    const createClient = fakeCreateClient({ userId: "some-user" });
    const request = makeRequest("Bearer ");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBeUndefined();
  });

  it("returns undefined when getUser returns an error", async () => {
    const createClient = fakeCreateClient({
      error: new Error("Token expired"),
    });
    const request = makeRequest("Bearer expired-token");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBeUndefined();
  });

  it("returns undefined when getUser returns no user", async () => {
    const createClient = fakeCreateClient();
    const request = makeRequest("Bearer some-token");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBeUndefined();
  });

  it("passes the extracted token to createClient", async () => {
    let capturedToken: string | undefined;
    const createClient = fakeCreateClient({
      userId: "user-123",
      onToken: (token) => {
        capturedToken = token;
      },
    });
    const request = makeRequest("Bearer my-access-token-abc");

    await getUserIdFromHeader(createClient, request);

    expect(capturedToken).toBe("my-access-token-abc");
  });

  it("handles case-insensitive Bearer prefix", async () => {
    const createClient = fakeCreateClient({ userId: "user-456" });
    const request = makeRequest("bearer lowercase-token");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBe("user-456");
  });

  it("returns undefined when createClient throws", async () => {
    const createClient: (token: string) => SupabaseClient = () => {
      throw new Error("Invalid token format");
    };
    const request = makeRequest("Bearer bad-token");

    const userId = await getUserIdFromHeader(createClient, request);

    expect(userId).toBeUndefined();
  });
});
