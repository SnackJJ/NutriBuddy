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

let cachedClient: SupabaseClient | null | undefined;

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
        const { error } = await client.auth.signUp({ email, password });
        return error ? error.message : null;
      },
      async signOut(): Promise<void> {
        await client?.auth.signOut();
      },
    }),
    [client, session, loading],
  );
}

/** Authorization header for API calls; empty object when signed out. */
export function authHeader(
  session: Session | null,
): Record<string, string> {
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
