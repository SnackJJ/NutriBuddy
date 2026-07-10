import { describe, it, expect, vi } from "vitest";
import { run, runTurn } from "../src/harness/loop";
import { Tracer } from "../src/harness/tracer";
import { EventLog, type LogEvent } from "../src/harness/eventLog";
import { fixedDeps } from "./helpers/eventLog";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
  AgentEvent,
  TerminalResult,
} from "../src/harness/types";
import type { UserContext } from "../src/harness/gate";
import type {
  DrugNutrientInteraction,
  InteractionStore,
} from "../src/lib/drugInteractions";

function stubAdapter(
  impl: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

/**
 * Collect all AgentEvents from the async generator and return them along
 * with the TerminalResult.
 */
async function collect(
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

describe("run", () => {
  it("yields thought → observe and returns stopReason=end_turn for a single-step turn", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({
      content: "约 6 克蛋白质",
      stop: true,
    }));

    const { events, result } = await collect(
      run({ userInput: "一个鸡蛋多少蛋白质？", adapter, tracer }),
    );

    expect(result.reply).toBe("约 6 克蛋白质");
    expect(result.steps).toBe(1);
    expect(result.stopReason).toBe("end_turn");

    // Should yield at least thought + observe
    const types = events.map((e) => e.type);
    expect(types).toContain("thought");
    expect(types).toContain("observe");

    // observe carries the model content
    const obs = events.find((e) => e.type === "observe");
    expect(obs?.content).toBe("约 6 克蛋白质");
  });

  it("enforces MAX_STEPS=8 and returns stopReason=max_steps", async () => {
    const tracer = new Tracer();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls += 1;
      return { content: `step ${calls}`, stop: false };
    });

    const { events, result } = await collect(
      run({ userInput: "go", adapter, tracer }),
    );

    // Default MAX_STEPS is 8
    expect(calls).toBe(8);
    expect(result.steps).toBe(8);
    expect(result.stopReason).toBe("max_steps");
    expect(result.reply).toBe("step 8");

    // Each step yields thought + observe
    const thoughtCount = events.filter((e) => e.type === "thought").length;
    expect(thoughtCount).toBe(8);
  });

  it("can override maxSteps via input", async () => {
    const tracer = new Tracer();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls += 1;
      return { content: `step ${calls}`, stop: false };
    });

    const { result } = await collect(
      run({ userInput: "go", adapter, tracer, maxSteps: 3 }),
    );

    expect(calls).toBe(3);
    expect(result.steps).toBe(3);
    expect(result.stopReason).toBe("max_steps");
  });

  it("detects tool calls, dispatches through the tools map, and injects results", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount += 1;
      if (callCount === 1) {
        // First call: model emits a tool call
        return {
          content: "我需要查一下鸡蛋的营养数据。",
          stop: false,
          toolCalls: [
            {
              id: "call-1",
              name: "search_food",
              args: { food: "egg" },
            } satisfies ToolCall,
          ],
        };
      }
      // Second call: model gives final answer after seeing tool result
      return { content: "鸡蛋含有约 6g 蛋白质。", stop: true };
    });

    const searchResults: string[] = [];
    const tools = new Map([
      [
        "search_food",
        async (args: Readonly<Record<string, unknown>>) => {
          const food = String(args.food);
          searchResults.push(food);
          return `${food}: 6g protein per large egg`;
        },
      ],
    ]);

    const { events, result } = await collect(
      run({ userInput: "鸡蛋营养？", adapter, tracer, tools }),
    );

    expect(result.reply).toBe("鸡蛋含有约 6g 蛋白质。");
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    expect(searchResults).toEqual(["egg"]);

    // Event flow: thought → act → observe → thought → observe
    const types = events.map((e) => e.type);
    expect(types).toEqual(["thought", "act", "observe", "thought", "observe"]);

    // act carries the tool call
    const act = events.find((e) => e.type === "act");
    expect(act?.toolCall).toMatchObject({
      name: "search_food",
      args: { food: "egg" },
    });

    // observe carries the tool result
    const obs = events.find((e) => e.type === "observe" && e.toolResult);
    expect(obs?.toolResult).toMatchObject({
      name: "search_food",
      result: "egg: 6g protein per large egg",
    });
  });

  it("skips tool dispatch for unknown tool names (no-op, continues loop)", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "尝试调用不存在的工具。",
          stop: false,
          toolCalls: [
            { id: "call-1", name: "nonexistent", args: {} } satisfies ToolCall,
          ],
        };
      }
      return { content: "fallback answer", stop: true };
    });

    // Empty tools map — no handler for "nonexistent"
    const tools = new Map<
      string,
      (args: Readonly<Record<string, unknown>>) => Promise<string>
    >();

    const { events, result } = await collect(
      run({ userInput: "q", adapter, tracer, tools }),
    );

    expect(result.reply).toBe("fallback answer");
    expect(result.steps).toBe(2);

    // act is still emitted, but observe has empty toolResult for unknown tools
    const act = events.find((e) => e.type === "act");
    expect(act?.toolCall?.name).toBe("nonexistent");
  });

  it("continues the loop when model returns stop=false without tool calls", async () => {
    const tracer = new Tracer();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls += 1;
      return calls === 1
        ? { content: "thinking step 1", stop: false }
        : { content: "final answer", stop: true };
    });

    const { events, result } = await collect(
      run({ userInput: "go", adapter, tracer }),
    );

    expect(result.reply).toBe("final answer");
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("end_turn");

    // First observe has the intermediate content
    const observeEvents = events.filter((e) => e.type === "observe");
    expect(observeEvents[0].content).toBe("thinking step 1");
    expect(observeEvents[1].content).toBe("final answer");
  });

  it("traces user input, model prompts, and model returns", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "hi back", stop: true }));

    await collect(run({ userInput: "hi", adapter, tracer }));

    const types = tracer.events().map((e) => e.type);
    expect(types).toContain("user_input");
    expect(types).toContain("model_prompt");
    expect(types).toContain("model_return");
  });

  it("records EventLog entries (user_message, model_call, agent_response)", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-run", deps);
    const adapter = stubAdapter(() => ({
      content: "约 6 克蛋白质",
      stop: true,
    }));

    await collect(
      run({ userInput: "一个鸡蛋多少蛋白质？", adapter, tracer, eventLog }),
    );

    const logged: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(logged.map((e) => e.type)).toEqual([
      "user_message",
      "model_call",
      "agent_response",
    ]);
    expect(logged[0].data).toEqual({ content: "一个鸡蛋多少蛋白质？" });
  });

  it("records error event in EventLog when MAX_STEPS is exhausted", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-max", deps);
    const adapter = stubAdapter(() => ({ content: "not done", stop: false }));

    await collect(
      run({ userInput: "go", adapter, tracer, eventLog, maxSteps: 3 }),
    );

    const logged: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(logged.map((e) => e.type)).toEqual([
      "user_message",
      "model_call",
      "model_call",
      "model_call",
      "error",
    ]);
    expect(logged[4].data).toMatchObject({
      reason: "max_steps_reached",
      maxSteps: 3,
    });
  });

  it("is interruptible via AbortSignal before the model is called", async () => {
    const tracer = new Tracer();
    const generate = vi.fn(async () => ({ content: "x", stop: true }));
    const controller = new AbortController();
    controller.abort();

    const gen = run({
      userInput: "q",
      adapter: { generate },
      tracer,
      signal: controller.signal,
    });

    await expect(gen.next()).rejects.toThrow(/abort/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("records error event on abort", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-abort", deps);
    const generate = vi.fn(async () => ({ content: "x", stop: true }));
    const controller = new AbortController();
    controller.abort();

    const gen = run({
      userInput: "q",
      adapter: { generate },
      tracer,
      eventLog,
      signal: controller.signal,
    });

    await expect(gen.next()).rejects.toThrow(/abort/i);

    const logged: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(logged.map((e) => e.type)).toEqual(["user_message", "error"]);
  });

  it("does not blow up when eventLog is not provided (backward compat)", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    const { result } = await collect(run({ userInput: "hi", adapter, tracer }));
    expect(result.reply).toBe("ok");
  });

  it("weaves caller-supplied history into the model prompt", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    await collect(
      run({
        userInput: "and how much in two eggs?",
        adapter,
        tracer,
        history: [
          { role: "user", content: "PRIOR-Q-protein in one egg" },
          { role: "assistant", content: "PRIOR-A-about 6 grams" },
        ],
      }),
    );

    const prompt =
      tracer.events().find((e) => e.type === "model_prompt")?.payload ?? "";
    expect(prompt).toContain("PRIOR-Q-protein in one egg");
    expect(prompt).toContain("PRIOR-A-about 6 grams");
  });

  it("passes model+thinking knobs through to the adapter", async () => {
    const tracer = new Tracer();
    const generate = vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(
      async () => ({ content: "x", stop: true }),
    );

    await collect(
      run({
        userInput: "q",
        adapter: { generate },
        tracer,
        tier: "flash",
        thinking: true,
      }),
    );

    expect(generate).toHaveBeenCalledOnce();
    const req = generate.mock.calls[0][0];
    expect(req.model).toBe("flash");
    expect(req.thinking).toBe(true);
  });

  it("feeds tool results as user messages into subsequent steps", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "查询中...",
          stop: false,
          toolCalls: [
            {
              id: "call-1",
              name: "calc",
              args: { expr: "1+1" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "结果是 2", stop: true };
    });

    const tools = new Map([["calc", async () => "2"]]);

    await collect(run({ userInput: "计算", adapter, tracer, tools }));

    // Step 2's prompt must contain the tool result from step 1
    const prompts = tracer.events().filter((e) => e.type === "model_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1].payload).toContain("2");
  });

  // ─── Native tool call protocol (issue #41) ──────────────────────────

  it("injects tool results as role:tool messages with matching tool_call_id", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const capturedMessages: Array<Array<Record<string, unknown>>> = [];
    const adapter = stubAdapter((req) => {
      callCount += 1;
      // Capture messages sent to the adapter for inspection
      capturedMessages.push(
        req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          tool_call_id: m.tool_call_id,
          hasToolCalls: !!(m.tool_calls && m.tool_calls.length > 0),
        })),
      );

      if (callCount === 1) {
        return {
          content: "查询中...",
          stop: false,
          toolCalls: [
            {
              id: "call-abc",
              name: "calc",
              args: { expr: "1+1" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "结果是 2", stop: true };
    });

    const tools = new Map([["calc", async () => "2"]]);

    await collect(run({ userInput: "计算", adapter, tracer, tools }));

    // Step 2's messages must contain the tool result from step 1
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2);

    // The second model call's messages should include:
    // - An assistant message with tool_calls (from step 1)
    // - A tool result message with matching tool_call_id
    const step2Messages = capturedMessages[1];
    const assistantMsg = step2Messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.hasToolCalls).toBe(true);

    const toolMsgs = step2Messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool_call_id).toBe("call-abc");
    expect(toolMsgs[0].content).toContain("2");
  });

  it("emits no [tool_call] or [tool_result] text in the prompt", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: "查询中...",
          stop: false,
          toolCalls: [
            {
              id: "call-1",
              name: "search",
              args: { q: "egg" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "鸡蛋有 6g 蛋白质。", stop: true };
    });

    const tools = new Map([["search", async () => "6g protein"]]);

    await collect(run({ userInput: "鸡蛋营养？", adapter, tracer, tools }));

    // Verify no fake-text markers in any prompt
    for (const e of tracer.events()) {
      if (e.type === "model_prompt") {
        expect(e.payload).not.toContain("[tool_call]");
        expect(e.payload).not.toContain("[tool_result]");
      }
    }
  });

  it("handles multiple tool_calls in one response as an array, dispatched in order", async () => {
    const tracer = new Tracer();
    const dispatchOrder: string[] = [];
    const adapter = stubAdapter(() => {
      const calls: ToolCall[] = [
        { id: "call-a", name: "tool_a", args: { order: 1 } },
        { id: "call-b", name: "tool_b", args: { order: 2 } },
        { id: "call-c", name: "tool_c", args: { order: 3 } },
      ];
      return {
        content: "调用多个工具...",
        stop: false,
        toolCalls: calls,
      };
    });

    const tools = new Map([
      [
        "tool_a",
        async (args: Readonly<Record<string, unknown>>) => {
          dispatchOrder.push(`a:${args.order}`);
          return "a-result";
        },
      ],
      [
        "tool_b",
        async (args: Readonly<Record<string, unknown>>) => {
          dispatchOrder.push(`b:${args.order}`);
          return "b-result";
        },
      ],
      [
        "tool_c",
        async (args: Readonly<Record<string, unknown>>) => {
          dispatchOrder.push(`c:${args.order}`);
          return "c-result";
        },
      ],
    ]);

    await collect(
      run({ userInput: "test multi", adapter, tracer, tools, maxSteps: 1 }),
    );

    // All three dispatched, in order
    expect(dispatchOrder).toEqual(["a:1", "b:2", "c:3"]);

    // Verify event flow: thought → act → observe × 3
    const types = tracer.events().map((e) => e.type);
    expect(types).toContain("user_input");
    expect(types).toContain("model_prompt");
    expect(types).toContain("model_return");
  });

  it("passes toolSchemas to the adapter when provided", async () => {
    const generate = vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(
      async () => ({ content: "ok", stop: true }),
    );

    const toolSchemas = [
      {
        type: "function" as const,
        function: {
          name: "log_meal",
          description: "Log a meal",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    await collect(
      run({
        userInput: "q",
        adapter: { generate },
        tracer: new Tracer(),
        toolSchemas,
      }),
    );

    expect(generate).toHaveBeenCalledOnce();
    const req = generate.mock.calls[0][0];
    expect(req.tools).toEqual(toolSchemas);
  });

  it("does not pass tools to the adapter when toolSchemas is absent (backward compat)", async () => {
    const generate = vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(
      async () => ({ content: "ok", stop: true }),
    );

    await collect(
      run({
        userInput: "q",
        adapter: { generate },
        tracer: new Tracer(),
      }),
    );

    const req = generate.mock.calls[0][0];
    expect(req.tools).toBeUndefined();
  });

  it("generates fallback tool_call_id for tool calls without explicit id", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const capturedMessages: Array<Array<Record<string, unknown>>> = [];
    const adapter = stubAdapter((req) => {
      callCount += 1;
      capturedMessages.push(
        req.messages.map((m) => ({
          role: m.role,
          tool_call_id: m.tool_call_id,
        })),
      );

      if (callCount === 1) {
        // Legacy ToolCall without explicit id
        return {
          content: "查询中...",
          stop: false,
          toolCalls: [
            {
              id: "adapter-gen-id",
              name: "calc",
              args: { expr: "1+1" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "结果", stop: true };
    });

    const tools = new Map([["calc", async () => "2"]]);

    await collect(run({ userInput: "计算", adapter, tracer, tools }));

    // Tool result message should have a tool_call_id matching the adapter-generated id
    const step2Messages = capturedMessages[1];
    const toolMsgs = step2Messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool_call_id).toBe("adapter-gen-id");
  });
});

describe("runTurn (backward compat)", () => {
  it("runs one turn: assembles context, calls the model, returns the reply", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({
      content: "约 6 克蛋白质",
      stop: true,
    }));

    const result = await runTurn({
      userInput: "一个鸡蛋多少蛋白质？",
      adapter,
      tracer,
    });

    expect(result.reply).toBe("约 6 克蛋白质");
    expect(result.steps).toBe(1);
  });

  it("traces user input, the final prompt sent to the model, and the model return", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "hi back", stop: true }));

    await runTurn({ userInput: "hi", adapter, tracer });

    const types = tracer.events().map((e) => e.type);
    expect(types).toContain("user_input");
    expect(types).toContain("model_prompt");
    expect(types).toContain("model_return");

    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).toContain("hi");
  });

  it("passes the model+thinking knobs through to the adapter", async () => {
    const tracer = new Tracer();
    const generate = vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(
      async () => ({
        content: "x",
        stop: true,
      }),
    );

    await runTurn({
      userInput: "q",
      adapter: { generate },
      tracer,
      tier: "flash",
      thinking: true,
    });

    expect(generate).toHaveBeenCalledOnce();
    const req = generate.mock.calls[0][0];
    expect(req.model).toBe("flash");
    expect(req.thinking).toBe(true);
  });

  it("never exceeds MAX_STEPS when the model keeps requesting more steps", async () => {
    const tracer = new Tracer();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls += 1;
      return { content: `step ${calls}`, stop: false };
    });

    const result = await runTurn({
      userInput: "go",
      adapter,
      tracer,
      maxSteps: 3,
    });

    expect(calls).toBe(3);
    expect(result.steps).toBe(3);
    expect(tracer.events().map((e) => e.type)).toContain("max_steps_reached");
  });

  it("feeds an unfinished step's output back into the next step's prompt", async () => {
    const tracer = new Tracer();
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls += 1;
      return calls === 1
        ? { content: "STEP1-OUT", stop: false }
        : { content: "final", stop: true };
    });

    const result = await runTurn({
      userInput: "go",
      adapter,
      tracer,
      maxSteps: 3,
    });

    expect(result.reply).toBe("final");
    expect(result.steps).toBe(2);

    // step 2's prompt must carry step 1's output — proving the working set grows.
    const prompts = tracer.events().filter((e) => e.type === "model_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0].payload).not.toContain("STEP1-OUT");
    expect(prompts[1].payload).toContain("STEP1-OUT");
  });

  it("weaves caller-supplied history into the model prompt before the new input", async () => {
    // Multi-turn foundation: prior conversation must reach the model, in order,
    // ahead of this turn's user input. Guards loop.ts seeding working = [...history].
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    await runTurn({
      userInput: "and how much in two eggs?",
      adapter,
      tracer,
      history: [
        { role: "user", content: "PRIOR-Q-protein in one egg" },
        { role: "assistant", content: "PRIOR-A-about 6 grams" },
      ],
    });

    const prompt =
      tracer.events().find((e) => e.type === "model_prompt")?.payload ?? "";
    expect(prompt).toContain("PRIOR-Q-protein in one egg");
    expect(prompt).toContain("PRIOR-A-about 6 grams");
    // history precedes this turn's input
    expect(prompt.indexOf("PRIOR-A-about 6 grams")).toBeLessThan(
      prompt.indexOf("and how much in two eggs?"),
    );
  });

  it("is interruptible via an AbortSignal before the model is called", async () => {
    const tracer = new Tracer();
    const generate = vi.fn(async () => ({ content: "x", stop: true }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTurn({
        userInput: "q",
        adapter: { generate },
        tracer,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(generate).not.toHaveBeenCalled();
  });

  // ─── EventLog integration ──────────────────────────────────────────────

  it("records user_message → model_call → agent_response in a single-step turn", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-1", deps);
    const adapter = stubAdapter(() => ({
      content: "约 6 克蛋白质",
      stop: true,
    }));

    await runTurn({
      userInput: "一个鸡蛋多少蛋白质？",
      adapter,
      tracer,
      eventLog,
    });

    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "model_call",
      "agent_response",
    ]);

    // user_message carries the input
    expect(events[0].data).toEqual({ content: "一个鸡蛋多少蛋白质？" });
    // model_call carries step + model + thinking + systemPrompt
    expect(events[1].data).toMatchObject({
      step: 1,
      model: "flash",
      thinking: true,
    });
    expect(events[1].data.systemPrompt).toBeDefined();
    // agent_response carries the reply + step
    expect(events[2].data).toEqual({ content: "约 6 克蛋白质", step: 1 });

    // all go to one session file
    expect(sink.writes.every((w) => w.path === "traces/sess-1.jsonl")).toBe(
      true,
    );
  });

  it("records model_call per step then error when MAX_STEPS is exhausted", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-2", deps);
    const adapter = stubAdapter(() => ({ content: "not done", stop: false }));

    await runTurn({
      userInput: "go",
      adapter,
      tracer,
      eventLog,
      maxSteps: 3,
    });

    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "model_call",
      "model_call",
      "model_call",
      "error",
    ]);

    // step increments across model_call events
    expect(events[1].data.step).toBe(1);
    expect(events[2].data.step).toBe(2);
    expect(events[3].data.step).toBe(3);

    // terminal error event
    expect(events[4].data).toMatchObject({
      reason: "max_steps_reached",
      maxSteps: 3,
      step: 3,
    });
  });

  it("records error event on abort before model call", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-3", deps);
    const generate = vi.fn(async () => ({ content: "x", stop: true }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTurn({
        userInput: "q",
        adapter: { generate },
        tracer,
        eventLog,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);

    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    expect(events.map((e) => e.type)).toEqual(["user_message", "error"]);
    expect(events[1].data).toMatchObject({ reason: "aborted", step: 1 });
  });

  it("does not blow up when eventLog is not provided (backward compat)", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    // should not throw
    const result = await runTurn({ userInput: "hi", adapter, tracer });
    expect(result.reply).toBe("ok");
  });

  // ─── Pre-gate / Post-gate integration ─────────────────────────────────

  function fakeInteractionStore(
    rows: DrugNutrientInteraction[],
  ): InteractionStore {
    return { all: async () => rows };
  }

  const HIGH_SEVERITY_INTERACTIONS: DrugNutrientInteraction[] = [
    {
      drugName: "warfarin",
      nutrient: "vitamin K",
      foodExamples: ["kale", "spinach", "broccoli"],
      severity: "high",
      source: "NIH ODS",
    },
  ];

  it("injects pre-gate context into the system prompt when user context is provided", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "safe answer", stop: true }));

    await runTurn({
      userInput: "what should I eat?",
      adapter,
      tracer,
      userContext: { allergies: ["peanut"], medications: ["warfarin"] },
      interactionStore: fakeInteractionStore(HIGH_SEVERITY_INTERACTIONS),
    });

    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).toContain("peanut");
    expect(prompt?.payload).toContain("warfarin");
    expect(prompt?.payload).toContain("vitamin K");
    expect(prompt?.payload).toContain("SAFETY CONSTRAINT");
  });

  it("does not inject gate context when user context is absent (backward compat)", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "ok", stop: true }));

    await runTurn({ userInput: "hi", adapter, tracer });

    const prompt = tracer.events().find((e) => e.type === "model_prompt");
    expect(prompt?.payload).not.toContain("SAFETY CONSTRAINT");
  });

  it("post-gate: retries on block and returns clean response when model fixes it", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-gate-1", deps);

    // First call returns blocked content, second call returns safe content
    let calls = 0;
    const adapter = stubAdapter(() => {
      calls++;
      if (calls === 1) {
        return { content: "I recommend drinking milk daily.", stop: true };
      }
      return { content: "I recommend drinking water.", stop: true };
    });

    const result = await runTurn({
      userInput: "what should I drink?",
      adapter,
      tracer,
      eventLog,
      userContext: { allergies: ["milk"], medications: [] },
      interactionStore: fakeInteractionStore([]),
    });

    // Should return the clean (second) response
    expect(result.reply).toBe("I recommend drinking water.");

    // Should have gate_block event for the first (blocked) response
    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    const gateBlocks = events.filter((e) => e.type === "gate_block");
    expect(gateBlocks).toHaveLength(1);
    expect(gateBlocks[0].data).toMatchObject({
      attempt: 1,
      maxRetries: 2,
    });
    expect(gateBlocks[0].data.reasons).toBeDefined();

    // One agent_response for the clean (second) response;
    // the blocked first response is NOT recorded as agent_response.
    const responses = events.filter((e) => e.type === "agent_response");
    expect(responses).toHaveLength(1);
  });

  it("post-gate: returns fallback message after 2 retries exhausted", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-gate-2", deps);

    // Always returns blocked content
    const adapter = stubAdapter(() => ({
      content: "Drink more milk for calcium!",
      stop: true,
    }));

    const result = await runTurn({
      userInput: "how can I get more calcium?",
      adapter,
      tracer,
      eventLog,
      userContext: { allergies: ["milk"], medications: [] },
      interactionStore: fakeInteractionStore([]),
    });

    // Fallback: cannot safely answer
    expect(result.reply).toContain("cannot safely answer");

    // Should have 3 gate_block events: original + 2 retries all blocked
    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    const gateBlocks = events.filter((e) => e.type === "gate_block");
    expect(gateBlocks).toHaveLength(3);
    expect(gateBlocks[0].data.attempt).toBe(1);
    expect(gateBlocks[1].data.attempt).toBe(2);
    expect(gateBlocks[2].data.attempt).toBe(3);

    // One agent_response for the exhaustion fallback
    const responses = events.filter((e) => e.type === "agent_response");
    expect(responses).toHaveLength(1);
    expect(responses[0].data.gateExhausted).toBe(true);
  });

  it("post-gate: blocks on high-severity drug-nutrient conflict in output", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
    const eventLog = new EventLog("sess-gate-3", deps);

    let calls = 0;
    const adapter = stubAdapter(() => {
      calls++;
      if (calls === 1) {
        return {
          content: "A kale salad would be great for your health!",
          stop: true,
        };
      }
      return { content: "A cucumber salad is a safe choice.", stop: true };
    });

    const result = await runTurn({
      userInput: "what salad should I make?",
      adapter,
      tracer,
      eventLog,
      userContext: { allergies: [], medications: ["warfarin"] },
      interactionStore: fakeInteractionStore(HIGH_SEVERITY_INTERACTIONS),
    });

    expect(result.reply).toBe("A cucumber salad is a safe choice.");

    const events: LogEvent[] = sink.writes.map((w) => JSON.parse(w.line));
    const gateBlocks = events.filter((e) => e.type === "gate_block");
    expect(gateBlocks).toHaveLength(1);
    const reason = (gateBlocks[0].data.reasons as string[])[0];
    expect(reason).toContain("kale");
    expect(reason).toContain("warfarin");
  });
});
