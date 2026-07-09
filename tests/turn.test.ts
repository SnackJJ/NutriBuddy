import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  consumeTurn,
  turn,
  type AnyTurnEvent,
  type TurnEndEvent,
  type TurnGateVerdictEvent,
  type TurnInput,
  type TurnPorts,
  type TurnResult,
  type TurnStartEvent,
  type TypedOutput,
} from "../src/harness/turn";
import { TRACE_EVENT_TYPES, Tracer } from "../src/harness/tracer";
import {
  STOP_REASONS,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from "../src/harness/types";
import type { InteractionStore } from "../src/lib/drugInteractions";
import type { Observation, ColumnDef } from "../src/catalog/queryCatalog";
import type { Conflict } from "../src/harness/advisoryGate";

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

function gateVerdicts(events: readonly AnyTurnEvent[]): TurnGateVerdictEvent[] {
  return eventsOfType(events, "gate_verdict");
}

function expectGateVerdict(
  events: readonly AnyTurnEvent[],
  checkpoint: TurnGateVerdictEvent["checkpoint"],
): TurnGateVerdictEvent {
  const verdict = gateVerdicts(events).find(
    (event) => event.checkpoint === checkpoint,
  );

  expect(verdict).toBeDefined();
  if (!verdict) {
    throw new Error(`expected ${checkpoint} gate verdict`);
  }

  return verdict;
}

function countBlockedGateVerdicts(events: readonly AnyTurnEvent[]): number {
  return gateVerdicts(events).filter((event) => event.verdict === "block")
    .length;
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
  it("emits start, loop steps, gate verdicts, and terminal result for a single-step utterance", async () => {
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
      "gate_verdict",
      "step",
      "step",
      "gate_verdict",
      "gate_verdict",
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
  it("emits start, gate verdicts, and end events for a confirmed proposal", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "meal-log-42",
      confirmed: true,
    };

    const { events, result } = await collect(turn(input, createPorts()));

    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "gate_verdict",
      "gate_verdict",
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

describe("turn cross-vocabulary (CLI + eval share)", () => {
  it("consumeTurn drains the stream and returns the terminal result", async () => {
    const input: TurnInput = { tag: "utterance", content: "protein?" };
    const ports = createPorts(() => ({
      content: "6g protein per egg.",
      stop: true,
    }));
    const events: AnyTurnEvent[] = [];

    const result = await consumeTurn(turn(input, ports), (event) => {
      events.push(event);
    });
    const endEvent = expectTerminalEvent(events);

    expect(result).toEqual(endEvent.result);
    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "gate_verdict",
      "step",
      "step",
      "gate_verdict",
      "gate_verdict",
      "turn_end",
    ]);
  });

  it("terminal TurnEndEvent shape is compatible with CLI display and eval scoring", async () => {
    const input: TurnInput = { tag: "utterance", content: "protein?" };
    const ports = createPorts(() => ({
      content: "6g protein per egg.",
      stop: true,
    }));

    const { events, result } = await collect(turn(input, ports));
    const endEvent = expectTerminalEvent(events);

    expect(typeof result.reply).toBe("string");
    expect(result.reply).toBe(endEvent.result.reply);

    expect(typeof result.steps).toBe("number");
    expect(result.steps).toBeGreaterThanOrEqual(0);
    expect(result.stopReason).toBe(endEvent.result.stopReason);
    expect(STOP_REASONS).toContain(result.stopReason);
  });

  it("tracer events use the shared vocabulary both CLI and eval consume", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up...",
          stop: false,
          toolCalls: [{ name: "search_food", args: { food: "egg" } }],
        };
      }
      return { content: "6g protein per egg.", stop: true };
    });
    const tools = new Map([["search_food", async () => "egg: 6g protein"]]);
    const tracer = new Tracer();
    const input: TurnInput = { tag: "utterance", content: "egg protein?" };
    const ports = createPorts(undefined, { adapter, tools, tracer });

    const { result } = await collect(turn(input, ports));

    const traceEvents = tracer.events();
    const types = traceEvents.map((e) => e.type);

    // Loop always records these core vocabulary types:
    expect(types).toContain("user_input");
    expect(types).toContain("model_prompt");
    expect(types).toContain("model_return");

    const validTypes = new Set(TRACE_EVENT_TYPES);
    for (const type of types) {
      expect(validTypes.has(type)).toBe(true);
    }

    expect(result.reply).toBe("6g protein per egg.");
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("event stream always starts with turn_start and ends with turn_end (shared by CLI + eval)", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(() => ({ content: "ok", stop: true }));

    const { events } = await collect(turn(input, ports));

    expect(events.length).toBeGreaterThanOrEqual(2); // at least start + end
    expect(events[0].type).toBe("turn_start");
    expect(events[events.length - 1].type).toBe("turn_end");
    for (const event of events) {
      expect(event.schema).toBe(SCHEMA_VERSION);
    }
  });
});

describe("gate verdict events", () => {
  const emptyInteractionStore: InteractionStore = { all: async () => [] };

  it("emits input gate verdict after turn_start on utterance turns", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(() => ({ content: "ok", stop: true }));

    const { events } = await collect(turn(input, ports));

    const inputVerdict = expectGateVerdict(events, "input");

    expect(inputVerdict.verdict).toBe("pass");
    expect(inputVerdict.checkName).toBe("pre_gate_input_check");
    expect(inputVerdict.evidence.length).toBeGreaterThan(0);
    expect(events.indexOf(inputVerdict)).toBeGreaterThan(
      events.findIndex((e) => e.type === "turn_start"),
    );
  });

  it("emits tool gate verdict after tool observation in multi-step turns", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up...",
          stop: false,
          toolCalls: [{ name: "search_food", args: { food: "chicken" } }],
        };
      }
      return { content: "Chicken has 31g protein/100g.", stop: true };
    });
    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };
    const ports = createPorts(undefined, { adapter, tools });

    const { events } = await collect(turn(input, ports));

    const toolVerdict = expectGateVerdict(events, "tool");

    expect(toolVerdict.verdict).toBe("pass");
    expect(toolVerdict.checkName).toBe("tool_gate_check");
    expect(toolVerdict.evidence).toContain("search_food");
  });

  it("emits output and commit gate verdicts with pass on clean turns", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(() => ({ content: "ok", stop: true }));

    const { events } = await collect(turn(input, ports));

    const outputVerdict = expectGateVerdict(events, "output");
    const commitVerdict = expectGateVerdict(events, "commit");

    expect(outputVerdict.verdict).toBe("pass");
    expect(outputVerdict.checkName).toBe("post_gate_output_check");
    expect(outputVerdict.evidence.length).toBeGreaterThan(0);
    expect(commitVerdict.verdict).toBe("pass");
    expect(commitVerdict.checkName).toBe("commit_gate_check");
    expect(commitVerdict.evidence.length).toBeGreaterThan(0);
  });

  it("emits blocking output and commit gate verdicts when post-gate blocks", async () => {
    const adapter = stubAdapter(() => ({
      content: "I recommend eating peanuts for protein!",
      stop: true,
    }));
    const input: TurnInput = { tag: "utterance", content: "protein sources?" };
    const ports = createPorts(undefined, {
      adapter,
      userContext: { allergies: ["peanut"], medications: [] },
      interactionStore: emptyInteractionStore,
    });

    const { events, result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("gate_blocked");

    const outputVerdict = expectGateVerdict(events, "output");
    const commitVerdict = expectGateVerdict(events, "commit");

    expect(outputVerdict.verdict).toBe("block");
    expect(outputVerdict.checkName).toBe("post_gate_output_check");
    expect(outputVerdict.evidence.length).toBeGreaterThan(0);
    expect(outputVerdict.evidence.toLowerCase()).toContain("block");
    expect(commitVerdict.verdict).toBe("block");
    expect(commitVerdict.checkName).toBe("commit_gate_check");
    expect(commitVerdict.evidence.length).toBeGreaterThan(0);
  });

  it("gate verdict events carry valid schema and metadata", async () => {
    const input: TurnInput = { tag: "utterance", content: "hi" };
    const ports = createPorts(() => ({ content: "ok", stop: true }));

    const { events } = await collect(turn(input, ports));

    const gateEvents = gateVerdicts(events);
    expect(gateEvents.length).toBeGreaterThanOrEqual(3); // input, output, commit (no tool gate on turn without tools)

    for (const gv of gateEvents) {
      expect(gv.schema).toBe(SCHEMA_VERSION);
      expect(typeof gv.seq).toBe("number");
      expect(typeof gv.checkpoint).toBe("string");
      expect(typeof gv.verdict).toBe("string");
      expect(typeof gv.checkName).toBe("string");
      expect(typeof gv.evidence).toBe("string");
    }
  });

  it("proposal confirmation turns emit input and commit gate verdicts (no tool/output)", async () => {
    const input: TurnInput = {
      tag: "proposal_confirm",
      proposalId: "p1",
      confirmed: true,
    };
    const ports = createPorts();

    const { events } = await collect(turn(input, ports));

    const checkpoints = gateVerdicts(events).map((event) => event.checkpoint);

    // Proposal confirmation has no model call, so no tool/output gate
    expect(checkpoints).toContain("input");
    expect(checkpoints).toContain("commit");
    expect(checkpoints).not.toContain("tool");
    expect(checkpoints).not.toContain("output");
  });

  it("scorer can detect a blocked turn by reading gate verdict events directly", async () => {
    // Simulate what the eval scorer does: collect gate verdict blocks
    // from the turn event stream without inspecting tracer or prose.
    const adapter = stubAdapter(() => ({
      content: "I recommend eating peanuts for protein!",
      stop: true,
    }));
    const input: TurnInput = { tag: "utterance", content: "protein sources?" };
    const ports = createPorts(undefined, {
      adapter,
      userContext: { allergies: ["peanut"], medications: [] },
      interactionStore: { all: async () => [] },
    });

    const { events } = await collect(turn(input, ports));

    expect(countBlockedGateVerdicts(events)).toBeGreaterThanOrEqual(1);
  });

  it("scorer sees zero gate blocks when post-gate passes", async () => {
    const adapter = stubAdapter(() => ({
      content: "I recommend chicken for protein!",
      stop: true,
    }));
    const input: TurnInput = { tag: "utterance", content: "protein sources?" };
    const ports = createPorts(undefined, {
      adapter,
      userContext: { allergies: ["peanut"], medications: [] },
      interactionStore: { all: async () => [] },
    });

    const { events } = await collect(turn(input, ports));

    expect(countBlockedGateVerdicts(events)).toBe(0);
  });
});

describe("output gate — numeric provenance and advisory structure", () => {
  function makeObservation(
    templateId: string,
    columns: readonly ColumnDef[],
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Observation {
    return {
      templateId,
      columns,
      rows: rows as any,
      rowCount: rows.length,
      truncated: false,
    };
  }

  const CHICKEN_COLUMNS: ColumnDef[] = [
    { name: "food_id", type: "string", description: "Catalog food ID" },
    { name: "food_name", type: "string", description: "Canonical name" },
    { name: "portion_g", type: "number", unit: "g", description: "Portion size" },
    { name: "kcal", type: "number", unit: "kcal", description: "Calories" },
    { name: "protein_g", type: "number", unit: "g", description: "Protein" },
    { name: "fat_g", type: "number", unit: "g", description: "Fat" },
    { name: "carbs_g", type: "number", unit: "g", description: "Carbs" },
    { name: "allergen_tags", type: "string", description: "Allergens" },
  ];

  const CHICKEN_OBSERVATION = makeObservation("food_lookup", CHICKEN_COLUMNS, [
    {
      food_id: "chicken-breast-001",
      food_name: "Chicken breast, raw",
      portion_g: 100,
      kcal: 165,
      protein_g: 31,
      fat_g: 3.6,
      carbs_g: 0,
      allergen_tags: "",
    },
  ]);

  const PEANUT_CONFLICT: Conflict = {
    type: "allergy",
    id: "peanut",
    description: "User is allergic to peanut",
  };

  const CLEAN_CHICKEN_OUTPUT: TypedOutput = {
    prose: "Chicken breast has 31g protein and 165 kcal per 100g serving.",
    foodRefs: [
      {
        foodId: "chicken-breast-001",
        foodName: "Chicken breast, raw",
        matchType: "exact",
      },
    ],
    ruleRefs: [],
  };

  it("emits passing output_numeric_provenance and output_advisory_structure gate verdicts for clean output", async () => {
    const ports = createPorts(() => ({
      content: CLEAN_CHICKEN_OUTPUT.prose,
      stop: true,
      output: CLEAN_CHICKEN_OUTPUT,
    }), {
      observations: [CHICKEN_OBSERVATION],
      conflicts: [],
    });
    const input: TurnInput = { tag: "utterance", content: "chicken nutrition?" };

    const { events } = await collect(turn(input, ports));

    const numericVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_numeric_provenance",
    );
    const advisoryVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_advisory_structure",
    );

    expect(numericVerdict).toBeDefined();
    expect(numericVerdict!.verdict).toBe("pass");
    expect(numericVerdict!.evidence).toContain("All numeric facts trace to observations");

    expect(advisoryVerdict).toBeDefined();
    expect(advisoryVerdict!.verdict).toBe("pass");
    expect(advisoryVerdict!.evidence).toContain("Advisory structure valid");
  });

  it("emits blocking output_numeric_provenance verdict when prose contains ungrounded numbers", async () => {
    const badOutput: TypedOutput = {
      prose: "Chicken breast has 500g protein and 999 kcal.", // ungrounded
      foodRefs: [
        {
          foodId: "chicken-breast-001",
          foodName: "Chicken breast, raw",
          matchType: "exact",
        },
      ],
      ruleRefs: [],
    };

    const ports = createPorts(() => ({
      content: badOutput.prose,
      stop: true,
      output: badOutput,
    }), {
      observations: [CHICKEN_OBSERVATION],
    });
    const input: TurnInput = { tag: "utterance", content: "chicken nutrition?" };

    const { events, result } = await collect(turn(input, ports));

    const numericVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_numeric_provenance",
    );

    // The first attempt should have a blocking numeric verdict
    expect(numericVerdict).toBeDefined();
    // After retries are exhausted, the final result should be blocked
    expect(result.stopReason).toBe("gate_blocked");
    expect(countBlockedGateVerdicts(events)).toBeGreaterThanOrEqual(1);
  });

  it("emits blocking output_advisory_structure verdict when conflicts unaddressed", async () => {
    const badOutput: TypedOutput = {
      prose: "I recommend peanuts for protein.",
      foodRefs: [
        {
          foodId: "peanut-001",
          foodName: "Peanuts, raw",
          matchType: "exact",
          allergens: ["peanut"],
        },
      ],
      ruleRefs: [], // missing advisory for peanut allergy
    };

    const ports = createPorts(() => ({
      content: badOutput.prose,
      stop: true,
      output: badOutput,
    }), {
      conflicts: [PEANUT_CONFLICT],
    });
    const input: TurnInput = { tag: "utterance", content: "protein sources?" };

    const { events, result } = await collect(turn(input, ports));

    const advisoryVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_advisory_structure",
    );
    expect(advisoryVerdict).toBeDefined();
    expect(result.stopReason).toBe("gate_blocked");
  });

  it("skips numeric provenance gate when no observations are provided", async () => {
    const output: TypedOutput = {
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
    };

    const ports = createPorts(() => ({
      content: output.prose,
      stop: true,
      output,
    }));
    const input: TurnInput = { tag: "utterance", content: "egg protein?" };

    const { events, result } = await collect(turn(input, ports));

    // Should pass — numeric gate skipped when no observations
    expect(result.stopReason).toBe("end_turn");

    const numericVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_numeric_provenance",
    );
    expect(numericVerdict).toBeDefined();
    expect(numericVerdict!.verdict).toBe("pass");
    expect(numericVerdict!.evidence).toContain("skipped");
  });

  it("retries then refuses when numeric provenance persistently fails", async () => {
    // Adapter always returns the same ungrounded output — retries won't fix it
    const badOutput: TypedOutput = {
      prose: "Chicken breast has 500g protein and 999 kcal.",
      foodRefs: [
        {
          foodId: "chicken-breast-001",
          foodName: "Chicken breast, raw",
          matchType: "exact",
        },
      ],
      ruleRefs: [],
    };

    const ports = createPorts(() => ({
      content: badOutput.prose,
      stop: true,
      output: badOutput,
    }), {
      observations: [CHICKEN_OBSERVATION],
    });
    const input: TurnInput = { tag: "utterance", content: "chicken nutrition?" };

    const { events, result } = await collect(turn(input, ports));

    // After 2 retries, should return gate_blocked
    expect(result.stopReason).toBe("gate_blocked");
    expect(result.reply).toContain("cannot safely answer");

    // Should have multiple numeric provenance verdicts (original + retries)
    const numericVerdicts = gateVerdicts(events).filter(
      (gv) => gv.checkName === "output_numeric_provenance",
    );
    expect(numericVerdicts.length).toBeGreaterThanOrEqual(1);
    expect(numericVerdicts.some((v) => v.verdict === "block")).toBe(true);
  });

  it("passes when observations ground all numbers and conflicts have advisory ruleRefs (combined pass)", async () => {
    const cleanOutput: TypedOutput = {
      prose: "Based on your profile, I recommend salmon. Note: 20g protein and 208 kcal.",
      foodRefs: [
        {
          foodId: "salmon-001",
          foodName: "Salmon, Atlantic, raw",
          matchType: "exact",
          allergens: ["fish"],
        },
      ],
      ruleRefs: [
        {
          ruleId: "WARFARIN-VITK",
          summary: "Monitor vitamin K with warfarin",
        },
      ],
    };

    const salmonObs = makeObservation("food_lookup", CHICKEN_COLUMNS, [
      {
        food_id: "salmon-001",
        food_name: "Salmon, Atlantic, raw",
        portion_g: 100,
        kcal: 208,
        protein_g: 20,
        fat_g: 13,
        carbs_g: 0,
        allergen_tags: "fish",
      },
    ]);

    const warfarinConflict: Conflict = {
      type: "drug_interaction",
      id: "WARFARIN-VITK",
      description: "Warfarin interacts with vitamin K",
    };

    const ports = createPorts(() => ({
      content: cleanOutput.prose,
      stop: true,
      output: cleanOutput,
    }), {
      observations: [salmonObs],
      conflicts: [warfarinConflict],
    });
    const input: TurnInput = { tag: "utterance", content: "healthy dinner?" };

    const { events, result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("end_turn");
    expect(result.output).toEqual(cleanOutput);

    const numericVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_numeric_provenance",
    );
    const advisoryVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_advisory_structure",
    );

    expect(numericVerdict!.verdict).toBe("pass");
    expect(advisoryVerdict!.verdict).toBe("pass");
    expect(countBlockedGateVerdicts(events)).toBe(0);
  });

  it("model can self-correct on retry when output gate blocks (realistic retry scenario)", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        // First attempt: hallucinates numbers
        return {
          content: "Chicken breast has 500g protein.",
          stop: true,
          output: {
            prose: "Chicken breast has 500g protein.",
            foodRefs: [
              {
                foodId: "chicken-breast-001",
                foodName: "Chicken breast, raw",
                matchType: "exact" as const,
              },
            ],
            ruleRefs: [],
          },
        };
      }
      // Second attempt: corrects the number after feedback
      return {
        content: "Chicken breast has 31g protein.",
        stop: true,
        output: {
          prose: "Chicken breast has 31g protein.",
          foodRefs: [
            {
              foodId: "chicken-breast-001",
              foodName: "Chicken breast, raw",
              matchType: "exact" as const,
            },
          ],
          ruleRefs: [],
        },
      };
    });

    const ports = createPorts(undefined, {
      adapter,
      observations: [CHICKEN_OBSERVATION],
    });
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };

    const { events, result } = await collect(turn(input, ports));

    // Should pass after retry — model fixed the number
    expect(result.stopReason).toBe("end_turn");
    expect(result.reply).toContain("31g");

    // Should have at least one blocking numeric verdict and one passing
    const numericVerdicts = gateVerdicts(events).filter(
      (gv) => gv.checkName === "output_numeric_provenance",
    );
    expect(numericVerdicts.length).toBeGreaterThanOrEqual(2);
    expect(numericVerdicts[0].verdict).toBe("block");
    expect(numericVerdicts[numericVerdicts.length - 1].verdict).toBe("pass");
  });

  it("advisory gate passes when conflicts exist but output makes no food recommendations", async () => {
    const output: TypedOutput = {
      prose: "I understand you have a peanut allergy. How can I help you today?",
      foodRefs: [],
      ruleRefs: [],
    };

    const ports = createPorts(() => ({
      content: output.prose,
      stop: true,
      output,
    }), {
      conflicts: [PEANUT_CONFLICT],
    });
    const input: TurnInput = { tag: "utterance", content: "snack suggestions?" };

    const { events, result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("end_turn");
    const advisoryVerdict = gateVerdicts(events).find(
      (gv) => gv.checkName === "output_advisory_structure",
    );
    expect(advisoryVerdict!.verdict).toBe("pass");
  });
});
