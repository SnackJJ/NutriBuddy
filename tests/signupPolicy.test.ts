// Sign-up availability tests (S3 / RFC 0010 §3.2, §5, §6 — issues #101, #102).
//
// The repository has no jsdom, so "the entry is not rendered" is asserted the way
// chat.test.ts asserts route and page behaviour: the pure decision (`showSignUp`)
// is unit-tested, and the page's use of it is read off the source. The distinction
// matters — the first is the logic, the second only proves the page is wired to it.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  isSignupEnabled,
  signInPresentation,
  SIGNUP_CLOSED_MESSAGE,
  SIGNUP_ENABLED_ENV,
} from "../src/lib/signupPolicy";

describe("isSignupEnabled (#102)", () => {
  it("defaults to closed when the flag is absent", () => {
    // V1.0 ships with sign-up closed, so an unset flag must hide the entry; a
    // default of "open" would put a doomed button on every fresh deployment.
    expect(isSignupEnabled({})).toBe(false);
    expect(isSignupEnabled({ [SIGNUP_ENABLED_ENV]: "" })).toBe(false);
  });

  it("opens only for the literal true", () => {
    for (const value of ["1", "TRUE", "True", "yes", " true", "true "]) {
      expect(isSignupEnabled({ NEXT_PUBLIC_SIGNUP_ENABLED: value })).toBe(false);
    }
    expect(isSignupEnabled({ NEXT_PUBLIC_SIGNUP_ENABLED: "true" })).toBe(true);
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

  it("refuses to call Supabase auth.signUp while sign-up is closed", () => {
    const source = hookSource();
    const guard = source.indexOf("if (!SIGNUP_ENABLED) return SIGNUP_CLOSED_MESSAGE;");
    const call = source.indexOf("client.auth.signUp(");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(call);
  });

  it("exposes the flag through the hook state", () => {
    const source = hookSource();
    expect(source).toContain("signupEnabled: SIGNUP_ENABLED");
    expect(source).toContain("readonly signupEnabled: boolean;");
  });

  it("reads the flag once, at module load", () => {
    // NEXT_PUBLIC_* is inlined at build time, so a per-render read would only
    // create a second place where the answer could differ.
    expect(hookSource()).toMatch(/const SIGNUP_ENABLED = isSignupEnabled\(\);/);
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
