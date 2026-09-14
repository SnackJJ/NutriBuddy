// Sign-up availability for the sign-in page (RFC 0010 §3.2 — S3 / #102).
//
// V1.0 takes plan A: public sign-up is closed in Supabase Auth and accounts are
// created by the operator script (`scripts/create-user.mts`).
//
// The UI asks **Auth itself**, not a switch of its own. Auth's public settings
// endpoint reports `disable_signup`, so the button follows the gate that actually
// decides: with a duplicate env flag, flipping the Dashboard switch leaves the UI
// claiming the opposite, and the failure is silent in the direction that matters
// — a "Create account" button whose only possible outcome is failure.
//
// The client UI is still not the gate (RFC 0010 §3.2): Supabase Auth refuses the
// sign-up regardless. This module only decides what is worth rendering.

/** The subset of `GET /auth/v1/settings` this decision needs. */
export interface AuthSettings {
  readonly disable_signup?: boolean;
}

export interface SignupAvailability {
  /** Whether account creation can succeed, as far as Auth says. */
  readonly available: boolean;
  /**
   * Why it is unavailable, or null when it is available. Distinguishes "Auth
   * said no" from "Auth could not be reached" for whatever logs this, while both
   * render the same notice to the user.
   */
  readonly reason: "signup_disabled" | "settings_unavailable" | null;
}

/**
 * Read the setting, failing closed.
 *
 * Unreachable, malformed and field-absent all mean "do not offer account
 * creation": the visible failure (nobody can register from the UI) is
 * recoverable by the operator, while the hidden one (everybody meets a doomed
 * button) is reported by nobody.
 */
export function signupAvailability(
  settings: AuthSettings | null,
): SignupAvailability {
  if (settings === null) return { available: false, reason: "settings_unavailable" };
  if (settings.disable_signup === false) return { available: true, reason: null };
  return { available: false, reason: "signup_disabled" };
}

/**
 * What a refused sign-up says.
 *
 * Plan A has one refusal reason and it is global — sign-up as a whole is closed —
 * so this text cannot carry per-address information by construction. The wording
 * rule outlives plan A: RFC 0010 §5 forbids a message that would let someone
 * enumerate who is allowed ("this email is not on the allowlist"), so any future
 * allowlist hook must keep answering with this sentence rather than with its
 * reason. The submitted address is never echoed back either.
 */
export const SIGNUP_CLOSED_MESSAGE =
  "Account creation is closed right now. Ask the operator to create an account for you.";

export interface SignInPresentation {
  /** Whether the page may offer account creation at all. */
  readonly showSignUp: boolean;
  /** Shown in place of the button, so the absence is explained rather than silent. */
  readonly closedNotice: string | null;
}

export function signInPresentation(available: boolean): SignInPresentation {
  return {
    showSignUp: available,
    closedNotice: available ? null : SIGNUP_CLOSED_MESSAGE,
  };
}

/**
 * `GET {url}/auth/v1/settings` — public, needs only the anon key, and the same
 * source the operator's Dashboard toggle writes to.
 *
 * Returns null on any failure: the caller's decision is fail-closed, and a thrown
 * error here would only be caught one level up to make the same choice.
 */
export async function fetchAuthSettings(input: {
  readonly url: string;
  readonly anonKey: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<AuthSettings | null> {
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const response = await doFetch(
      `${input.url.replace(/\/+$/, "")}/auth/v1/settings`,
      { headers: { apikey: input.anonKey } },
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const disableSignup = (parsed as { disable_signup?: unknown }).disable_signup;
    if (typeof disableSignup !== "boolean") return null;
    return { disable_signup: disableSignup };
  } catch {
    return null;
  }
}
