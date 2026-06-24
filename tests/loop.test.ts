import { describe, it, expect, vi } from "vitest";
import { runTurn } from "../src/harness/loop";
import { Tracer } from "../src/harness/tracer";
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
});
