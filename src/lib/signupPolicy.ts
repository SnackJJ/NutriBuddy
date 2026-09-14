// Sign-up availability for the sign-in page (RFC 0010 §3.2 — S3 / #102).
//
// V1.0 takes plan A: public sign-up is closed in Supabase Auth and accounts are
// created by the operator script (`scripts/create-user.mts`). The browser cannot
// read that Dashboard setting, so the UI takes the same fact from an env flag and
// **defaults to closed**. The failure this prevents is a "Create account" button
// that is guaranteed to fail, and a default of "open" would reproduce exactly
// that on a fresh deployment; when plan B (an allowlist table with a `before user
// created` hook) lands in V1.1, the flag is opened there instead.
//
// This flag is not the gate. Supabase Auth is the gate, and RFC 0010 §3.2 says
// the client UI is never the only door: turning the flag on while sign-up is
// closed merely brings a failing button back, and turning it off closes nothing
// that was open.

export const SIGNUP_ENABLED_ENV = "NEXT_PUBLIC_SIGNUP_ENABLED";

/**
 * Read strictly: only the literal `true` opens the flag. A typo, a stray space or
 * `1` leaves sign-up hidden, because the visible failure (nobody can register) is
 * recoverable by the operator while the hidden one (everybody meets a doomed
 * button) is not reported by anyone.
 */
export function isSignupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SIGNUP_ENABLED_ENV] === "true";
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

export function signInPresentation(signupEnabled: boolean): SignInPresentation {
  return {
    showSignUp: signupEnabled,
    closedNotice: signupEnabled ? null : SIGNUP_CLOSED_MESSAGE,
  };
}
