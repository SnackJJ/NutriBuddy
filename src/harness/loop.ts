// ① Loop：turn 循环 + MAX_STEPS 上限 + 可中断（PRD §4）。本切片无工具 / 检索 /
// 记忆 / Verifier——真实 adapter 单步即终，循环结构与 MAX_STEPS 闸为后续工具切片
// 预留：emit 工具调用的步骤会返回 stop=false，把对话推进到下一步。

import { assembleContext, DEFAULT_SYSTEM_PROMPT } from "./contextAssembler";
import type { ChatMessage, ModelAdapter, ModelTier } from "./types";
import type { Tracer } from "./tracer";

export const MAX_STEPS = 8;

export interface RunTurnInput {
  readonly userInput: string;
  readonly adapter: ModelAdapter;
  readonly tracer: Tracer;
  readonly history?: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly tier?: ModelTier;
  readonly thinking?: boolean;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly reply: string;
  readonly steps: number;
}

function renderPrompt(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    userInput,
    adapter,
    tracer,
    history = [],
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    tier = "flash",
    thinking = true,
    maxSteps = MAX_STEPS,
    signal,
  } = input;

  tracer.record({ step: 0, type: "user_input", payload: userInput });

  // working set 随步骤增长：本切片无工具不会增长，预留给后续工具结果回灌。
  const working: ChatMessage[] = [...history];
  let reply = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      throw new Error(`turn aborted before step ${step}`);
    }

    const messages = assembleContext({ systemPrompt, history: working, userInput });
    tracer.record({ step, type: "model_prompt", payload: renderPrompt(messages) });

    const response = await adapter.generate({ model: tier, thinking, messages });
    tracer.record({ step, type: "model_return", payload: response.content });

    reply = response.content;
    if (response.stop) {
      return { reply, steps: step };
    }

    // 未交卷：把模型产出回灌为历史，进入下一步。
    working.push({ role: "assistant", content: response.content });
  }

  tracer.record({
    step: maxSteps,
    type: "max_steps_reached",
    payload: `已达 MAX_STEPS=${maxSteps}，强制停止。`,
  });
  return { reply, steps: maxSteps };
}
