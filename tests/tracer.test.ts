import { describe, it, expect } from "vitest";
import { buildTurnEventSink, Tracer } from "../src/harness/tracer";
import type { AnyTurnEvent } from "../src/harness/turn";

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

  it("builds renderable sink entries from turn events", () => {
    const baseEvent = {
      schema: "1.3.0",
      timestamp: "2026-07-05T12:00:00.000Z",
    };
    const events: AnyTurnEvent[] = [
      {
        ...baseEvent,
        seq: 0,
        type: "step",
        agentEvent: {
          type: "act",
          step: 2,
          toolCall: {
            id: "call-1",
            name: "search_food",
            args: { food: "chicken" },
          },
        },
      },
      {
        ...baseEvent,
        seq: 1,
        type: "gate_verdict",
        checkpoint: "output",
        verdict: "block",
        checkName: "post_gate_output_check",
        evidence: "blocked food",
      },
    ];

    expect(buildTurnEventSink(events, 3)).toEqual({
      toolCalls: [
        {
          step: 2,
          name: "search_food",
          args: { food: "chicken" },
        },
      ],
      gateBlocks: [
        {
          step: 3,
          evidence: "blocked food",
        },
      ],
    });
  });
});
