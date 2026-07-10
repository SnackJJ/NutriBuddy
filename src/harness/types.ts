// 八模块共享的窄类型。本切片只用到 Loop / ContextAssembler / ModelAdapter / Tracer
// 所需的最小子集；工具 / 检索 / 记忆 / Verifier 的类型留到各自切片再加。

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI-compatible tool_call delta embedded in an assistant message. */
export interface ToolCallDelta {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string; // JSON string
  };
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Tool calls emitted by the assistant (OpenAI native format). */
  readonly tool_calls?: readonly ToolCallDelta[];
  /** Tool call ID for role: "tool" messages — matches the id in the assistant's tool_calls. */
  readonly tool_call_id?: string;
}

/** OpenAI function-calling tool schema sent to the model API. */
export interface ToolSchema {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
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
  /** Native function-calling tool schemas (OpenAI format). */
  readonly tools?: readonly ToolSchema[];
}

export interface ToolCall {
  /** Unique tool call id for matching role:"tool" responses. */
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly name: string;
  readonly result: string;
  /** true when the tool dispatch was invalid (unknown tool or schema mismatch). */
  readonly dispatchError?: boolean;
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
  /** Structured final answer data for gateable, auditable responses. */
  readonly output?: TypedOutput;
  /**
   * Raw finish_reason from the model API.
   * "stop" = model finished normally; "tool_calls" = model wants to call tools;
   * "length" = token limit reached.
   */
  readonly finishReason?: string;
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
export const STOP_REASONS = [
  "end_turn",
  "max_steps",
  "aborted",
  "gate_blocked",
  "write_proposal",
  "crash",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Write-proposal payload carried in the terminal event when the turn ends
 * with stopReason "write_proposal" (issue #36 / PRD v2 §3.4 / ADD §Tools).
 *
 * Contains the resolved food entities and nutrition computed server-side,
 * representing the immutable proposal bytes the user must confirm.
 */
export interface WriteProposalData {
  readonly proposalId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly kcal?: number;
  readonly proteinG?: number;
  readonly fatG?: number;
  readonly carbsG?: number;
  readonly nutritionSource: string;
  readonly createdAt: string;
}

/** Async generator 的最终返回。 */
export interface TerminalResult {
  readonly reply: string;
  readonly steps: number;
  readonly stopReason: StopReason;
  /** Structured final answer data, when the model returned it. */
  readonly output?: TypedOutput;
  /**
   * Write-proposal payload carried when stopReason is "write_proposal".
   * Contains the resolved entities and confirmation payload (issue #36).
   */
  readonly proposal?: WriteProposalData;
}

/** 工具处理器：接收 args 返回字符串结果。 */
export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => Promise<string>;

// ── Typed final output contract (ADD §Loop / §Output gate) ──

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
 * Final answer contract: prose plus structured references that gates can
 * verify without parsing free text.
 */
export interface TypedOutput {
  readonly prose: string;
  readonly foodRefs: readonly FoodRef[];
  readonly ruleRefs: readonly RuleRef[];
}
