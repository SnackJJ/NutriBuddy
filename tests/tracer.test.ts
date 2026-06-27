import { describe, it, expect } from "vitest";
import { Tracer } from "../src/harness/tracer";

describe("Tracer", () => {
  it("records events in order with an increasing sequence number", () => {
    const tracer = new Tracer();
    tracer.record({ step: 1, type: "user_input", payload: "hi" });
    tracer.record({ step: 1, type: "model_return", payload: "hello" });

    const events = tracer.events();
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events.map((e) => e.type)).toEqual(["user_input", "model_return"]);
  });

  it("renders a human-readable line per event for CLI/log viewing", () => {
    const tracer = new Tracer();
    tracer.record({
      step: 2,
      type: "model_prompt",
      payload: "system + history",
    });

    const text = tracer.render();
    expect(text).toContain("step 2");
    expect(text).toContain("model_prompt");
    expect(text).toContain("system + history");
  });

  it("returns a defensive copy so callers cannot mutate internal state", () => {
    const tracer = new Tracer();
    tracer.record({ step: 1, type: "user_input", payload: "x" });

    tracer.events().pop();
    expect(tracer.events()).toHaveLength(1);
  });
});
