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
  ToolCall,
  ToolSchema,
} from "./types";

export const TIER_TO_MODEL_ID: Record<string, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

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
    readonly tool_calls?: ReadonlyArray<{
      readonly id?: string;
      readonly type?: string;
      readonly function?: {
        readonly name?: string;
        readonly arguments?: string;
      };
    }>;
  };
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<ChatCompletionChoice>;
}

function parseToolArgs(
  argsStr: string,
): Readonly<Record<string, unknown>> | string {
  try {
    const parsed: unknown = JSON.parse(argsStr);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, unknown>>;
    }
    return `tool call arguments is not a JSON object: ${argsStr.slice(0, 200)}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `[JSON parse error in tool call arguments] ${message}: ${argsStr.slice(0, 200)}`;
  }
}

function parseFinishReason(choice: ChatCompletionChoice): string {
  return choice.finish_reason ?? "stop";
}

/**
 * Serialize a ChatMessage for the OpenAI/DeepSeek API.
 *
 * Handles three message shapes:
 *   1. Plain system/user/assistant messages → {role, content}
 *   2. Assistant messages with tool_calls → {role, content, tool_calls}
 *   3. Tool result messages → {role, content, tool_call_id}
 */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role };

  // role: "tool" messages carry tool_call_id instead of content (though content is also present)
  if (m.role === "tool" && m.tool_call_id) {
    base.content = m.content;
    base.tool_call_id = m.tool_call_id;
    return base;
  }

  base.content = m.content;

  // Assistant messages with native tool_calls
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    base.tool_calls = m.tool_calls;
  }

  return base;
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
    const body: Record<string, unknown> = {
      model: TIER_TO_MODEL_ID[req.model] ?? req.model,
      thinking: { type: req.thinking ? "enabled" : "disabled" },
      messages: req.messages.map((m) => serializeMessage(m)),
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
    }

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DeepSeek 请求失败 (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const finishReason = choice ? parseFinishReason(choice) : "stop";

    // ── Native tool_calls path ──────────────────────────────────────────
    if (finishReason === "tool_calls" && msg?.tool_calls && msg.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = msg.tool_calls.map((tc) => {
        const name = tc.function?.name ?? "unknown";
        const argsStr = tc.function?.arguments ?? "{}";
        const parsed = parseToolArgs(argsStr);

        if (typeof parsed === "string") {
          // Parse error → surface as typed observation, not a crash
          return {
            id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            name,
            args: { _parse_error: parsed },
          };
        }

        return {
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          name,
          args: parsed,
        };
      });

      return {
        content: msg.content ?? "",
        stop: false,
        finishReason: "tool_calls",
        toolCalls,
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
