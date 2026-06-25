import { describe, it, expect } from "vitest";
import { createServerSupabase, createBrowserSupabase } from "../src/lib/supabase";

type Captured = { url: string; key: string; options?: unknown };

function spyCreateClient() {
  const calls: Captured[] = [];
  const impl = (url: string, key: string, options?: unknown) => {
    calls.push({ url, key, options });
    return { __stub: true } as never;
  };
  return { calls, impl };
}

describe("createServerSupabase", () => {
  it("uses the service-role key and the public url, with session persistence disabled", () => {
    const { calls, impl } = spyCreateClient();
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public",
    };

    createServerSupabase({ env, createClientImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://proj.supabase.co");
    expect(calls[0].key).toBe("service-role-secret");
    // server client must never persist a session (it runs with the privileged key)
    expect(calls[0].options).toMatchObject({
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("throws a clear error when the service-role key is missing", () => {
    const { impl } = spyCreateClient();
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co" };

    expect(() => createServerSupabase({ env, createClientImpl: impl })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe("createBrowserSupabase", () => {
  it("uses the anon key and the public url", () => {
    const { calls, impl } = spyCreateClient();
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public",
    };

    createBrowserSupabase({ env, createClientImpl: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://proj.supabase.co");
    expect(calls[0].key).toBe("anon-public");
  });

  it("throws a clear error when the anon key is missing", () => {
    const { impl } = spyCreateClient();
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co" };

    expect(() => createBrowserSupabase({ env, createClientImpl: impl })).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });
});
