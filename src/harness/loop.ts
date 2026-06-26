// ① Loop：ReAct 循环（Thought→Act→Observe）+ MAX_STEPS 上限 + 可中断
// （PRD §4 / §2.2）。
//
// run() 是主体：async generator 在每个 turn 边界产出 AgentEvent，
// 调用方（CLI / Next.js route / 测试）可逐事件消费。runTurn() 是
// 同步收集的便捷包装，兼容既有调用方。
//
// 工具调用检测：模型产出 toolCalls 时，loop 通过注入的 tools Map
// dispatch 每条调用，将 tool_result 回灌为 user 消息后继续循环。

import { assembleContext, DEFAULT_SYSTEM_PROMPT } from "./contextAssembler";
import type {
  AgentEvent,
  ChatMessage,
  ModelAdapter,
  ModelTier,
  TerminalResult,
  ToolHandler,
} from "./types";
import type { Tracer } from "./tracer";
import { EventLog } from "./eventLog";

/** 默认最大步数（PRD §2.2：M1 不拆分 Verifier，MAX_STEPS=5）。 */
export const MAX_STEPS = 5;

export interface RunTurnInput {
  readonly userInput: string;
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
}

export interface TurnResult {
  readonly reply: string;
  readonly steps: number;
}

function renderPrompt(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
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
  } = input;

  tracer.record({ step: 0, type: "user_input", payload: userInput });
  eventLog?.record({ type: "user_message", data: { content: userInput } });

  // working set 随步骤增长：工具结果回灌为 user 消息，未交卷的模型产出
  // 回灌为 assistant 消息。
  const working: ChatMessage[] = [...history];
  let reply = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      eventLog?.record({ type: "error", data: { reason: "aborted", step } });
      throw new Error(`turn aborted before step ${step}`);
    }

    // ── Thought ──────────────────────────────────────────────────────
    const messages = assembleContext({
      systemPrompt,
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
      data: { step, model: tier, thinking, systemPrompt },
    });

    yield { type: "thought", step };

    // ── Act ──────────────────────────────────────────────────────────
    const response = await adapter.generate({
      model: tier,
      thinking,
      messages,
    });
    tracer.record({ step, type: "model_return", payload: response.content });

    // 工具调用检测：模型产出 toolCalls → dispatch → 注入 tool_result
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        yield { type: "act", step, toolCall: tc };

        const handler = tools?.get(tc.name);
        const result = handler
          ? await handler(tc.args)
          : `tool "${tc.name}" not found — no handler registered`;

        yield {
          type: "observe",
          step,
          toolResult: { name: tc.name, result },
        };

        // 将工具调用与结果回灌为对话历史，供下一步模型感知
        working.push({
          role: "assistant",
          content: `[tool_call] ${tc.name}(${JSON.stringify(tc.args)})`,
        });
        working.push({
          role: "user",
          content: `[tool_result] ${result}`,
        });
      }
      // 工具调用后继续循环（不在此步交卷）
      continue;
    }

    // ── Observe ──────────────────────────────────────────────────────
    yield { type: "observe", step, content: response.content };

    reply = response.content;
    if (response.stop) {
      eventLog?.record({
        type: "agent_response",
        data: { content: response.content, step },
      });
      return { reply, steps: step, stopReason: "end_turn" };
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
  let it = await gen.next();
  while (!it.done) {
    it = await gen.next();
  }
  const terminal = it.value as TerminalResult;
  return { reply: terminal.reply, steps: terminal.steps };
}
