// ⑧ ModelAdapter：唯一对外暴露 {model, thinking} 两旋钮的模块；换模型/换供应商
// 只动这里（CONTEXT.md / PRD §4）。档位 flash/pro → model id；thinking 作为对象透传。
//
// 供应商是**配置**而不是代码（2026-09 起）：DeepSeek 直连与 OpenAI 兼容聚合网关
// （如 Command Code）走同一份实现，差别集中在 PROVIDER_PROFILES —— base URL、两个
// 档位的 model id、计价表、以及是否发送 DeepSeek 私有的 `thinking` 字段。把供应商
// 写死在常量里意味着换网关要改代码，而"换供应商只动这里"是本模块存在的理由。
//
// 用哪家由 NUTRIBUDDY_MODEL_PROVIDER 选（默认 deepseek），单项还可用
// NUTRIBUDDY_MODEL_BASE_URL / NUTRIBUDDY_MODEL_API_KEY / NUTRIBUDDY_MODEL_FLASH /
// NUTRIBUDDY_MODEL_PRO 覆盖。
//
// Issue #41：切到原生 DeepSeek/OpenAI tool-call 协议：
//   - thinking 发 {type: "enabled"|"disabled"}（非 boolean）
//   - 请求体带 tools schemas
//   - 解析 finish_reason:"tool_calls" 响应中的结构化 tool_calls[]
//   - 非法 arguments JSON 不崩溃——转为含 _parse_error 的观察事件

import type {
  ChatMessage,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelTier,
  ModelUsage,
  ToolCall,
  ToolSchema,
} from "./types";

export const TIER_TO_MODEL_ID: Record<ModelTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

/**
 * Per-MTok USD pricing, mirrored from the provider pricing page
 * (https://api-docs.deepseek.com/quick_start/pricing). Refresh alongside
 * TIER_TO_MODEL_ID when models change (issue #58 / ADD §Observability).
 */
export interface TierPricing {
  readonly cacheHitPerMTok: number;
  readonly cacheMissPerMTok: number;
  readonly outputPerMTok: number;
}

export const TIER_PRICING_USD: Record<ModelTier, TierPricing> = {
  flash: {
    cacheHitPerMTok: 0.028,
    cacheMissPerMTok: 0.28,
    outputPerMTok: 0.42,
  },
  pro: {
    cacheHitPerMTok: 0.07,
    cacheMissPerMTok: 0.56,
    outputPerMTok: 1.68,
  },
};

const TOKENS_PER_MTOK = 1_000_000;

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

export type ModelProviderId = "deepseek" | "commandcode" | "custom";

export interface ProviderProfile {
  readonly id: ModelProviderId;
  readonly baseUrl: string;
  /** Environment variable the key is read from when none is passed. */
  readonly apiKeyEnv: string;
  readonly models: Record<ModelTier, string>;
  readonly pricing: Record<ModelTier, TierPricing>;
  /** Where the numbers in `pricing` come from — recorded, not assumed. */
  readonly pricingSource: string;
  /**
   * Whether the provider understands DeepSeek's `thinking: {type}` field.
   *
   * Both providers here do; the flag exists because an OpenAI-compatible gateway
   * that rejects unknown body fields would fail every request with a 400, and
   * that is not something to discover in production.
   */
  readonly sendsThinking: boolean;
}

/**
 * The two providers this repository is configured for. Keys are read from the
 * environment, never from the profile: a profile is committed, a key is not.
 */
export const PROVIDER_PROFILES: Record<Exclude<ModelProviderId, "custom">, ProviderProfile> = {
  deepseek: {
    id: "deepseek",
    baseUrl: DEFAULT_BASE_URL,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
    pricing: TIER_PRICING_USD,
    pricingSource: "deepseek published pricing (mirrored in TIER_PRICING_USD)",
    sendsThinking: true,
  },
  // An OpenAI-compatible gateway in front of the same DeepSeek models. The model
  // ids are namespaced by the gateway, so the ids — not just the URL — are part
  // of the profile; pricing is the upstream table, which the gateway may or may
  // not mark up, so the source is stated rather than implied.
  commandcode: {
    id: "commandcode",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKeyEnv: "COMMANDCODE_API_KEY",
    models: {
      flash: "deepseek/deepseek-v4-flash",
      pro: "deepseek/deepseek-v4-pro",
    },
    pricing: TIER_PRICING_USD,
    pricingSource:
      "upstream deepseek published pricing; the gateway's own markup is not known",
    sendsThinking: true,
  },
};

/**
 * Compute one model call's cost in USD from provider usage (issue #58).
 * When the provider omits the cache split, all prompt tokens charge at
 * the cache-miss rate.
 */
export function computeCostUsd(tier: ModelTier, usage: ModelUsage): number {
  const pricing = TIER_PRICING_USD[tier];
  const cacheHit = usage.cacheHitTokens ?? 0;
  const cacheMiss =
    usage.cacheMissTokens ?? Math.max(0, usage.promptTokens - cacheHit);

  return (
    (cacheHit * pricing.cacheHitPerMTok +
      cacheMiss * pricing.cacheMissPerMTok +
      usage.completionTokens * pricing.outputPerMTok) /
    TOKENS_PER_MTOK
  );
}

const TOOL_ARGUMENT_PREVIEW_CHARS = 200;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type ThinkingConfig = { readonly type: "enabled" | "disabled" };
type ParsedToolArgs =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

export interface DeepSeekAdapterOptions {
  /** 显式 key；缺省时从所选 profile 的 apiKeyEnv 读。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** 注入环境（测试用）；默认 process.env。 */
  readonly env?: Record<string, string | undefined>;
  /** 注入 fetch（测试用）；默认全局 fetch。 */
  readonly fetchImpl?: FetchImpl;
  /** 供应商选择：显式覆盖，否则读 NUTRIBUDDY_MODEL_PROVIDER（默认 deepseek）。 */
  readonly provider?: ModelProviderId;
}

/**
 * Resolve which provider this process should talk to.
 *
 * Explicit arguments win over the environment, and the environment wins over the
 * default — the same precedence every other operator-facing switch in this
 * repository uses, for the same reason: exporting a variable is how a run is
 * aimed at something, and a committed default must not be able to redirect it.
 */
export function resolveProviderProfile(
  options: {
    readonly provider?: ModelProviderId;
    readonly baseUrl?: string;
    readonly env?: Record<string, string | undefined>;
    readonly models?: Partial<Record<ModelTier, string>>;
  } = {},
): ProviderProfile {
  const env = options.env ?? process.env;
  const requested =
    options.provider ??
    (env.NUTRIBUDDY_MODEL_PROVIDER as ModelProviderId | undefined) ??
    "deepseek";

  if (requested !== "custom" && requested in PROVIDER_PROFILES) {
    const base = PROVIDER_PROFILES[requested as Exclude<ModelProviderId, "custom">];
    return {
      ...base,
      baseUrl: options.baseUrl ?? env.NUTRIBUDDY_MODEL_BASE_URL ?? base.baseUrl,
      models: {
        flash:
          options.models?.flash ?? env.NUTRIBUDDY_MODEL_FLASH ?? base.models.flash,
        pro: options.models?.pro ?? env.NUTRIBUDDY_MODEL_PRO ?? base.models.pro,
      },
    };
  }

  if (requested !== "custom") {
    throw new Error(
      `未知的 NUTRIBUDDY_MODEL_PROVIDER：${requested}（可用：deepseek、commandcode、custom）`,
    );
  }

  const baseUrl = options.baseUrl ?? env.NUTRIBUDDY_MODEL_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "NUTRIBUDDY_MODEL_PROVIDER=custom 需要 NUTRIBUDDY_MODEL_BASE_URL",
    );
  }
  return {
    id: "custom",
    baseUrl,
    apiKeyEnv: "NUTRIBUDDY_MODEL_API_KEY",
    models: {
      flash: options.models?.flash ?? env.NUTRIBUDDY_MODEL_FLASH ?? TIER_TO_MODEL_ID.flash,
      pro: options.models?.pro ?? env.NUTRIBUDDY_MODEL_PRO ?? TIER_TO_MODEL_ID.pro,
    },
    // A custom endpoint's prices are not knowable from here, so the upstream
    // table is the assumption — stated, not hidden (§Observability).
    pricing: TIER_PRICING_USD,
    pricingSource:
      "assumed deepseek published pricing; a custom endpoint's own prices are unknown",
    sendsThinking: env.NUTRIBUDDY_MODEL_SENDS_THINKING !== "false",
  };
}

interface ChatCompletionChoice {
  readonly finish_reason?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | null;
    readonly tool_calls?: readonly ChatCompletionToolCall[];
  };
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<ChatCompletionChoice>;
  readonly usage?: ChatCompletionUsage;
}

interface ChatCompletionUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  /** DeepSeek reports the cache split as two top-level fields. */
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_cache_miss_tokens?: number;
  /** OpenAI-compatible gateways report only the hit count, nested. */
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
}

interface ChatCompletionToolCall {
  readonly id?: string;
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

function argumentPreview(argsStr: string): string {
  return argsStr.slice(0, TOOL_ARGUMENT_PREVIEW_CHARS);
}

function parseToolArgs(argsStr: string): ParsedToolArgs {
  try {
    const parsed: unknown = JSON.parse(argsStr);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return { ok: true, value: parsed as Readonly<Record<string, unknown>> };
    }
    return {
      ok: false,
      error: `tool call arguments is not a JSON object: ${argumentPreview(argsStr)}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `[JSON parse error in tool call arguments] ${message}: ${argumentPreview(argsStr)}`,
    };
  }
}

function resolveModelId(profile: ProviderProfile, model: ModelTier): string {
  return profile.models[model] ?? TIER_TO_MODEL_ID[model] ?? model;
}

function thinkingConfig(thinking: boolean): ThinkingConfig {
  return { type: thinking ? "enabled" : "disabled" };
}

function fallbackToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const serialized: Record<string, unknown> = { role: message.role };

  if (message.role === "tool" && message.tool_call_id) {
    serialized.content = message.content;
    serialized.tool_call_id = message.tool_call_id;
    return serialized;
  }

  serialized.content = message.content;

  if (
    message.role === "assistant" &&
    message.tool_calls &&
    message.tool_calls.length > 0
  ) {
    serialized.tool_calls = message.tool_calls;
  }

  return serialized;
}

function buildRequestBody(
  profile: ProviderProfile,
  req: ModelRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolveModelId(profile, req.model),
    messages: req.messages.map((message) => serializeMessage(message)),
  };

  if (profile.sendsThinking) {
    body.thinking = thinkingConfig(req.thinking);
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
  }

  return body;
}

function parseUsage(usage?: ChatCompletionUsage): ModelUsage | undefined {
  if (!usage || typeof usage.total_tokens !== "number") {
    return undefined;
  }

  // Both shapes are read because the two providers in PROVIDER_PROFILES report
  // the prompt cache differently, and a missed split is not cosmetic: cost is
  // charged at the miss rate for every prompt token, so an unread hit count
  // silently inflates every cost number in the report.
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const cacheMiss =
    usage.prompt_cache_miss_tokens ??
    (cacheHit !== undefined ? Math.max(0, promptTokens - cacheHit) : undefined);

  return {
    promptTokens,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
  };
}

function parseToolCall(toolCall: ChatCompletionToolCall): ToolCall {
  const parsedArgs = parseToolArgs(toolCall.function?.arguments ?? "{}");

  return {
    id: toolCall.id ?? fallbackToolCallId(),
    name: toolCall.function?.name ?? "unknown",
    args: parsedArgs.ok ? parsedArgs.value : { _parse_error: parsedArgs.error },
  };
}

export class DeepSeekAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  /** Which endpoint, which models and whose prices describe this adapter. */
  readonly profile: ProviderProfile;

  constructor(options: DeepSeekAdapterOptions = {}) {
    const env = options.env ?? process.env;
    const profile = resolveProviderProfile({
      provider: options.provider,
      baseUrl: options.baseUrl ?? env.DEEPSEEK_BASE_URL,
      env,
    });
    const apiKey =
      options.apiKey ??
      env.NUTRIBUDDY_MODEL_API_KEY ??
      env[profile.apiKeyEnv] ??
      env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        `缺少 ${profile.apiKeyEnv}：请在环境变量（或 .sandcastle/.env）中配置模型密钥。`,
      );
    }
    this.profile = profile;
    this.apiKey = apiKey;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(this.profile, req)),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.profile.id} 请求失败 (${res.status}): ${detail}`,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = choice?.finish_reason ?? "stop";
    const toolCalls = msg?.tool_calls ?? [];
    const usage = parseUsage(data.usage);

    // ── Native tool_calls path ──────────────────────────────────────────
    if (finishReason === "tool_calls" && toolCalls.length > 0) {
      return {
        content: msg?.content ?? "",
        stop: false,
        finishReason: "tool_calls",
        toolCalls: toolCalls.map((toolCall) => parseToolCall(toolCall)),
        usage,
      };
    }

    // ── Text-only path ─────────────────────────────────────────────────
    const content = msg?.content;
    if (typeof content !== "string") {
      throw new Error(
        `${this.profile.id} 返回缺少 choices[0].message.content`,
      );
    }

    return { content, stop: true, finishReason, usage };
  }
}

/** Re-export ToolSchema for consumers that wire tool schemas. */
export type { ToolSchema };
