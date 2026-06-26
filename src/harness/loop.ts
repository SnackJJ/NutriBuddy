// ① Loop：turn 循环 + MAX_STEPS 上限 + 可中断（PRD §4）。本切片无工具 / 检索 /
// 记忆 / Verifier——真实 adapter 单步即终，循环结构与 MAX_STEPS 闸为后续工具切片
// 预留：emit 工具调用的步骤会返回 stop=false，把对话推进到下一步。

import { assembleContext, DEFAULT_SYSTEM_PROMPT } from "./contextAssembler";
import type { ChatMessage, ModelAdapter, ModelTier } from "./types";
import type { Tracer } from "./tracer";
import { EventLog } from "./eventLog";
import {
  buildPreGateContext,
  checkPostGate,
  type UserContext,
} from "./gate";
import type { DrugNutrientInteraction, InteractionStore } from "../lib/drugInteractions";

export const MAX_STEPS = 8;
/** Post-gate 最大重试次数（issue #10）。 */
const MAX_POST_GATE_RETRIES = 2;

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
  /** Pre/post-gate：用户安全上下文（过敏 + 用药）。缺省时不启用 gate。 */
  readonly userContext?: UserContext;
  /** Pre/post-gate：药物-营养素相互作用数据源。userContext 存在时需传入。 */
  readonly interactionStore?: InteractionStore;
}

export interface TurnResult {
  readonly reply: string;
  readonly steps: number;
}

function renderPrompt(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
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

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
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
    userContext,
    interactionStore,
  } = input;

  tracer.record({ step: 0, type: "user_input", payload: userInput });
  eventLog?.record({ type: "user_message", data: { content: userInput } });

  // ─── Pre-gate：构建 pinned region，注入系统提示词 ─────────────────
  let interactions: DrugNutrientInteraction[] = [];
  let effectiveSystemPrompt = systemPrompt;

  if (userContext && interactionStore) {
    const gateCtx = await buildPreGateContext(userContext, interactionStore);
    if (gateCtx.pinnedRegion) {
      effectiveSystemPrompt = `${systemPrompt}\n\n${gateCtx.pinnedRegion}`;
    }
    // 预取交互规则，供 post-gate 复用（避免每次重试都重新查询）
    if (userContext.medications.length > 0) {
      const { getInteractions } = await import("../lib/drugInteractions");
      interactions = await getInteractions(
        [...userContext.medications],
        interactionStore,
      );
    }
  }

  // working set 随步骤增长：本切片无工具不会增长，预留给后续工具结果回灌。
  const working: ChatMessage[] = [...history];
  let reply = "";
  let postGateRetries = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      eventLog?.record({ type: "error", data: { reason: "aborted", step } });
      throw new Error(`turn aborted before step ${step}`);
    }

    const messages = assembleContext({
      systemPrompt: effectiveSystemPrompt,
      history: working,
      userInput,
    });
    tracer.record({ step, type: "model_prompt", payload: renderPrompt(messages) });
    eventLog?.record({
      type: "model_call",
      data: { step, model: tier, thinking, systemPrompt: effectiveSystemPrompt },
    });

    const response = await adapter.generate({
      model: tier,
      thinking,
      messages,
    });
    tracer.record({ step, type: "model_return", payload: response.content });

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
          return { reply: gateExhaustedReply(check.reasons), steps: step };
        }
      }

      eventLog?.record({
        type: "agent_response",
        data: { content: response.content, step },
      });
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
  eventLog?.record({
    type: "error",
    data: { reason: "max_steps_reached", maxSteps, step: maxSteps },
  });
  return { reply, steps: maxSteps };
}
