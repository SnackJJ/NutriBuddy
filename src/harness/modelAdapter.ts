// ⑧ ModelAdapter：唯一对外暴露 {model, thinking} 两旋钮的模块；换模型/换供应商
// 只动这里（CONTEXT.md / PRD §4）。本切片实现 DeepSeek V4 的真实调用：读 key、
// 发请求、解析返回。档位 flash/pro → model id；thinking 作为请求参数透传。

import type {
  ChatMessage,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelTier,
} from "./types";

export const TIER_TO_MODEL_ID: Record<ModelTier, string> = {
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

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
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
      body: JSON.stringify({
        model: TIER_TO_MODEL_ID[req.model],
        thinking: req.thinking,
        messages: req.messages.map((m: ChatMessage) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DeepSeek 请求失败 (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("DeepSeek 返回缺少 choices[0].message.content");
    }

    // 本切片无工具：模型一返回即终。stop 字段为后续工具切片预留。
    return { content, stop: true };
  }
}
