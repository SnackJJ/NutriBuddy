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
  TypedOutput,
} from "./types";
import type { Tracer } from "./tracer";
import { EventLog } from "./eventLog";
import { buildPreGateContext, checkPostGate, type UserContext } from "./gate";
import type {
  DrugNutrientInteraction,
  InteractionStore,
} from "../lib/drugInteractions";
import type { QueryCatalog } from "../catalog/queryCatalog";
import { SUBMIT_ANSWER_TOOL, parseSubmitAnswerArgs } from "./submitAnswer";

/** 默认最大步数（issue #10 上调以留出 gate 重试余量）。 */
export const MAX_STEPS = 8;
/** Post-gate 最大重试次数（issue #10）。 */
const MAX_POST_GATE_RETRIES = 2;
const QUERY_CATALOG_TOOL = "query_catalog";
const CODE_ACT_TOOL = "code_act";

interface ToolPropertySchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly description?: string;
}

interface ToolParameterSchema {
  readonly type?: string;
  readonly properties?: Record<string, ToolPropertySchema>;
  readonly required?: readonly string[];
}

function validateArgType(
  name: string,
  value: unknown,
  expectedType: string | undefined,
): string | null {
  switch (expectedType) {
    case "string":
      return typeof value === "string"
        ? null
        : `argument "${name}" must be a string, got ${typeof value}`;
    case "number":
      return typeof value === "number"
        ? null
        : `argument "${name}" must be a number, got ${typeof value}`;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `argument "${name}" must be a boolean, got ${typeof value}`;
    default:
      return null;
  }
}

function validateEnumValue(
  name: string,
  value: unknown,
  allowedValues: readonly unknown[] | undefined,
): string | null {
  if (!allowedValues || allowedValues.length === 0) {
    return null;
  }

  if (allowedValues.includes(value)) {
    return null;
  }

  const allowed = allowedValues.map(String).join(", ");
  return `argument "${name}" value "${String(value)}" not in allowed enum: [${allowed}]`;
}

function validateArgs(
  args: Readonly<Record<string, unknown>>,
  schema: ToolSchema,
): string | null {
  const params = schema.function.parameters as ToolParameterSchema;

  const required = params.required ?? [];
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    return `missing required argument(s): ${missing.join(", ")}`;
  }

  const properties = params.properties ?? {};
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (!property) {
      continue;
    }

    const typeError = validateArgType(name, value, property.type);
    if (typeError) {
      return typeError;
    }

    const enumError = validateEnumValue(name, value, property.enum);
    if (enumError) {
      return enumError;
    }
  }

  return null;
}

function toolDispatchError(name: string, result: string): ToolResult {
  return { name, result, dispatchError: true };
}

async function dispatchTool(
  toolCall: ToolCall,
  tools: ReadonlyMap<string, ToolHandler> | undefined,
  toolSchemas: readonly ToolSchema[] | undefined,
  tracer: Tracer,
  step: number,
): Promise<ToolResult> {
  const schema = toolSchemas?.find((s) => s.function.name === toolCall.name);

  tracer.record({
    step,
    type: "tool_call",
    payload: JSON.stringify({
      name: toolCall.name,
      args: toolCall.args,
    }),
  });

  const handler = tools?.get(toolCall.name);
  if (!handler) {
    return toolDispatchError(
      toolCall.name,
      `tool "${toolCall.name}" not found — no handler registered`,
    );
  }

  if (schema) {
    const validationError = validateArgs(toolCall.args, schema);
    if (validationError) {
      return toolDispatchError(
        toolCall.name,
        `argument validation failed for "${toolCall.name}": ${validationError}`,
      );
    }
  }

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

type PostGateDecision =
  | { readonly kind: "pass" }
  | {
      readonly kind: "retry";
      readonly retryCount: number;
      readonly reasons: readonly string[];
      readonly feedback: string;
    }
  | { readonly kind: "refuse"; readonly reply: string };

interface CheckTerminalPostGateInput {
  readonly reply: string;
  readonly step: number;
  readonly retryCount: number;
  readonly userContext: UserContext | undefined;
  readonly interactionStore: InteractionStore | undefined;
  readonly interactions: readonly DrugNutrientInteraction[];
  readonly eventLog: EventLog | undefined;
  readonly tracer: Tracer;
}

function formatGateReasons(reasons: readonly string[]): string {
  return reasons.map((reason) => `  - ${reason}`).join("\n");
}

function createPostGateRetryFeedback(reasons: readonly string[]): string {
  return (
    `Your previous response was BLOCKED by safety constraints:\n${formatGateReasons(reasons)}\n\n` +
    `Please regenerate your response. Make absolutely sure you do NOT mention ` +
    `or recommend any of the blocked foods or allergens listed above. ` +
    `This is a hard safety requirement.`
  );
}

function createPostGateBlockPayload(
  retryCount: number,
  reasons: readonly string[],
): string {
  return `Post-gate blocked (attempt ${retryCount}/${MAX_POST_GATE_RETRIES}): ${reasons.join("; ")}`;
}

function createBlockedToolResult(reasons: readonly string[]): string {
  return `BLOCKED: ${reasons.join("; ")}`;
}

function describeSubmitAnswerResult(output: TypedOutput | null): string {
  if (!output) {
    return "Answer submitted (prose-only fallback)";
  }

  return `Answer submitted with ${output.foodRefs.length} food ref(s) and ${output.ruleRefs.length} rule ref(s)`;
}

function checkTerminalPostGate(
  input: CheckTerminalPostGateInput,
): PostGateDecision {
  const {
    reply,
    step,
    retryCount,
    userContext,
    interactionStore,
    interactions,
    eventLog,
    tracer,
  } = input;

  if (!userContext || !interactionStore) {
    return { kind: "pass" };
  }

  const check = checkPostGate(reply, userContext, interactions);
  if (check.passed) {
    return { kind: "pass" };
  }

  eventLog?.record({
    type: "gate_block",
    data: {
      attempt: retryCount + 1,
      maxRetries: MAX_POST_GATE_RETRIES,
      reasons: check.reasons,
      blockedContent: reply,
      step,
    },
  });

  if (retryCount < MAX_POST_GATE_RETRIES) {
    const nextRetryCount = retryCount + 1;
    tracer.record({
      step,
      type: "gate_block",
      payload: createPostGateBlockPayload(nextRetryCount, check.reasons),
    });

    return {
      kind: "retry",
      retryCount: nextRetryCount,
      reasons: check.reasons,
      feedback: createPostGateRetryFeedback(check.reasons),
    };
  }

  const refusal = gateExhaustedReply(check.reasons);
  eventLog?.record({
    type: "agent_response",
    data: {
      content: refusal,
      step,
      gateExhausted: true,
    },
  });
  tracer.record({
    step,
    type: "gate_exhausted",
    payload: `Post-gate retries exhausted after ${MAX_POST_GATE_RETRIES} attempts.`,
  });

  return { kind: "refuse", reply: refusal };
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
      // ── Terminal: submit_answer ──────────────────────────────────
      const submitAnswerCall = response.toolCalls.find(
        (tc) => tc.name === SUBMIT_ANSWER_TOOL,
      );

      if (submitAnswerCall) {
        yield { type: "act", step, toolCall: submitAnswerCall };

        const output = parseSubmitAnswerArgs(submitAnswerCall.args);

        yield {
          type: "observe",
          step,
          toolResult: {
            name: SUBMIT_ANSWER_TOOL,
            result: describeSubmitAnswerResult(output),
          },
        };

        reply = output?.prose ?? response.content;

        const postGateDecision = checkTerminalPostGate({
          reply,
          step,
          retryCount: postGateRetries,
          userContext,
          interactionStore,
          interactions,
          eventLog,
          tracer,
        });

        if (postGateDecision.kind === "retry") {
          postGateRetries = postGateDecision.retryCount;
          working.push(
            createAssistantToolCallMessage(
              response.content,
              response.toolCalls,
            ),
          );
          working.push(
            createToolResultMessage(
              submitAnswerCall,
              createBlockedToolResult(postGateDecision.reasons),
            ),
          );
          working.push({ role: "user", content: postGateDecision.feedback });
          continue;
        }

        if (postGateDecision.kind === "refuse") {
          return {
            reply: postGateDecision.reply,
            steps: step,
            stopReason: "gate_blocked",
          };
        }

        eventLog?.record({
          type: "agent_response",
          data: { content: reply, step },
        });
        return {
          reply,
          steps: step,
          stopReason: "end_turn",
          output: output ?? undefined,
        };
      }

      // ── Regular tool dispatch ───────────────────────────────────
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

        working.push(createToolResultMessage(tc, toolResult.result));
      }
      // 工具调用后继续循环（不在此步交卷）
      continue;
    }

    // ── Observe ──────────────────────────────────────────────────────
    yield { type: "observe", step, content: response.content };

    reply = response.content;

    if (response.stop) {
      // ─── Post-gate：检查输出是否违反硬约束 ──────────────────────
      const postGateDecision = checkTerminalPostGate({
        reply,
        step,
        retryCount: postGateRetries,
        userContext,
        interactionStore,
        interactions,
        eventLog,
        tracer,
      });

      if (postGateDecision.kind === "retry") {
        postGateRetries = postGateDecision.retryCount;
        working.push(
          { role: "assistant", content: reply },
          { role: "user", content: postGateDecision.feedback },
        );
        continue;
      }

      if (postGateDecision.kind === "refuse") {
        return {
          reply: postGateDecision.reply,
          steps: step,
          stopReason: "gate_blocked",
        };
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
