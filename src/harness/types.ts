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

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly name: string;
  readonly result: string;
}

export interface ModelResponse {
  readonly content: string;
  /**
   * 是否就此交卷。true = 模型已给出最终答案；false = 模型还在中间推理
   * （发出了工具调用，或需要额外步骤）。为工具切片预留。
   */
  readonly stop: boolean;
  /** 模型发出的工具调用列表；M1 adapter 暂不产出，由 loop 的测试 stub 驱动。 */
  readonly toolCalls?: readonly ToolCall[];
  /** Typed final output contract (issue #30 / ADD §Loop). When present,
   *  carries structured FoodRefs and RuleRefs alongside prose for gateable,
   *  auditable final answers. */
  readonly output?: TypedOutput;
}

export interface ModelAdapter {
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** ReAct 循环中每一步的可观测事件。 */
export type AgentEventType = "thought" | "act" | "observe";

export interface AgentEvent {
  readonly type: AgentEventType;
  readonly step: number;
  /** thought / observe 的文本内容。 */
  readonly content?: string;
  /** act 的工具调用。 */
  readonly toolCall?: ToolCall;
  /** observe 的工具返回。 */
  readonly toolResult?: ToolResult;
}

/** ReAct 循环终止原因。 */
export type StopReason = "end_turn" | "max_steps" | "aborted" | "gate_blocked" | "crash";

/** Async generator 的最终返回。 */
export interface TerminalResult {
  readonly reply: string;
  readonly steps: number;
  readonly stopReason: StopReason;
  /** Typed final output contract (issue #30 / ADD §Loop). Present when
   *  the model returned structured FoodRefs and RuleRefs. */
  readonly output?: TypedOutput;
}

/** 工具处理器：接收 args 返回字符串结果。 */
export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Promise<string>;

// ── Typed Final Output Contract (issue #30 / ADD §Loop / §Output gate) ──

/** A catalog-validated food reference included in a recommendation. */
export interface FoodRef {
  readonly foodId: string;
  readonly foodName: string;
  readonly matchType: "exact" | "alias" | "fuzzy";
  /** FDA big-9 allergen tags; undefined means tags not yet reviewed (loggable, not recommendable). */
  readonly allergens?: readonly string[];
}

/** An advisory rule reference citing the matched safety rule. */
export interface RuleRef {
  readonly ruleId: string;
  readonly summary: string;
}

/**
 * Typed final output contract: prose plus structured recommendation
 * FoodRefs and advisory RuleRefs. Free prose is unauditable; typed
 * fields are gateable (ADD §Loop line 35, §Output gate line 67).
 */
export interface TypedOutput {
  readonly prose: string;
  readonly foodRefs: readonly FoodRef[];
  readonly ruleRefs: readonly RuleRef[];
}
