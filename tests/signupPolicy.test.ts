// Sign-up availability tests (S3 / RFC 0010 §3.2, §5, §6 — issues #101, #102).
//
// The repository has no jsdom, so "the entry is not rendered" is asserted the way
// chat.test.ts asserts route and page behaviour: the pure decision (`showSignUp`)
// is unit-tested, and the page's use of it is read off the source. The distinction
// matters — the first is the logic, the second only proves the page is wired to it.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  fetchAuthSettings,
  signInPresentation,
  signupAvailability,
  SIGNUP_CLOSED_MESSAGE,
} from "../src/lib/signupPolicy";

describe("signupAvailability (#102)", () => {
  it("offers sign-up only when Auth says sign-up is open", () => {
    expect(signupAvailability({ disable_signup: false })).toEqual({
      available: true,
      reason: null,
    });
  });

  it("fails closed when Auth says it is closed", () => {
    expect(signupAvailability({ disable_signup: true })).toEqual({
      available: false,
      reason: "signup_disabled",
    });
  });

  it("fails closed when the answer is missing or unreadable", () => {
    // Unreachable and field-absent are the two shapes that used to be a
    // deployment's silent default; both mean "do not render the button".
    expect(signupAvailability(null)).toEqual({
      available: false,
      reason: "settings_unavailable",
    });
    expect(signupAvailability({}).available).toBe(false);
  });
});

describe("fetchAuthSettings (#102)", () => {
  const ok = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it("reads disable_signup from the public settings endpoint", async () => {
    let seen = "";
    const settings = await fetchAuthSettings({
      url: "https://project.supabase.co/",
      anonKey: "anon",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen = `${url}|${(init?.headers as Record<string, string>).apikey}`;
        return ok({ disable_signup: true });
      }) as unknown as typeof fetch,
    });

    expect(seen).toBe("https://project.supabase.co/auth/v1/settings|anon");
    expect(settings).toEqual({ disable_signup: true });
  });

  it("returns null for a failed response, a non-object body, or a missing field", async () => {
    const failed = (async () =>
      ({ ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const notJson = (async () => ok("nope")) as unknown as typeof fetch;
    const missing = (async () => ok({ external: {} })) as unknown as typeof fetch;

    for (const fetchImpl of [failed, notJson, missing]) {
      await expect(
        fetchAuthSettings({ url: "https://x", anonKey: "k", fetchImpl }),
      ).resolves.toBeNull();
    }
  });

  it("returns null when the request throws, rather than propagating into render", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      fetchAuthSettings({ url: "https://x", anonKey: "k", fetchImpl: throwing }),
    ).resolves.toBeNull();
  });
});

describe("signInPresentation (#102)", () => {
  it("offers no sign-up entry while registration is closed", () => {
    const view = signInPresentation(false);
    expect(view.showSignUp).toBe(false);
    expect(view.closedNotice).toBe(SIGNUP_CLOSED_MESSAGE);
  });

  it("offers the entry, and no notice, when registration is open", () => {
    const view = signInPresentation(true);
    expect(view.showSignUp).toBe(true);
    expect(view.closedNotice).toBeNull();
  });

  it("says nothing about who may register (RFC 0010 §5)", () => {
    // The refusal must not become an enumeration oracle: no per-address wording,
    // no allowlist vocabulary, nothing derived from the submitted email.
    const text = SIGNUP_CLOSED_MESSAGE.toLowerCase();
    for (const forbidden of ["allowlist", "whitelist", "白名单", "not allowed", "invite only"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(SIGNUP_CLOSED_MESSAGE).toBe(
      signInPresentation(false).closedNotice,
    );
  });
});

// ─── The hook: the second line of defence ──────────────────────────────

describe("useSupabaseSession signUp guard (#102)", () => {
  const hookSource = () =>
    fs.readFileSync("src/lib/useSupabaseSession.ts", "utf-8");

  it("asks Auth before calling auth.signUp, and refuses while it says no", () => {
    const source = hookSource();
    const guard = source.indexOf(
      "if (!(await resolveSignupAvailable())) return SIGNUP_CLOSED_MESSAGE;",
    );
    const call = source.indexOf("client.auth.signUp(");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("exposes the answer through the hook state, starting closed", () => {
    const source = hookSource();
    expect(source).toContain("const [signupEnabled, setSignupEnabled] = useState(false);");
    expect(source).toContain("signupEnabled,");
    expect(source).toContain("readonly signupEnabled: boolean;");
  });

  it("asks Auth once per page load", () => {
    // One module-level promise: without it, every component that renders the
    // form would issue its own settings request.
    expect(hookSource()).toMatch(/let signupSettingsPromise: Promise<boolean> \| null = null;/);
    expect(hookSource()).toMatch(/if \(signupSettingsPromise\) return signupSettingsPromise;/);
  });
});

// ─── The page: the entry is behind the flag ────────────────────────────

describe("profile page sign-in form (#102)", () => {
  const pageSource = () => fs.readFileSync("app/profile/page.tsx", "utf-8");

  it("renders the sign-up button only under view.showSignUp", () => {
    const source = pageSource();
    const guard = source.indexOf("{view.showSignUp && (");
    expect(guard).toBeGreaterThan(-1);
    // Searched after the guard: the phrase also appears in the comment that
    // explains why the button is conditional.
    const button = source.indexOf("Create account", guard);
    expect(button).toBeGreaterThan(guard);
    // The button is inside the conditional block, which closes before the
    // notice that replaces it.
    const notice = source.indexOf("view.closedNotice && (");
    expect(notice).toBeGreaterThan(button);
  });

  it("takes the flag from the session hook, not from a prop default", () => {
    const source = pageSource();
    expect(source).toContain("signupEnabled,");
    expect(source).toContain("signupEnabled={signupEnabled}");
    expect(source).toContain("signInPresentation(signupEnabled)");
  });

  it("explains the missing entry instead of leaving it silent", () => {
    const source = pageSource();
    expect(source).toContain("data-signup-closed");
    expect(source).toContain("{view.closedNotice}");
  });
});
