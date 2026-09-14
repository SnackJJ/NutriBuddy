// Environment loading for operator scripts.
//
// The process environment takes precedence over `.env.local`, so exporting a
// variable is how a script is pointed at a target explicitly — the accident
// this rule prevents is a `.env.local` aimed at production silently deciding
// where a run goes.
//
// The two smoke scripts keep their own copies on purpose: smoke-rfc0001 lets
// `.env.local` win, which is the opposite rule and documented as such there.

import { readFileSync } from "node:fs";

export function loadEnvLocal(path = ".env.local"): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const split = trimmed.indexOf("=");
      if (split < 0) continue;
      const key = trimmed.slice(0, split).trim();
      if (env[key]) continue;
      let value = trimmed.slice(split + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    // No file: the process environment is the whole configuration.
  }
  return env;
}

export function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

/** True for a Supabase URL that can only be the local stack. */
export function isLocalTarget(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)([:\/]|$)/.test(url);
}
