// ② ContextAssembler（极简切片）：把 system prompt + 对话历史 + 本轮用户输入
// 拼成发给模型的 message 列表。本切片不接 memory / 检索 / compaction（后续切片再叠）。

import type { ChatMessage } from "./types";

export const DEFAULT_SYSTEM_PROMPT =
  "你是 NutriBuddy，一个谨慎、循证的个人营养顾问。";

export interface AssembleInput {
  readonly systemPrompt: string;
  readonly history: readonly ChatMessage[];
  readonly userInput: string;
}

export function assembleContext(input: AssembleInput): ChatMessage[] {
  return [
    { role: "system", content: input.systemPrompt },
    ...input.history,
    { role: "user", content: input.userInput },
  ];
}
