// ① Loop：ReAct 循环（Thought→Act→Observe）+ MAX_STEPS 上限 + 可中断
// （PRD §4 / §2.2）。
//
// run() 是主体：async generator 在每个 turn 边界产出 AgentEvent，
// 调用方（CLI / Next.js route / 测试）可逐事件消费。runTurn() 是
// 同步收集的便捷包装，兼容既有调用方。
//
// Issue #41：工具调用切换到原生 DeepSeek/OpenAI 协议：
//   - 模型 assistant 消息携带 tool_calls[]（非 [tool_call] 伪标签）
//   - 工具结果以 role:"tool" + tool_call_id 回灌（非 [tool_result] 伪标签）
//   - 多条 tool_calls 在同一响应中按序 dispatch

import {
  assembleContext,
  assemblePinnedRegion,
  buildTemplatePromptSection,
  DEFAULT_SYSTEM_PROMPT,
  type PinnedRegion,
} from "./contextAssembler";
import type {
  AgentEvent,
  ChatMessage,
  ModelAdapter,
  ModelTier,
  TerminalResult,
  ToolCall,
  ToolCallDelta,
  ToolHandler,
  ToolResult,
  ToolSchema,
} from "./types";
import type { Tracer } from "./tracer";
import { EventLog } from "./eventLog";
import { buildPreGateContext, checkPostGate, type UserContext } from "./gate";
import type { InteractionStore } from "../lib/drugInteractions";
import type { QueryCatalog } from "../catalog/queryCatalog";

/** 默认最大步数（issue #10 上调以留出 gate 重试余量）。 */
export const MAX_STEPS = 8;
/** Post-gate 最大重试次数（issue #10）。 */
const MAX_POST_GATE_RETRIES = 2;
const QUERY_CATALOG_TOOL = "query_catalog";
const CODE_ACT_TOOL = "code_act";

// ─── Tool argument schema validation (issue #45) ─────────────────────────
//
// Validates model-supplied arguments against the tool's declared JSON Schema
// (from ToolSchema.function.parameters). The provider's strict schema mode is
// Beta-only and unreliable; this harness-side check ensures arguments conform
// before dispatch. Returns null on success, or an error message on failure.

interface PropertyDef {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly description?: string;
}

interface SchemaParams {
  readonly type?: string;
  readonly properties?: Record<string, PropertyDef>;
  readonly required?: readonly string[];
}

function validateArgs(
  args: Readonly<Record<string, unknown>>,
  schema: ToolSchema,
): string | null {
  const params = schema.function.parameters as SchemaParams;

  // Required fields
  const required = params.required ?? [];
  for (const key of required) {
    if (!(key in args)) {
      const missing = required.filter((k) => !(k in args));
      return `missing required argument(s): ${missing.join(", ")}`;
    }
  }

  // Property types and enum constraints
  const properties = params.properties ?? {};
  for (const [key, value] of Object.entries(args)) {
    const propDef = properties[key];
    if (!propDef) continue; // extra properties are forwarded (lenient)

    const propType = propDef.type;
    if (propType === "string" && typeof value !== "string") {
      return `argument "${key}" must be a string, got ${typeof value}`;
    }
    if (propType === "number" && typeof value !== "number") {
      // JSON Schema "number" accepts both JS number and integer
      return `argument "${key}" must be a number, got ${typeof value}`;
    }
    if (propType === "boolean" && typeof value !== "boolean") {
      return `argument "${key}" must be a boolean, got ${typeof value}`;
    }

    // Enum constraint
    if (propDef.enum && propDef.enum.length > 0) {
      if (!propDef.enum.includes(value)) {
        const allowed = propDef.enum.map(String).join(", ");
        return `argument "${key}" value "${String(value)}" not in allowed enum: [${allowed}]`;
      }
    }
  }

  return null;
}

/**
 * Dispatch a tool call: validate args against the declared schema, then
 * invoke the handler. Returns the result and whether the dispatch was valid.
 */
async function dispatchTool(
  toolCall: ToolCall,
  tools: ReadonlyMap<string, ToolHandler> | undefined,
  toolSchemas: readonly ToolSchema[] | undefined,
  tracer: Tracer,
  step: number,
): Promise<ToolResult> {
  const schema = toolSchemas?.find(
    (s) => s.function.name === toolCall.name,
  );

  // Record tool_call trace event for scorer visibility
  tracer.record({
    step,
    type: "tool_call",
    payload: JSON.stringify({
      name: toolCall.name,
      args: toolCall.args,
    }),
  });

  // Unknown tool
  const handler = tools?.get(toolCall.name);
  if (!handler) {
    const errorMsg = `tool "${toolCall.name}" not found — no handler registered`;
    return { name: toolCall.name, result: errorMsg, dispatchError: true };
  }

  // Schema validation (only when a schema is declared)
  if (schema) {
    const validationError = validateArgs(toolCall.args, schema);
    if (validationError) {
      const errorMsg = `argument validation failed for "${toolCall.name}": ${validationError}`;
      return { name: toolCall.name, result: errorMsg, dispatchError: true };
    }
  }

  // Valid dispatch: call handler
  const result = await handler(toolCall.args);
  return { name: toolCall.name, result };
}

export interface RunTurnInput {
  readonly userInput: string;
  /**
   * Authenticated user identity bound by the caller.
   * It is kept outside model-visible input; scoped tools must use this
   * caller-bound value instead of accepting identity from model args.
   */
  readonly userId?: string;
  readonly adapter: ModelAdapter;
  readonly tracer: Tracer;
  readonly eventLog?: EventLog;
  readonly history?: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly tier?: ModelTier;
  readonly thinking?: boolean;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
  /** 工具调度表：工具名 → 处理器。未注册的工具调用记录 act 事件后静默跳过。 */
  readonly tools?: ReadonlyMap<string, ToolHandler>;
  /** Native function-calling tool schemas sent to the model API (issue #41). */
  readonly toolSchemas?: readonly ToolSchema[];
  /** Pre/post-gate：用户安全上下文（过敏 + 用药）。缺省时不启用 gate。 */
  readonly userContext?: UserContext;
  /** Pre/post-gate：药物-营养素相互作用数据源。userContext 存在时需传入。 */
  readonly interactionStore?: InteractionStore;
  /** Typed query catalog：reviewed template signatures for prompt injection. */
  readonly queryCatalog?: QueryCatalog;
}

export type TurnResult = TerminalResult;

function renderPrompt(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

function toToolCallDelta(toolCall: ToolCall): ToolCallDelta {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args),
    },
  };
}

function createAssistantToolCallMessage(
  content: string,
  toolCalls: readonly ToolCall[],
): ChatMessage {
  return {
    role: "assistant",
    content: content || "",
    tool_calls: toolCalls.map((toolCall) => toToolCallDelta(toolCall)),
  };
}

function createToolResultMessage(
  toolCall: ToolCall,
  result: string,
): ChatMessage {
  return {
    role: "tool",
    content: result,
    tool_call_id: toolCall.id,
  };
}

/** Post-gate 重试耗尽后的兜底回复。 */
function gateExhaustedReply(reasons: readonly string[]): string {
  const list = reasons.map((r) => `  - ${r}`).join("\n");
  return (
    "I cannot safely answer your question. My responses were blocked " +
    `after ${MAX_POST_GATE_RETRIES} retries due to safety constraints:\n${list}\n\n` +
    "Please consult a doctor or registered dietitian for personalized advice."
  );
}

/**
 * ReAct 循环的主体：async generator，在每个可观测节点产出 AgentEvent。
 *
 * 事件序（每步）：
 *   thought → [act → observe]×N → observe
 *
 * 终止时返回 TerminalResult。
 */
export async function* run(
  input: RunTurnInput,
): AsyncGenerator<AgentEvent, TerminalResult, undefined> {
  const {
    userInput,
    adapter,
    tracer,
    eventLog,
    history = [],
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tier = "flash",
    thinking = true,
    maxSteps = MAX_STEPS,
    signal,
    tools,
    toolSchemas,
    userContext,
    interactionStore,
    queryCatalog,
  } = input;

  tracer.record({ step: 0, type: "user_input", payload: userInput });
  eventLog?.record({ type: "user_message", data: { content: userInput } });

  // Expose reviewed template signatures only when a template-aware tool exists.
  const hasTemplateAwareTool =
    tools?.has(QUERY_CATALOG_TOOL) || tools?.has(CODE_ACT_TOOL);
  const templateSection = hasTemplateAwareTool
    ? buildTemplatePromptSection(queryCatalog)
    : undefined;
  const gateCtx =
    userContext && interactionStore
      ? await buildPreGateContext(userContext, interactionStore)
      : null;

  const interactions = gateCtx?.interactions ?? [];

  // 工具定义：从 tools Map 提取名称作为可用工具列表
  const toolDefs =
    tools && tools.size > 0
      ? [...tools.keys()].map((name) => ({
          name,
          description: `Callable tool: ${name}`,
        }))
      : undefined;

  // 构建 pinned region（AOT，跨轮字节稳定，最大化 prompt cache 命中）
  const pinned: PinnedRegion = {
    systemPrompt,
    userProfile: gateCtx?.pinnedRegion || undefined,
    sqlTemplates: templateSection,
    toolDefs,
  };

  // working set 随步骤增长：工具结果回灌为 tool 消息，未交卷的模型产出
  // 回灌为 assistant 消息。
  const working: ChatMessage[] = [...history];
  let reply = "";
  let postGateRetries = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      eventLog?.record({ type: "error", data: { reason: "aborted", step } });
      throw new Error(`turn aborted before step ${step}`);
    }

    // ── Thought ──────────────────────────────────────────────────────
    const messages = assembleContext({
      pinned,
      history: working,
      userInput,
    });
    tracer.record({
      step,
      type: "model_prompt",
      payload: renderPrompt(messages),
    });
    eventLog?.record({
      type: "model_call",
      data: {
        step,
        model: tier,
        thinking,
        systemPrompt: assemblePinnedRegion(pinned),
      },
    });

    yield { type: "thought", step };

    // ── Act ──────────────────────────────────────────────────────────
    const response = await adapter.generate({
      model: tier,
      thinking,
      messages,
      tools: toolSchemas,
    });
    tracer.record({ step, type: "model_return", payload: response.content });

    if (response.toolCalls && response.toolCalls.length > 0) {
      working.push(
        createAssistantToolCallMessage(response.content, response.toolCalls),
      );

      for (const tc of response.toolCalls) {
        yield { type: "act", step, toolCall: tc };

        const toolResult = await dispatchTool(
          tc,
          tools,
          toolSchemas,
          tracer,
          step,
        );

        yield {
          type: "observe",
          step,
          toolResult,
        };

        working.push(
          createToolResultMessage(tc, toolResult.result),
        );
      }
      // 工具调用后继续循环（不在此步交卷）
      continue;
    }

    // ── Observe ──────────────────────────────────────────────────────
    yield { type: "observe", step, content: response.content };

    reply = response.content;

    if (response.stop) {
      // ─── Post-gate：检查输出是否违反硬约束 ──────────────────────
      if (userContext && interactionStore) {
        const check = checkPostGate(reply, userContext, interactions);

        if (!check.passed) {
          eventLog?.record({
            type: "gate_block",
            data: {
              attempt: postGateRetries + 1,
              maxRetries: MAX_POST_GATE_RETRIES,
              reasons: check.reasons,
              blockedContent: reply,
              step,
            },
          });

          if (postGateRetries < MAX_POST_GATE_RETRIES) {
            postGateRetries++;
            // 将违规回复和 block 反馈回灌为上下文，要求模型重新生成
            const reasonList = check.reasons.map((r) => `  - ${r}`).join("\n");
            const retryFeedback =
              `Your previous response was BLOCKED by safety constraints:\n${reasonList}\n\n` +
              `Please regenerate your response. Make absolutely sure you do NOT mention ` +
              `or recommend any of the blocked foods or allergens listed above. ` +
              `This is a hard safety requirement.`;

            working.push({ role: "assistant", content: reply });
            working.push({ role: "user", content: retryFeedback });
            tracer.record({
              step,
              type: "gate_block",
              payload: `Post-gate blocked (attempt ${postGateRetries}/${MAX_POST_GATE_RETRIES}): ${check.reasons.join("; ")}`,
            });
            continue;
          }

          // 重试耗尽：返回兜底回复
          eventLog?.record({
            type: "agent_response",
            data: {
              content: gateExhaustedReply(check.reasons),
              step,
              gateExhausted: true,
            },
          });
          tracer.record({
            step,
            type: "gate_exhausted",
            payload: `Post-gate retries exhausted after ${MAX_POST_GATE_RETRIES} attempts.`,
          });
          return {
            reply: gateExhaustedReply(check.reasons),
            steps: step,
            stopReason: "gate_blocked",
          };
        }
      }

      eventLog?.record({
        type: "agent_response",
        data: { content: response.content, step },
      });
      return {
        reply,
        steps: step,
        stopReason: "end_turn",
        output: response.output,
      };
    }

    // 模型未交卷且无工具调用：将其产出回灌为历史，继续下一步
    working.push({ role: "assistant", content: response.content });
  }

  // MAX_STEPS 撞上限
  tracer.record({
    step: maxSteps,
    type: "max_steps_reached",
    payload: `已达 MAX_STEPS=${maxSteps}，强制停止。`,
  });
  eventLog?.record({
    type: "error",
    data: { reason: "max_steps_reached", maxSteps, step: maxSteps },
  });
  return { reply, steps: maxSteps, stopReason: "max_steps" };
}

/**
 * run() 的便捷包装：收集所有事件，返回 TurnResult。
 * 兼容 loop 的既有调用方（CLI、测试）。
 */
export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const gen = run(input);
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}
