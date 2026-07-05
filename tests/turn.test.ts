import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  turn,
  type AnyTurnEvent,
  type TurnEndEvent,
  type TurnInput,
  type TurnPorts,
  type TurnResult,
  type TurnStartEvent,
  type TypedOutput,
} from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../src/harness/types";
import type { InteractionStore } from "../src/lib/drugInteractions";

const FIXED_TIMESTAMP = "2026-07-05T12:00:00.000Z";

type AdapterImpl = (
  req: ModelRequest,
) => ModelResponse | Promise<ModelResponse>;

type TurnEventOf<T extends AnyTurnEvent["type"]> = Extract<
  AnyTurnEvent,
  { type: T }
>;

function stubAdapter(impl: AdapterImpl): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

function createPorts(
  impl: AdapterImpl = () => ({ content: "OK", stop: true }),
  overrides: Partial<TurnPorts> = {},
): TurnPorts {
  return {
    adapter: stubAdapter(impl),
    tracer: new Tracer(),
    clock: fixedClock(),
    ...overrides,
  };
}

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

function fixedClock(timestamp = FIXED_TIMESTAMP): () => Date {
  return () => new Date(timestamp);
}

function eventsOfType<T extends AnyTurnEvent["type"]>(
  events: readonly AnyTurnEvent[],
  type: T,
): TurnEventOf<T>[] {
  return events.filter((event): event is TurnEventOf<T> => event.type === type);
}

function expectStartEvent(events: readonly AnyTurnEvent[]): TurnStartEvent {
  const firstEvent = events[0];

  expect(firstEvent?.type).toBe("turn_start");
  if (!firstEvent || firstEvent.type !== "turn_start") {
    throw new Error("expected first event to be turn_start");
  }

  return firstEvent;
}

function expectTerminalEvent(events: readonly AnyTurnEvent[]): TurnEndEvent {
  const turnEnds = eventsOfType(events, "turn_end");
  const lastEvent = events[events.length - 1];

  expect(turnEnds).toHaveLength(1);
  expect(lastEvent?.type).toBe("turn_end");
  if (!lastEvent || lastEvent.type !== "turn_end") {
    throw new Error("expected last event to be turn_end");
  }

  expect(lastEvent).toBe(turnEnds[0]);
  return lastEvent;
}

function expectTypedOutput(result: TurnResult): TypedOutput {
  expect(result.output).toBeDefined();
  if (!result.output) {
    throw new Error("expected typed output");
  }

  return result.output;
}

function expectEventMetadata(
  events: readonly AnyTurnEvent[],
  timestamp: string,
): void {
  for (const event of events) {
    expect(event.schema).toBe(SCHEMA_VERSION);
    expect(typeof event.seq).toBe("number");
    expect(event.timestamp).toBe(timestamp);
  }

  const seqs = events.map((event) => event.seq);
  for (let index = 1; index < seqs.length; index++) {
    expect(seqs[index]).toBeGreaterThan(seqs[index - 1]);
  }
}

describe("turn (utterance)", () => {
  it("emits start, loop steps, and terminal result for a single-step utterance", async () => {
    const input: TurnInput = {
      tag: "utterance",
      content: "How much protein in an egg?",
    };
    const ports = createPorts(() => ({
      content: "Eggs have about 6g of protein per large egg.",
      stop: true,
    }));

    const { events, result } = await collect(turn(input, ports));

    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "step",
      "step",
      "turn_end",
    ]);
    expect(expectStartEvent(events).input).toEqual(input);
    expect(
      eventsOfType(events, "step").map((event) => event.agentEvent.type),
    ).toEqual(["thought", "observe"]);
    expect(expectTerminalEvent(events).result).toEqual(result);
    expect(result).toEqual({
      reply: "Eggs have about 6g of protein per large egg.",
      steps: 1,
      stopReason: "end_turn",
    });
  });

  it("emits schema-versioned events with monotonic seq and injected timestamps", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const { events } = await collect(turn(input, createPorts()));

    expectEventMetadata(events, FIXED_TIMESTAMP);
  });

  it("wraps all loop events from a multi-step tool turn", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;

      if (callCount === 1) {
        return {
          content: "Looking up nutrition data...",
          stop: false,
          toolCalls: [
            {
              name: "search_food",
              args: { food: "chicken" },
            } satisfies ToolCall,
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
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };
    const ports = createPorts(undefined, { adapter, tools });

    const { events, result } = await collect(turn(input, ports));

    expect(result).toEqual({
      reply: "Chicken breast has 31g protein per 100g.",
      steps: 2,
      stopReason: "end_turn",
    });
    expect(
      eventsOfType(events, "step").map((event) => event.agentEvent.type),
    ).toEqual(["thought", "act", "observe", "thought", "observe"]);
    expectTerminalEvent(events);
  });

  it("uses the injected adapter for model generation", async () => {
    let generateCalled = false;
    const ports = createPorts(() => {
      generateCalled = true;
      return { content: "Safe reply.", stop: true };
    });
    const input: TurnInput = { tag: "utterance", content: "testing" };

    const { events } = await collect(turn(input, ports));

    expect(generateCalled).toBe(true);
    expectTerminalEvent(events);
  });

  it("uses custom injected clocks for timestamps", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const ports = createPorts(undefined, { clock: fixedClock(timestamp) });
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const { events } = await collect(turn(input, ports));

    expectEventMetadata(events, timestamp);
  });
});

describe("turn (proposal_confirm)", () => {
  it("emits start and end events for a confirmed proposal", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: true,
    };

    const { events, result } = await collect(turn(input, createPorts()));

    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "turn_end",
    ]);
    expect(expectStartEvent(events).input).toEqual(input);
    expect(expectTerminalEvent(events).result).toEqual(result);
    expect(result).toEqual({
      reply: "Proposal meal-log-42 confirmed.",
      steps: 0,
      stopReason: "end_turn",
    });
  });

  it("produces a rejection reply when confirmed is false", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: false,
    };

    const { result } = await collect(turn(input, createPorts()));

    expect(result).toEqual({
      reply: "Proposal meal-log-42 rejected.",
      steps: 0,
      stopReason: "end_turn",
    });
  });

  it("includes optional feedback in confirmed proposal replies", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: true,
      feedback: "Please reduce the portion size.",
    };

    const { result } = await collect(turn(input, createPorts()));

    expect(result).toEqual({
      reply: "Proposal meal-log-42 confirmed. Please reduce the portion size.",
      steps: 0,
      stopReason: "end_turn",
    });
  });

  it("emits schema-versioned events with monotonic seq", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: true,
    };

    const { events } = await collect(turn(input, createPorts()));

    expectEventMetadata(events, FIXED_TIMESTAMP);
  });

  it("does not call the adapter for proposal confirmations", async () => {
    let generateCalled = false;
    const ports = createPorts(() => {
      generateCalled = true;
      return { content: "should not be used", stop: true };
    });
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: true,
    };

    await collect(turn(input, ports));

    expect(generateCalled).toBe(false);
  });
});

describe("turn ports injection", () => {
  it("accepts omitted optional ports", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };

    const { events } = await collect(
      turn(input, {
        adapter: stubAdapter(() => ({ content: "OK", stop: true })),
        tracer: new Tracer(),
      }),
    );

    expectTerminalEvent(events);
  });

  it("defaults clock to system time when not injected", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports: TurnPorts = {
      adapter: stubAdapter(() => ({ content: "OK", stop: true })),
      tracer: new Tracer(),
    };

    const before = new Date();
    const { events } = await collect(turn(input, ports));
    const after = new Date();

    for (const event of events) {
      const timestamp = new Date(event.timestamp);
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
      expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    }
  });

  it("passes history through ports into the loop", async () => {
    const tracer = new Tracer();
    const input: TurnInput = { tag: "utterance", content: "follow-up" };
    const ports = createPorts(() => ({ content: "ok", stop: true }), {
      tracer,
      history: [
        { role: "user", content: "PRIOR-Q" },
        { role: "assistant", content: "PRIOR-A" },
      ],
    });

    await collect(turn(input, ports));

    const prompt =
      tracer.events().find((event) => event.type === "model_prompt")?.payload ??
      "";
    expect(prompt).toContain("PRIOR-Q");
    expect(prompt).toContain("PRIOR-A");
  });

  it("passes system prompts through ports into the loop", async () => {
    const tracer = new Tracer();
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(() => ({ content: "ok", stop: true }), {
      tracer,
      systemPrompt: "CUSTOM-SYSTEM-PROMPT",
    });

    await collect(turn(input, ports));

    const prompt =
      tracer.events().find((event) => event.type === "model_prompt")?.payload ??
      "";
    expect(prompt).toContain("CUSTOM-SYSTEM-PROMPT");
  });

  it("passes tier and thinking knobs through ports to the adapter", async () => {
    const generateCalls: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      generate: async (req) => {
        generateCalls.push(req);
        return { content: "x", stop: true };
      },
    };
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(undefined, {
      adapter,
      tier: "pro",
      thinking: false,
    });

    await collect(turn(input, ports));

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0].model).toBe("pro");
    expect(generateCalls[0].thinking).toBe(false);
  });

  it("passes maxSteps through ports to cap the turn", async () => {
    let calls = 0;
    const input: TurnInput = { tag: "utterance", content: "go" };
    const ports = createPorts(
      () => {
        calls++;
        return { content: `step ${calls}`, stop: false };
      },
      { maxSteps: 3 },
    );

    const { result } = await collect(turn(input, ports));

    expect(calls).toBe(3);
    expect(result.steps).toBe(3);
    expect(result.stopReason).toBe("max_steps");
  });

  it("is interruptible via AbortSignal in ports", async () => {
    const controller = new AbortController();
    controller.abort();
    const input: TurnInput = { tag: "utterance", content: "q" };
    const gen = turn(
      input,
      createPorts(undefined, { signal: controller.signal }),
    );

    await expect(gen.next()).rejects.toThrow(/abort/i);
  });

  it("passes userContext through ports to enable the gate", async () => {
    const tracer = new Tracer();
    const interactionStore: InteractionStore = {
      all: async () => [],
    };
    const input: TurnInput = { tag: "utterance", content: "what can I eat?" };
    const ports = createPorts(() => ({ content: "safe answer", stop: true }), {
      tracer,
      userContext: { allergies: ["peanut"], medications: [] },
      interactionStore,
    });

    await collect(turn(input, ports));

    const prompt =
      tracer.events().find((event) => event.type === "model_prompt")?.payload ??
      "";
    expect(prompt).toContain("peanut");
    expect(prompt).toContain("SAFETY CONSTRAINT");
  });
});

describe("typed final output contract", () => {
  const EGG_BREAKFAST_OUTPUT = {
    prose: "I recommend eggs for breakfast.",
    foodRefs: [
      {
        foodId: "egg-whole-raw",
        foodName: "Eggs, whole, raw",
        matchType: "exact",
        allergens: ["egg"],
      },
    ],
    ruleRefs: [
      {
        ruleId: "R001",
        summary: "High protein food suitable for your goals",
      },
    ],
  } satisfies TypedOutput;

  const SALMON_DINNER_OUTPUT = {
    prose: "Based on your profile, I recommend salmon.",
    foodRefs: [
      {
        foodId: "salmon-atlantic-raw",
        foodName: "Salmon, Atlantic, raw",
        matchType: "exact",
        allergens: ["fish"],
      },
    ],
    ruleRefs: [
      {
        ruleId: "R003",
        summary: "Omega-3 rich food for anti-inflammatory benefit",
      },
    ],
  } satisfies TypedOutput;

  const HEART_HEALTH_OUTPUT = {
    prose:
      "For your omega-3 goals, I recommend salmon. Note: check warfarin interaction.",
    foodRefs: [
      {
        foodId: "salmon-atlantic-raw",
        foodName: "Salmon, Atlantic, raw",
        matchType: "fuzzy",
        allergens: ["fish"],
      },
      {
        foodId: "spinach-raw",
        foodName: "Spinach, raw",
        matchType: "exact",
      },
    ],
    ruleRefs: [
      {
        ruleId: "WARFARIN-VITK",
        summary: "High vitamin K foods may interfere with warfarin",
      },
      {
        ruleId: "OMEGA3-RECOMMENDED",
        summary: "Omega-3 fatty acids support cardiovascular health",
      },
    ],
  } satisfies TypedOutput;

  const CHICKEN_PROTEIN_OUTPUT = {
    prose: "Chicken breast has 31g protein per 100g.",
    foodRefs: [
      {
        foodId: "chicken-breast-raw",
        foodName: "Chicken breast, raw",
        matchType: "exact",
      },
    ],
    ruleRefs: [],
  } satisfies TypedOutput;

  function createTypedOutputPorts(output: TypedOutput): TurnPorts {
    return createPorts(() => ({
      content: output.prose,
      stop: true,
      output,
    }));
  }

  it("terminal event carries typed output when model returns it", async () => {
    const ports = createTypedOutputPorts(EGG_BREAKFAST_OUTPUT);
    const input: TurnInput = { tag: "utterance", content: "breakfast ideas?" };

    const { events, result } = await collect(turn(input, ports));

    expect(result.output).toEqual(EGG_BREAKFAST_OUTPUT);
    const endEvent = expectTerminalEvent(events);
    expect(endEvent.result.output).toEqual(EGG_BREAKFAST_OUTPUT);
  });

  it("typed output fields are inspectable without prose parsing", async () => {
    const ports = createTypedOutputPorts(SALMON_DINNER_OUTPUT);
    const input: TurnInput = { tag: "utterance", content: "healthy dinner?" };

    const { events } = await collect(turn(input, ports));
    const endEvent = expectTerminalEvent(events);
    const output = expectTypedOutput(endEvent.result);

    expect(output.foodRefs).toHaveLength(1);
    expect(output.foodRefs[0]).toEqual(SALMON_DINNER_OUTPUT.foodRefs[0]);

    expect(output.ruleRefs).toHaveLength(1);
    expect(output.ruleRefs[0]).toEqual(SALMON_DINNER_OUTPUT.ruleRefs[0]);
  });

  it("adapter without typed output produces no output field on result", async () => {
    const ports = createPorts(() => ({
      content: "Simple reply without structured output.",
      stop: true,
    }));
    const input: TurnInput = { tag: "utterance", content: "hello" };

    const { result } = await collect(turn(input, ports));

    expect(result.output).toBeUndefined();
  });

  it("typed output prose matches the reply for final answers", async () => {
    const output = {
      prose: "Eggs have about 6g of protein per large egg.",
      foodRefs: [
        {
          foodId: "egg-whole-raw",
          foodName: "Eggs, whole, raw",
          matchType: "exact",
          allergens: ["egg"],
        },
      ],
      ruleRefs: [],
    } satisfies TypedOutput;
    const ports = createTypedOutputPorts(output);
    const input: TurnInput = { tag: "utterance", content: "egg protein?" };

    const { result } = await collect(turn(input, ports));

    expect(result.reply).toBe(output.prose);
    expect(expectTypedOutput(result).prose).toBe(output.prose);
  });

  it("typed output with both foodRefs and ruleRefs flows through complete turn", async () => {
    const ports = createTypedOutputPorts(HEART_HEALTH_OUTPUT);
    const input: TurnInput = {
      tag: "utterance",
      content: "What should I eat for heart health?",
    };

    const { events, result } = await collect(turn(input, ports));

    expectStartEvent(events);
    const endEvent = expectTerminalEvent(events);

    expect(result.output).toEqual(HEART_HEALTH_OUTPUT);
    expect(endEvent.result.output).toEqual(HEART_HEALTH_OUTPUT);

    const output = expectTypedOutput(result);
    expect(output.foodRefs).toHaveLength(2);
    expect(output.foodRefs[0].matchType).toBe("fuzzy");
    expect(output.foodRefs[1].matchType).toBe("exact");
    expect(output.ruleRefs).toHaveLength(2);
    expect(output.ruleRefs.map((r) => r.ruleId)).toEqual([
      "WARFARIN-VITK",
      "OMEGA3-RECOMMENDED",
    ]);
    expect(output.foodRefs[1].allergens).toBeUndefined();
  });

  it("typed output in multi-step tool turn propagates from final model response", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up nutrition data...",
          stop: false,
          toolCalls: [
            {
              name: "search_food",
              args: { food: "chicken" },
            },
          ],
        };
      }
      return {
        content: CHICKEN_PROTEIN_OUTPUT.prose,
        stop: true,
        output: CHICKEN_PROTEIN_OUTPUT,
      };
    });
    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };
    const ports = createPorts(undefined, { adapter, tools });

    const { events, result } = await collect(turn(input, ports));

    expect(result.output).toEqual(CHICKEN_PROTEIN_OUTPUT);
    const endEvent = expectTerminalEvent(events);
    expect(endEvent.result.output).toEqual(CHICKEN_PROTEIN_OUTPUT);
  });
});
