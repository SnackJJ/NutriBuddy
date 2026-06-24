// 八模块共享的窄类型。本切片只用到 Loop / ContextAssembler / ModelAdapter / Tracer
// 所需的最小子集；工具 / 检索 / 记忆 / Verifier 的类型留到各自切片再加。

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/** 模型档位旋钮：能力/成本（见 CONTEXT.md「Model tier」）。 */
export type ModelTier = "flash" | "pro";

/**
 * ModelAdapter 对外暴露的两个旋钮（CONTEXT.md）：
 * - `model`：档位 flash/pro
 * - `thinking`：思考模式开关，与档位正交
 * 本切片固定单模型、不路由，调用方一般只传 flash。
 */
export interface ModelKnobs {
  readonly model: ModelTier;
  readonly thinking: boolean;
}

export interface ModelRequest extends ModelKnobs {
  readonly messages: readonly ChatMessage[];
}

export interface ModelResponse {
  readonly content: string;
  /**
   * 是否就此交卷。本切片无工具，真实 adapter 恒为 true（单步即终）；
   * 字段为后续工具切片预留：emit 工具调用的步骤会返回 false 以请求下一步。
   */
  readonly stop: boolean;
}

export interface ModelAdapter {
  generate(req: ModelRequest): Promise<ModelResponse>;
}
