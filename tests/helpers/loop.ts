import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  AgentEvent,
  TerminalResult,
} from "../../src/harness/types";

/** 用函数实现快速构造 ModelAdapter，适合单测 stub。 */
export function stubAdapter(
  impl: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

/**
 * 收集 AsyncGenerator 中的所有 AgentEvent 及最终 TerminalResult，
 * 便于单测断言。
 */
export async function collect(
  gen: AsyncGenerator<AgentEvent, TerminalResult, undefined>,
): Promise<{ events: AgentEvent[]; result: TerminalResult }> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}
