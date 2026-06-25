// Supabase 客户端初始化（issue #3 / PRD 技术栈：Next.js + Supabase + 自建 harness）。
//
// 两个入口，对应 PRD「server-side service role + client-side anon」两条信任边界：
//   - createServerSupabase: 服务端用 service-role key，拥有绕过 RLS 的特权，
//     绝不持久化 session（无浏览器、无刷新令牌）。只在服务端代码里 import。
//   - createBrowserSupabase: 浏览器用 anon key，受 RLS 约束，可安全下发到客户端。
//
// 沿用 harness 既有约定：env 与 createClient 均可注入，便于单测不触网。

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

type Env = Record<string, string | undefined>;
type CreateClientImpl = typeof createClient;

export interface SupabaseFactoryOptions {
  /** 注入环境（测试用）；默认 process.env。 */
  readonly env?: Env;
  /** 注入 createClient（测试用）；默认 @supabase/supabase-js 的实现。 */
  readonly createClientImpl?: CreateClientImpl;
}

function requireEnv(env: Env, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(
      `Missing required env var: ${key}. 在 .env.local 中配置（参考 .env.local.example）。`,
    );
  }
  return value;
}

/** 服务端客户端：service-role key，绕过 RLS，绝不持久化 session。 */
export function createServerSupabase(
  options: SupabaseFactoryOptions = {},
): SupabaseClient {
  const env = options.env ?? process.env;
  const create = options.createClientImpl ?? createClient;
  const url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  return create(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** 浏览器客户端：anon key，受 RLS 约束，可下发到客户端。 */
export function createBrowserSupabase(
  options: SupabaseFactoryOptions = {},
): SupabaseClient {
  const env = options.env ?? process.env;
  const create = options.createClientImpl ?? createClient;
  const url = requireEnv(env, "NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return create(url, anonKey);
}
