// ① Loop：ReAct 循环（Thought→Act→Observe）+ MAX_STEPS 上限 + 可中断
// （PRD §4 / §2.2）。
//
// run() is the ReAct loop body (async generator of AgentEvent).
// Public seam entry is turn()/consumeTurn (structural Phase 4 — runTurn removed).
//
// Issue #41：工具调用切换到原生 DeepSeek/OpenAI 协议：
//   - 模型 assistant 消息携带 tool_calls[]（非 [tool_call] 伪标签）
//   - 工具结果以 role:"tool" + tool_call_id 回灌（非 [tool_result] 伪标签）
//   - 多条 tool_calls 在同一响应中按序 dispatch
//
// Issue #47：输出 gate 已移至 turn 层统一执行。loop 不再自行 post-gate
//   重试，而是将词法 backstop、numeric provenance、advisory structure
//   全部交给 turn 边界的 consolidated output gate 处理。

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
  ModelCallUsageTracePayload,
  ModelAdapter,
  ModelTier,
  TerminalResult,
  ToolCall,
  ToolCallDelta,
  ToolHandler,
  ToolSchema,
  TypedOutput,
} from "./types";
import type { Tracer } from "./tracer";
import { EventLog } from "./eventLog";
import { buildPreGateContext, type UserContext } from "./gate";
import type { InteractionStore } from "../lib/drugInteractions";
import type { QueryCatalog } from "../catalog/queryCatalog";
import { SUBMIT_ANSWER_TOOL, parseSubmitAnswerArgs } from "./submitAnswer";
import { computeCostUsd } from "./modelAdapter";
import {
  deriveToolResult,
  INFRA_ERROR_PUBLIC_CAUSE,
  isToolOutcomePayloadSerializable,
  normalizeLegacyToolResult,
  projectTypedOutput,
  type ToolOutcome,
} from "./toolOutcome";

/** 默认最大步数（issue #10 上调以留出 gate 重试余量）。 */
export const MAX_STEPS = 8;

/**
 * Ceilings that stop a turn which is not making progress (issue #126).
 *
 * The live baselines produced the case for these: a model that already had the
 * observation it needed kept calling `query_catalog` with slightly different
 * arguments until MAX_STEPS was spent — 20 to 24 calls, tens of seconds, and an
 * empty reply. The identical-call guard above cannot see it, because the
 * arguments differ; the signal that is missing is *novelty*.
 *
 * So two counters, both about information rather than repetition:
 *   * a step whose calls return nothing the turn has not already seen is a
 *     stale step; `STALE_STEPS_BEFORE_NUDGE` consecutive ones mean the model is
 *     not learning anything more;
 *   * `MAX_TOOL_CALLS` bounds the pathological case where every step does return
 *     something new but the turn still never converges.
 *
 * When either trips, tool dispatch stops for the rest of the turn and the model
 * is told why and what to do instead. A refusal to execute is the honest form:
 * continuing to spend money on calls that cannot change the answer is not a
 * service to the caller.
 */
export const STALE_STEPS_BEFORE_NUDGE = 2;
export const MAX_TOOL_CALLS = 16;
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

async function dispatchTool(
  toolCall: ToolCall,
  tools: ReadonlyMap<string, ToolHandler> | undefined,
  toolSchemas: readonly ToolSchema[] | undefined,
): Promise<ToolOutcome> {
  const name = toolCall.name;
  const schema = toolSchemas?.find((s) => s.function.name === name);

  const handler = tools?.get(name);
  if (!handler) {
    return {
      kind: "dispatch_error",
      name,
      message: `tool "${name}" not found — no handler registered`,
    };
  }

  if (schema) {
    const validationError = validateArgs(toolCall.args, schema);
    if (validationError) {
      return {
        kind: "dispatch_error",
        name,
        message: `argument validation failed for "${name}": ${validationError}`,
      };
    }
  }

  try {
    const raw = await handler(toolCall.args);
    const outcome =
      typeof raw === "string"
        ? normalizeLegacyToolResult(name, raw)
        : ({ ...raw, name } as ToolOutcome);
    if (
      (outcome.kind === "ok" ||
        outcome.kind === "typed_miss" ||
        outcome.kind === "typed_error") &&
      !isToolOutcomePayloadSerializable(
        outcome.data,
        outcome.kind === "ok" ? outcome.observation : undefined,
        outcome.kind === "typed_miss" ? outcome.candidates : undefined,
      )
    ) {
      return {
        kind: "infra_error",
        name,
        cause: INFRA_ERROR_PUBLIC_CAUSE,
      };
    }
    return outcome;
  } catch {
    return {
      kind: "infra_error",
      name,
      cause: INFRA_ERROR_PUBLIC_CAUSE,
    };
  }
}

function observeFromOutcome(step: number, outcome: ToolOutcome): AgentEvent {
  return {
    type: "observe",
    step,
    toolOutcome: outcome,
    toolResult: deriveToolResult(outcome),
  };
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
  /** Injected clock port（ADD §Testing Seam）；latency 从这里读，缺省为系统时钟。 */
  readonly clock?: () => Date;
  /**
   * Input-gate directive injected on utterance conflict hits (issue #53 /
   * ADD §Gates)：refuse-and-cite for prescriptive asks, advise for
   * descriptive mentions. Rides the dynamic region alongside the user
   * input — the pinned region stays byte-stable.
   */
  readonly inputDirective?: string;
  /** Pinned evidence text for this turn (RFC 0011 §3.7); see `evidenceSet`. */
  readonly evidenceText?: string;
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

/**
 * Whether this outcome carries something the turn has not seen before.
 *
 * Compared by serialized payload, which is what the model itself would have to
 * compare; two calls that return the same bytes are the same fact however
 * different their arguments were.
 */
function isNovelOutcome(outcome: ToolOutcome, seen: Set<string>): boolean {
  if (outcome.kind !== "ok") return false;
  const serialized = JSON.stringify(outcome.data);
  if (seen.has(serialized)) return false;
  seen.add(serialized);
  return true;
}

/** Identity of a tool call as the model made it: name plus exact arguments. */
function callSignature(toolCall: ToolCall): string {
  return `${toolCall.name}${JSON.stringify(toolCall.args)}`;
}

/** The human-readable reason a failed call gave, for the repeat guidance. */
function describeFailure(outcome: ToolOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return "";
    case "infra_error":
      return outcome.cause;
    default:
      return outcome.message;
  }
}

/**
 * What the model is told when it repeats a call that already failed.
 *
 * It names the previous failure and asks for a decision, because the
 * alternative — dispatching again — trades a new observation for the same one,
 * at the caller's expense.
 */
function repeatGuidance(name: string, previous: string, count: number): string {
  return (
    `Repeated call: "${name}" was already called with these exact arguments and failed ` +
    `(${previous}). This is repeat #${count}. Do not send it again: change the ` +
    "arguments so the call can succeed, or answer without it."
  );
}

function submitAnswerOutcome(output: TypedOutput | null): ToolOutcome {
  if (!output) {
    return { kind: "ok", name: SUBMIT_ANSWER_TOOL, data: null };
  }
  const data = projectTypedOutput(output);
  if (!isToolOutcomePayloadSerializable(data)) {
    return {
      kind: "infra_error",
      name: SUBMIT_ANSWER_TOOL,
      cause: INFRA_ERROR_PUBLIC_CAUSE,
    };
  }
  return { kind: "ok", name: SUBMIT_ANSWER_TOOL, data };
}

/**
 * ReAct 循环的主体：async generator，在每个可观测节点产出 AgentEvent。
 *
 * 事件序（每步）：
 *   thought → [act → observe]×N → observe
 *
 * 终止时返回 TerminalResult。
 *
 * Issue #47: 输出 gate 已从上移至 turn 层。loop 不再自行 post-gate
 * 重试——词法 backstop、numeric provenance、advisory structure 全部
 * 由 turn 边界的 consolidated output gate 统一处理。loop 返回
 * replies 和 interactions（供 lexical backstop 使用），不做拦截。
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
    clock,
    inputDirective,
    evidenceText,
  } = input;

  const nowMs = clock ? () => clock().getTime() : () => Date.now();
  const modelUserInput = inputDirective
    ? `${userInput}\n\n${inputDirective}`
    : userInput;

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
    // Evidence text is assembled by the caller (it owns the corpus) and rides the
    // pinned region; absent means this turn may cite nothing, which the citation
    // gate enforces rather than trusting.
    evidence: evidenceText,
  };

  // working set 随步骤增长：工具结果回灌为 tool 消息，未交卷的模型产出
  // 回灌为 assistant 消息。
  const working: ChatMessage[] = [...history];
  /**
   * Tool calls that failed this turn, keyed by name + exact arguments, and how
   * many times the model has since repeated each one. Both are per-turn: a new
   * turn is a new chance to call anything.
   */
  const failedCalls = new Map<string, string>();
  const repeats = new Map<string, number>();
  /** Observation payloads seen this turn, for the novelty check below. */
  const seenObservations = new Set<string>();
  let toolCallsMade = 0;
  let staleSteps = 0;
  let dispatchStopped: string | null = null;
  let reply = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      eventLog?.record({ type: "error", data: { reason: "aborted", step } });
      throw new Error(`turn aborted before step ${step}`);
    }

    // ── Thought ──────────────────────────────────────────────────────
    const messages = assembleContext({
      pinned,
      history: working,
      userInput: modelUserInput,
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
    const callStart = nowMs();
    const response = await adapter.generate({
      model: tier,
      thinking,
      messages,
      tools: toolSchemas,
    });
    const latencyMs = nowMs() - callStart;

    tracer.record({ step, type: "model_return", payload: response.content });

    const usagePayload: ModelCallUsageTracePayload = {
      model: tier,
      thinking,
      latencyMs,
      usage: response.usage ?? null,
      costUsd: response.usage ? computeCostUsd(tier, response.usage) : null,
    };

    tracer.record({
      step,
      type: "model_call_usage",
      payload: JSON.stringify(usagePayload),
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      // ── Terminal: submit_answer ──────────────────────────────────
      const submitAnswerCall = response.toolCalls.find(
        (tc) => tc.name === SUBMIT_ANSWER_TOOL,
      );

      if (submitAnswerCall) {
        yield { type: "act", step, toolCall: submitAnswerCall };

        const output = parseSubmitAnswerArgs(submitAnswerCall.args);
        const outcome = submitAnswerOutcome(output);

        yield observeFromOutcome(step, outcome);

        if (outcome.kind === "infra_error") {
          return {
            reply:
              "Something went wrong while running a tool. Please try again.",
            steps: step,
            stopReason: "crash",
            interactions,
          };
        }

        reply = output?.prose ?? response.content;

        // Issue #47: 不再在 loop 内做 post-gate 重试。
        // 词法 backstop 交给 turn 层的 consolidated output gate。
        eventLog?.record({
          type: "agent_response",
          data: { content: reply, step },
        });
        return {
          reply,
          steps: step,
          stopReason: "end_turn",
          output: output ?? undefined,
          interactions,
        };
      }

      // ── Regular tool dispatch ───────────────────────────────────
      working.push(
        createAssistantToolCallMessage(response.content, response.toolCalls),
      );

      let newFactsThisStep = false;

      for (const tc of response.toolCalls) {
        yield { type: "act", step, toolCall: tc };

        if (dispatchStopped !== null) {
          // Already decided that more calls cannot help. Saying so costs one
          // message and saves the rest of the step's calls.
          working.push(
            createToolResultMessage(tc, `${dispatchStopped} Answer with submit_answer.`),
          );
          continue;
        }

        // A call this turn already made with the same arguments, after it
        // failed, is answered with that failure instead of being dispatched
        // again. Live runs made the case for this: a model that misses a
        // required parameter re-sent the identical call until MAX_STEPS was
        // spent, paying for every retry and never seeing a new fact — the
        // failure message was already in the conversation, so repeating the
        // same request could not produce anything else.
        const signature = callSignature(tc);
        const previous = failedCalls.get(signature);
        if (previous !== undefined) {
          repeats.set(signature, (repeats.get(signature) ?? 0) + 1);
          working.push(
            createToolResultMessage(
              tc,
              repeatGuidance(tc.name, previous, repeats.get(signature) ?? 1),
            ),
          );
          continue;
        }

        const outcome = await dispatchTool(tc, tools, toolSchemas);
        toolCallsMade += 1;

        if (outcome.kind !== "ok") {
          failedCalls.set(signature, describeFailure(outcome));
        } else if (isNovelOutcome(outcome, seenObservations)) {
          newFactsThisStep = true;
        }

        yield observeFromOutcome(step, outcome);

        working.push(
          createToolResultMessage(tc, deriveToolResult(outcome).result),
        );

        // RFC 0002 §2.5: stop remaining tool calls; no later model step
        if (outcome.kind === "infra_error") {
          return {
            reply:
              "Something went wrong while running a tool. Please try again.",
            steps: step,
            stopReason: "crash",
            interactions,
          };
        }
      }

      // ── Progress check (issue #126) ──────────────────────────────
      //
      // Judged per step, not per call: a step is what the model gets to react to,
      // and a step that learned nothing is the unit of "spinning".
      const callsThisStep = response.toolCalls.length;
      if (dispatchStopped === null && callsThisStep > 0) {
        staleSteps = newFactsThisStep ? 0 : staleSteps + 1;
        if (staleSteps >= STALE_STEPS_BEFORE_NUDGE) {
          dispatchStopped =
            "No new information came back from the last tool calls, so more calls cannot change the answer.";
        } else if (toolCallsMade >= MAX_TOOL_CALLS) {
          dispatchStopped = `This turn has already made ${toolCallsMade} tool calls without finishing.`;
        }
        if (dispatchStopped !== null) {
          working.push({
            role: "system",
            content: `${dispatchStopped} Use the observations you already have and call submit_answer with your final answer now.`,
          });
        }
      }

      // 工具调用后继续循环（不在此步交卷）
      continue;
    }

    // ── Observe ──────────────────────────────────────────────────────
    yield { type: "observe", step, content: response.content };

    reply = response.content;

    if (response.stop) {
      // Issue #47: 不再在 loop 内做 post-gate 重试。
      // 词法 backstop 交给 turn 层的 consolidated output gate。
      eventLog?.record({
        type: "agent_response",
        data: { content: response.content, step },
      });
      return {
        reply,
        steps: step,
        stopReason: "end_turn",
        output: response.output,
        interactions,
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
  return { reply, steps: maxSteps, stopReason: "max_steps", interactions };
}


