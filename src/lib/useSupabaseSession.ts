// Browser session hook (issue #65).
//
// Wraps the Supabase browser client in a React hook: exposes the current
// session (access token + user), sign-in/sign-up/sign-out, and stays
// subscribed to auth state changes. When the Supabase env vars are absent
// (e.g. local dev without a project), the hook degrades to a permanent
// signed-out state — chat and profile routes require a real session (#82).

"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createBrowserSupabase } from "./supabase";
import {
  fetchAuthSettings,
  signupAvailability,
  SIGNUP_CLOSED_MESSAGE,
} from "./signupPolicy";

let cachedClient: SupabaseClient | null | undefined;

/**
 * Sign-up availability, from Auth's own public settings endpoint.
 *
 * Two properties this shape buys, both of which the env flag it replaced could
 * not have: the module-level promise means one request per page load no matter
 * how many components ask, and every consumer starts from `false` — so the
 * button never appears before the answer does, which is the flash that would
 * reintroduce the doomed button for one paint.
 */
let signupSettingsPromise: Promise<boolean> | null = null;

function resolveSignupAvailable(): Promise<boolean> {
  if (signupSettingsPromise) return signupSettingsPromise;
  signupSettingsPromise = (async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return false;
    const settings = await fetchAuthSettings({ url, anonKey });
    return signupAvailability(settings).available;
  })();
  return signupSettingsPromise;
}

/** Browser-wide singleton; null when Supabase env vars are missing. */
function getBrowserClient(): SupabaseClient | null {
  if (cachedClient === undefined) {
    try {
      cachedClient = createBrowserSupabase();
    } catch {
      cachedClient = null;
    }
  }
  return cachedClient;
}

export interface SupabaseSessionState {
  /** Current session; null when signed out (or Supabase is unconfigured). */
  readonly session: Session | null;
  /** True until the initial session lookup resolves. */
  readonly loading: boolean;
  /** False when Supabase env vars are missing — auth UI should not render. */
  readonly configured: boolean;
  /**
   * Whether account creation can succeed (RFC 0010 §3.2 plan A): the sign-in
   * page must not offer an entry that cannot succeed. False until Auth answers.
   */
  readonly signupEnabled: boolean;
  signIn(email: string, password: string): Promise<string | null>;
  signUp(email: string, password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

/** Returns null on success, or an error message to show the user. */
type AuthResult = string | null;

export function useSupabaseSession(): SupabaseSessionState {
  const client = getBrowserClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(client !== null);
  const [signupEnabled, setSignupEnabled] = useState(false);

  useEffect(() => {
    // Deliberately not awaited inside the auth effect: a slow or unreachable
    // Auth settings endpoint must not hold up the session, and the default
    // (closed) is the safe thing to render in the meantime.
    let cancelled = false;
    resolveSignupAvailable().then((available) => {
      if (!cancelled) setSignupEnabled(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!client) return;

    let cancelled = false;

    client.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session);
        setLoading(false);
      }
    });

    const { data: subscription } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
      },
    );

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [client]);

  return useMemo(
    () => ({
      session,
      loading,
      configured: client !== null,
      signupEnabled,
      async signIn(email: string, password: string): Promise<AuthResult> {
        if (!client) return "Supabase is not configured";
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        return error ? error.message : null;
      },
      async signUp(email: string, password: string): Promise<AuthResult> {
        if (!client) return "Supabase is not configured";
        // Second line of defence behind the hidden button: with sign-up closed
        // the call is refused before it becomes a request that can only fail.
        // The message is the same sentence the page shows, which is what keeps
        // the refusal from describing who may register (RFC 0010 §5).
        if (!(await resolveSignupAvailable())) return SIGNUP_CLOSED_MESSAGE;
        const { error } = await client.auth.signUp({ email, password });
        return error ? error.message : null;
      },
      async signOut(): Promise<void> {
        await client?.auth.signOut();
      },
    }),
    [client, session, loading, signupEnabled],
  );
}

/** Authorization header for API calls; empty object when signed out. */
export function authHeader(
  session: Session | null,
): Record<string, string> {
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
