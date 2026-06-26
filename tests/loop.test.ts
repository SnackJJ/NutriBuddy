import { describe, it, expect, vi } from "vitest";
import { runTurn } from "../src/harness/loop";
import { Tracer } from "../src/harness/tracer";
import { EventLog, type LogEvent } from "../src/harness/eventLog";
import { fixedDeps } from "./helpers/eventLog";
import type { UserContext } from "../src/harness/gate";
import type {
  DrugNutrientInteraction,
  InteractionStore,
} from "../src/lib/drugInteractions";
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

  it("records user_message → model_call → agent_response in a single-step turn", async () => {
    const tracer = new Tracer();
    const { sink, deps } = fixedDeps();
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
    const events: LogEvent[] = sink.writes
      .map((w) => JSON.parse(w.line));
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
    const events: LogEvent[] = sink.writes
      .map((w) => JSON.parse(w.line));
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

    const events: LogEvent[] = sink.writes
      .map((w) => JSON.parse(w.line));
    const gateBlocks = events.filter((e) => e.type === "gate_block");
    expect(gateBlocks).toHaveLength(1);
    const reason = (gateBlocks[0].data.reasons as string[])[0];
    expect(reason).toContain("kale");
    expect(reason).toContain("warfarin");
  });
});
