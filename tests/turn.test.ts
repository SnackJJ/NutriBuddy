import { describe, it, expect } from "vitest";
import {
  turn,
  SCHEMA_VERSION,
  type TurnInput,
  type TurnPorts,
  type AnyTurnEvent,
  type TurnResult,
} from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../src/harness/types";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stubAdapter(
  impl: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

/** Collect all events from the async generator and return them along with the result. */
async function collect(
  gen: AsyncGenerator<AnyTurnEvent, TurnResult, undefined>,
): Promise<{ events: AnyTurnEvent[]; result: TurnResult }> {
  const events: AnyTurnEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

function fixedClock(): () => Date {
  return () => new Date("2026-07-05T12:00:00.000Z");
}

// ─── Utterance Turn Tests ─────────────────────────────────────────────────

describe("turn (utterance)", () => {
  it("emits turn_start → steps → turn_end for a single-step utterance", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({
      content: "Eggs have about 6g of protein per large egg.",
      stop: true,
    }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "utterance",
      content: "How much protein in an egg?",
    };

    const { events, result } = await collect(turn(input, ports));

    // Event sequence: turn_start → step(thought) → step(observe) → turn_end
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("turn_start");
    expect(events[events.length - 1].type).toBe("turn_end");

    // Terminal result
    expect(result.reply).toBe("Eggs have about 6g of protein per large egg.");
    expect(result.steps).toBe(1);
    expect(result.stopReason).toBe("end_turn");
  });

  it("carries tagged input in the turn_start event", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "utterance",
      content: "What should I eat?",
    };

    const { events } = await collect(turn(input, ports));

    const start = events[0];
    expect(start.type).toBe("turn_start");
    // The turn_start event carries the input
    expect(start).toHaveProperty("input");
    const startWithInput = start as { input: TurnInput };
    expect(startWithInput.input).toEqual(input);
  });

  it("emits schema-versioned events with monotonic seq and timestamps", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const { events } = await collect(turn(input, ports));

    for (const event of events) {
      expect(event.schema).toBe(SCHEMA_VERSION);
      expect(typeof event.seq).toBe("number");
      expect(typeof event.timestamp).toBe("string");
    }

    // Monotonic seq
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // Fixed clock timestamp
    for (const event of events) {
      expect(event.timestamp).toBe("2026-07-05T12:00:00.000Z");
    }
  });

  it("exactly one terminal event: turn_end is always last", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "final", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = { tag: "utterance", content: "test" };

    const { events } = await collect(turn(input, ports));

    // Exactly one turn_end event
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);

    // It is the last event
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("turn_end");

    // turn_end carries the result
    expect(lastEvent).toHaveProperty("result");
    const endWithResult = lastEvent as { result: TurnResult };
    expect(endWithResult.result.reply).toBe("final");
    expect(endWithResult.result.stopReason).toBe("end_turn");
  });

  it("runs multiple steps and emits step events for each", async () => {
    const tracer = new Tracer();
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up nutrition data...",
          stop: false,
          toolCalls: [
            { name: "search_food", args: { food: "chicken" } } satisfies ToolCall,
          ],
        };
      }
      return {
        content: "Chicken breast has 31g protein per 100g.",
        stop: true,
      };
    });

    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);

    const ports: TurnPorts = {
      adapter,
      tracer,
      tools,
      clock: fixedClock(),
    };
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };

    const { events, result } = await collect(turn(input, ports));

    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("end_turn");

    // At least some step events
    const stepEvents = events.filter((e) => e.type === "step");
    expect(stepEvents.length).toBeGreaterThanOrEqual(3); // thought + act + observe

    // Exactly one turn_end
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
  });

  it("zero network access — stub adapter is used, no real fetch", async () => {
    // The entire test suite uses stub adapters. This test explicitly
    // documents that the turn seam does not initiate network calls.
    const tracer = new Tracer();
    let generateCalled = false;
    const adapter = stubAdapter(() => {
      generateCalled = true;
      return { content: "Safe reply.", stop: true };
    });

    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = { tag: "utterance", content: "testing" };

    const { events } = await collect(turn(input, ports));

    // The stub was called (not real network)
    expect(generateCalled).toBe(true);
    // Events emitted without network
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe("turn_end");
  });

  it("uses injected clock for all timestamps", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const clock = () => new Date("2026-01-01T00:00:00.000Z");
    const ports: TurnPorts = { adapter, tracer, clock };
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const { events } = await collect(turn(input, ports));

    for (const event of events) {
      expect(event.timestamp).toBe("2026-01-01T00:00:00.000Z");
    }
  });
});

// ─── Proposal Confirmation Turn Tests ─────────────────────────────────────

describe("turn (proposal_confirm)", () => {
  it("emits turn_start → turn_end for a confirmed proposal", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: true,
    };

    const { events, result } = await collect(turn(input, ports));

    // At minimum: turn_start → turn_end
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("turn_start");
    expect(events[events.length - 1].type).toBe("turn_end");

    // Result reflects the confirmation
    expect(result.reply).toContain("confirmed");
    expect(result.reply).toContain("meal-log-42");
    expect(result.stopReason).toBe("end_turn");
  });

  it("produces a rejection reply when confirmed=false", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: false,
    };

    const { result } = await collect(turn(input, ports));

    expect(result.reply).toContain("rejected");
    expect(result.reply).toContain("meal-log-42");
    expect(result.stopReason).toBe("end_turn");
  });

  it("includes optional feedback in the reply when provided", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: true,
      feedback: "Please reduce the portion size.",
    };

    const { result } = await collect(turn(input, ports));

    expect(result.reply).toContain("confirmed");
    expect(result.reply).toContain("reduce the portion size");
  });

  it("carries tagged input in the turn_start event", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-7",
      confirmed: true,
    };

    const { events } = await collect(turn(input, ports));

    const start = events[0];
    expect(start.type).toBe("turn_start");
    const startWithInput = start as { input: TurnInput };
    expect(startWithInput.input).toEqual(input);
  });

  it("exactly one terminal event: turn_end is always last", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: false,
    };

    const { events } = await collect(turn(input, ports));

    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(events[events.length - 1].type).toBe("turn_end");

    const endWithResult = turnEnds[0] as { result: TurnResult };
    expect(endWithResult.result.stopReason).toBe("end_turn");
  });

  it("emits schema-versioned events with monotonic seq", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "unused", stop: true }));
    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: true,
    };

    const { events } = await collect(turn(input, ports));

    for (const event of events) {
      expect(event.schema).toBe(SCHEMA_VERSION);
    }

    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("zero network access — adapter is not called for proposal confirm", async () => {
    const tracer = new Tracer();
    let generateCalled = false;
    const adapter = stubAdapter(() => {
      generateCalled = true;
      return { content: "should not be used", stop: true };
    });

    const ports: TurnPorts = { adapter, tracer, clock: fixedClock() };
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: true,
    };

    await collect(turn(input, ports));

    // Proposal confirmation should not call the model adapter
    expect(generateCalled).toBe(false);
  });
});

// ─── Ports injection ──────────────────────────────────────────────────────

describe("turn ports injection", () => {
  it("accepts all optional ports without throwing", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const ports: TurnPorts = {
      adapter,
      tracer,
      clock: fixedClock(),
      // eventLog and interactionStore are optional
    };
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const { events } = await collect(turn(input, ports));
    expect(events[events.length - 1].type).toBe("turn_end");
  });

  it("defaults clock to system time when not injected", async () => {
    const tracer = new Tracer();
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const ports: TurnPorts = { adapter, tracer };
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const before = new Date();
    const { events } = await collect(turn(input, ports));
    const after = new Date();

    // Timestamps should be valid ISO strings within the expected range
    for (const event of events) {
      const ts = new Date(event.timestamp);
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    }
  });
});
