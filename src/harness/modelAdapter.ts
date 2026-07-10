// ⑧ ModelAdapter：唯一对外暴露 {model, thinking} 两旋钮的模块；换模型/换供应商
// 只动这里（CONTEXT.md / PRD §4）。本切片实现 DeepSeek V4 的真实调用：读 key、
// 发请求、解析返回。档位 flash/pro → model id；thinking 作为对象透传。
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
  ToolCall,
  ToolSchema,
} from "./types";

export const TIER_TO_MODEL_ID: Record<ModelTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const TOOL_ARGUMENT_PREVIEW_CHARS = 200;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type ThinkingConfig = { readonly type: "enabled" | "disabled" };
type ParsedToolArgs =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: string };

export interface DeepSeekAdapterOptions {
  /** 显式 key；缺省时从 env.DEEPSEEK_API_KEY 读。 */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** 注入环境（测试用）；默认 process.env。 */
  readonly env?: Record<string, string | undefined>;
  /** 注入 fetch（测试用）；默认全局 fetch。 */
  readonly fetchImpl?: FetchImpl;
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

function resolveModelId(model: ModelTier): string {
  return TIER_TO_MODEL_ID[model] ?? model;
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

function buildRequestBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolveModelId(req.model),
    thinking: thinkingConfig(req.thinking),
    messages: req.messages.map((message) => serializeMessage(message)),
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
  }

  return body;
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

  constructor(options: DeepSeekAdapterOptions = {}) {
    const env = options.env ?? process.env;
    const apiKey = options.apiKey ?? env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "缺少 DEEPSEEK_API_KEY：请在环境变量（或 .sandcastle/.env）中配置 DeepSeek 密钥。",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ??
      env.DEEPSEEK_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(req)),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DeepSeek 请求失败 (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = choice?.finish_reason ?? "stop";
    const toolCalls = msg?.tool_calls ?? [];

    // ── Native tool_calls path ──────────────────────────────────────────
    if (finishReason === "tool_calls" && toolCalls.length > 0) {
      return {
        content: msg?.content ?? "",
        stop: false,
        finishReason: "tool_calls",
        toolCalls: toolCalls.map((toolCall) => parseToolCall(toolCall)),
      };
    }

    // ── Text-only path ─────────────────────────────────────────────────
    const content = msg?.content;
    if (typeof content !== "string") {
      throw new Error("DeepSeek 返回缺少 choices[0].message.content");
    }

    return { content, stop: true, finishReason };
  }
}

/** Re-export ToolSchema for consumers that wire tool schemas. */
export type { ToolSchema };
