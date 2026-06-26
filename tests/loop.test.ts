import { describe, it, expect, vi } from "vitest";
import { runTurn } from "../src/harness/loop";
import { Tracer } from "../src/harness/tracer";
import { EventLog, type LogEvent } from "../src/harness/eventLog";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../src/harness/types";

function stubAdapter(impl: (req: ModelRequest) => ModelResponse): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

describe("runTurn", () => {
  it("runs one turn: assembles context, calls the model, returns the reply", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "约 6 克蛋白质", stop: true }));

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
    const generate =
      vi.fn<(req: ModelRequest) => Promise<ModelResponse>>(async () => ({
        content: "x",
        stop: true,
      }));

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

    const result = await runTurn({ userInput: "go", adapter, tracer, maxSteps: 3 });

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

    const result = await runTurn({ userInput: "go", adapter, tracer, maxSteps: 3 });

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

    const prompt = tracer.events().find((e) => e.type === "model_prompt")?.payload ?? "";
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
      runTurn({ userInput: "q", adapter: { generate }, tracer, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(generate).not.toHaveBeenCalled();
  });

  // ─── EventLog integration ──────────────────────────────────────────────

  /** 内存版 append sink，收集 JSONL 写入便于断言。 */
  function memSink() {
    const writes: { path: string; line: string }[] = [];
    return {
      writes,
      append: (path: string, line: string) => writes.push({ path, line }),
    };
  }

  function eventLogTestDeps(sink = memSink()) {
    let n = 0;
    return {
      sink,
      deps: {
        append: sink.append,
        now: () => new Date("2026-06-26T00:00:00.000Z"),
        nextId: () => `evt_${n++}`,
      },
    };
  }

  it("records user_message → model_call → agent_response in a single-step turn", async () => {
    const tracer = new Tracer();
    const { sink, deps } = eventLogTestDeps();
    const eventLog = new EventLog("sess-1", deps);
    const adapter = stubAdapter(() => ({ content: "约 6 克蛋白质", stop: true }));

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
    expect(events[1].data).toMatchObject({ step: 1, model: "flash", thinking: true });
    expect(events[1].data.systemPrompt).toBeDefined();
    // agent_response carries the reply + step
    expect(events[2].data).toEqual({ content: "约 6 克蛋白质", step: 1 });

    // all go to one session file
    expect(sink.writes.every((w) => w.path === "traces/sess-1.jsonl")).toBe(true);
  });

  it("records model_call per step then error when MAX_STEPS is exhausted", async () => {
    const tracer = new Tracer();
    const { sink, deps } = eventLogTestDeps();
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
    const { sink, deps } = eventLogTestDeps();
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
});
