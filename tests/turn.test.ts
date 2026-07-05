import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  consumeTurn,
  parseWriteProposalData,
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
  type WriteProposalData,
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

  describe("write-proposal gate verdicts (issue #36)", () => {
    function makeLogMealResult(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        proposal_id: "proposal-001",
        message: "Log 200g chicken breast for lunch? — Confirm?",
        proposal: {
          id: "proposal-001",
          food_name: "chicken breast",
          portion_g: 200,
          meal_type: "lunch",
          created_at: "2026-07-05T12:00:00.000Z",
          nutrition: {
            kcal: 330,
            protein_g: 62,
            fat_g: 7.2,
            carbs_g: 0,
          },
        },
        nutrition_summary: { kcal: 330, protein_g: 62, fat_g: 7.2, carbs_g: 0 },
        ...overrides,
      });
    }

    it("output gate verdict carries write-proposal evidence", async () => {
      let callCount = 0;
      const adapter = stubAdapter(() => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Let me log that.",
            stop: false,
            toolCalls: [
              { name: "log_meal", args: { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" } },
            ],
          };
        }
        return { content: "Done — I've proposed logging that meal.", stop: true };
      });
      const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
      const input: TurnInput = { tag: "utterance", content: "log 200g chicken breast for lunch" };
      const ports = createPorts(undefined, { adapter, tools });

      const { events, result } = await collect(turn(input, ports));

      expect(result.stopReason).toBe("write_proposal");

      const outputVerdict = expectGateVerdict(events, "output");
      expect(outputVerdict.verdict).toBe("pass");
      expect(outputVerdict.evidence).toContain("Write proposal emitted");
      expect(outputVerdict.evidence).toContain("user confirmation");
    });

    it("commit gate verdict documents missing meal ledger mutation on write-proposal", async () => {
      let callCount = 0;
      const adapter = stubAdapter(() => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Let me log that.",
            stop: false,
            toolCalls: [
              { name: "log_meal", args: { food_name: "chicken breast", portion_g: 200, meal_type: "dinner" } },
            ],
          };
        }
        return { content: "Done.", stop: true };
      });
      const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
      const input: TurnInput = { tag: "utterance", content: "log chicken breast dinner" };
      const ports = createPorts(undefined, { adapter, tools });

      const { events, result } = await collect(turn(input, ports));

      expect(result.stopReason).toBe("write_proposal");

      const commitVerdict = expectGateVerdict(events, "commit");
      expect(commitVerdict.verdict).toBe("pass");
      expect(commitVerdict.evidence).toContain("no meal ledger mutation");
      expect(commitVerdict.evidence).toContain(result.proposal?.proposalId);
    });

    it("commit gate evidence is distinct from blocking evidence", async () => {
      // Write-proposal pass
      let callCount = 0;
      const writePropAdapter = stubAdapter(() => {
        callCount++;
        if (callCount === 1) {
          return {
            content: "Let me log that.",
            stop: false,
            toolCalls: [
              { name: "log_meal", args: { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" } },
            ],
          };
        }
        return { content: "Done.", stop: true };
      });
      const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
      const wpInput: TurnInput = { tag: "utterance", content: "log chicken" };
      const wpPorts = createPorts(undefined, { adapter: writePropAdapter, tools });

      const { events: wpEvents } = await collect(turn(wpInput, wpPorts));
      const wpCommit = expectGateVerdict(wpEvents, "commit");

      // Gate-blocked
      const blockedAdapter = stubAdapter(() => ({
        content: "I recommend eating peanuts for protein!",
        stop: true,
      }));
      const blockedInput: TurnInput = { tag: "utterance", content: "protein?" };
      const blockedPorts = createPorts(undefined, {
        adapter: blockedAdapter,
        userContext: { allergies: ["peanut"], medications: [] },
        interactionStore: { all: async () => [] },
      });

      const { events: blockedEvents } = await collect(turn(blockedInput, blockedPorts));
      const blockedCommit = expectGateVerdict(blockedEvents, "commit");

      // Write-proposal commit evidence talks about proposals, not blocks
      expect(wpCommit.evidence.toLowerCase()).toContain("proposal");
      expect(wpCommit.evidence.toLowerCase()).not.toContain("block");

      // Blocked commit evidence talks about blocks, not proposals
      expect(blockedCommit.evidence.toLowerCase()).toContain("block");
      expect(blockedCommit.evidence).not.toBe(wpCommit.evidence);
    });
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

describe("parseWriteProposalData (issue #36)", () => {
  function makeLogMealResult(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      proposal_id: "proposal-001",
      message: "Log 200g chicken breast for lunch? — Confirm?",
      proposal: {
        id: "proposal-001",
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
        created_at: "2026-07-05T12:00:00.000Z",
        nutrition: {
          kcal: 330,
          protein_g: 62,
          fat_g: 7.2,
          carbs_g: 0,
        },
      },
      nutrition_summary: { kcal: 330, protein_g: 62, fat_g: 7.2, carbs_g: 0 },
      ...overrides,
    });
  }

  it("parses a valid log_meal response into WriteProposalData", () => {
    const data = parseWriteProposalData(makeLogMealResult());

    expect(data).toBeDefined();
    if (!data) throw new Error("expected defined data");

    expect(data.proposalId).toBe("proposal-001");
    expect(data.foodName).toBe("chicken breast");
    expect(data.portionG).toBe(200);
    expect(data.mealType).toBe("lunch");
    expect(data.kcal).toBe(330);
    expect(data.proteinG).toBe(62);
    expect(data.fatG).toBe(7.2);
    expect(data.carbsG).toBe(0);
    expect(data.nutritionSource).toBe("");
    expect(data.createdAt).toBe("2026-07-05T12:00:00.000Z");
  });

  it("returns undefined for non-JSON input", () => {
    expect(parseWriteProposalData("not json")).toBeUndefined();
  });

  it("returns undefined when proposal field is missing", () => {
    const result = JSON.stringify({ proposal_id: "x", message: "hi" });
    expect(parseWriteProposalData(result)).toBeUndefined();
  });

  it("returns undefined when proposal.id is missing", () => {
    const result = JSON.stringify({
      proposal: { food_name: "chicken" },
    });
    expect(parseWriteProposalData(result)).toBeUndefined();
  });

  it("returns undefined when proposal.food_name is missing", () => {
    const result = JSON.stringify({
      proposal: { id: "prop-1" },
    });
    expect(parseWriteProposalData(result)).toBeUndefined();
  });

  it("preserves all fields from a complete proposal response", () => {
    const data = parseWriteProposalData(
      makeLogMealResult({
        proposal: {
          id: "prop-custom",
          food_name: "rice",
          portion_g: 150,
          meal_type: "dinner",
          created_at: "2026-01-01T00:00:00Z",
          nutrition: {
            kcal: 200,
            protein_g: 4,
            fat_g: 0.5,
            carbs_g: 45,
          },
        },
      }),
    );

    expect(data).toBeDefined();
    if (!data) throw new Error("expected defined data");

    expect(data.proposalId).toBe("prop-custom");
    expect(data.foodName).toBe("rice");
    expect(data.portionG).toBe(150);
    expect(data.mealType).toBe("dinner");
    expect(data.kcal).toBe(200);
    expect(data.proteinG).toBe(4);
    expect(data.fatG).toBe(0.5);
    expect(data.carbsG).toBe(45);
    expect(data.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("tolerates missing nutrition fields (they become undefined)", () => {
    const result = JSON.stringify({
      proposal: {
        id: "prop-1",
        food_name: "unknown",
        portion_g: 100,
        meal_type: "snack",
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const data = parseWriteProposalData(result);

    expect(data).toBeDefined();
    if (!data) throw new Error("expected defined data");

    expect(data.kcal).toBeUndefined();
    expect(data.proteinG).toBeUndefined();
    expect(data.fatG).toBeUndefined();
    expect(data.carbsG).toBeUndefined();
  });
});

describe("write-proposal turn flow (issue #36 / PRD v2 §3.4)", () => {
  function makeLogMealResult(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      proposal_id: "proposal-001",
      message: "Log 200g chicken breast for lunch? — Confirm?",
      proposal: {
        id: "proposal-001",
        food_name: "chicken breast",
        portion_g: 200,
        meal_type: "lunch",
        created_at: "2026-07-05T12:00:00.000Z",
        nutrition: {
          kcal: 330,
          protein_g: 62,
          fat_g: 7.2,
          carbs_g: 0,
        },
      },
      nutrition_summary: { kcal: 330, protein_g: 62, fat_g: 7.2, carbs_g: 0 },
      ...overrides,
    });
  }

  it("terminal result has stopReason 'write_proposal' with resolved proposal data", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Let me log that meal for you.",
          stop: false,
          toolCalls: [
            {
              name: "log_meal",
              args: { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" },
            },
          ],
        };
      }
      return { content: "Done — I've proposed logging that meal.", stop: true };
    });
    const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
    const input: TurnInput = { tag: "utterance", content: "log 200g chicken breast for lunch" };
    const ports = createPorts(undefined, { adapter, tools });

    const { events, result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("write_proposal");
    expect(result.proposal).toBeDefined();
    expect(result.proposal?.proposalId).toBe("proposal-001");
    expect(result.proposal?.foodName).toBe("chicken breast");
    expect(result.proposal?.portionG).toBe(200);
    expect(result.proposal?.mealType).toBe("lunch");
    expect(result.proposal?.kcal).toBe(330);
    expect(result.proposal?.proteinG).toBe(62);
    expect(result.proposal?.fatG).toBe(7.2);
    expect(result.proposal?.carbsG).toBe(0);
    expect(result.proposal?.createdAt).toBe("2026-07-05T12:00:00.000Z");

    const endEvent = expectTerminalEvent(events);
    expect(endEvent.result.stopReason).toBe("write_proposal");
    expect(endEvent.result.proposal).toEqual(result.proposal);
  });

  it("the model's final reply is preserved alongside the proposal on the terminal result", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Let me log that.",
          stop: false,
          toolCalls: [
            { name: "log_meal", args: { food_name: "rice", portion_g: 150, meal_type: "dinner" } },
          ],
        };
      }
      return { content: "I've proposed 150g rice for your dinner. Confirm?", stop: true };
    });
    const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
    const input: TurnInput = { tag: "utterance", content: "log rice dinner" };
    const ports = createPorts(undefined, { adapter, tools });

    const { result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("write_proposal");
    expect(result.reply).toContain("rice");
    expect(result.reply).toContain("dinner");
    expect(result.proposal).toBeDefined();
  });

  it("event stream includes tool gate verdict for log_meal before write-proposal termination", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Logging...",
          stop: false,
          toolCalls: [
            { name: "log_meal", args: { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" } },
          ],
        };
      }
      return { content: "Done.", stop: true };
    });
    const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
    const input: TurnInput = { tag: "utterance", content: "log chicken" };
    const ports = createPorts(undefined, { adapter, tools });

    const { events, result } = await collect(turn(input, ports));

    expect(result.stopReason).toBe("write_proposal");

    const allCheckpoints = gateVerdicts(events).map((e) => e.checkpoint);
    expect(allCheckpoints).toContain("input");
    expect(allCheckpoints).toContain("tool");
    expect(allCheckpoints).toContain("output");
    expect(allCheckpoints).toContain("commit");

    const toolVerdict = expectGateVerdict(events, "tool");
    expect(toolVerdict.evidence).toContain("log_meal");
  });

  it("write_proposal is a recognized STOP_REASONS member", () => {
    expect(STOP_REASONS).toContain("write_proposal");
  });

  it("a proposal_confirm turn following a write-proposal turn does not touch the adapter", async () => {
    // Write-proposal turn
    let callCount = 0;
    const wpAdapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Logging...",
          stop: false,
          toolCalls: [
            { name: "log_meal", args: { food_name: "chicken breast", portion_g: 200, meal_type: "lunch" } },
          ],
        };
      }
      return { content: "Done.", stop: true };
    });
    const tools = new Map([["log_meal", async () => makeLogMealResult()]]);
    const wpInput: TurnInput = { tag: "utterance", content: "log chicken" };
    const ports = createPorts(undefined, { adapter: wpAdapter, tools });

    const { result: wpResult } = await collect(turn(wpInput, ports));
    expect(wpResult.stopReason).toBe("write_proposal");
    expect(wpResult.proposal).toBeDefined();

    // Confirm turn: the adapter is not called; short-circuit handles it
    let confirmGenerateCalled = false;
    const confirmPorts = createPorts(() => {
      confirmGenerateCalled = true;
      return { content: "should not be used", stop: true };
    });
    const confirmInput: TurnInput = {
      tag: "proposal_confirm",
      proposalId: wpResult.proposal!.proposalId,
      confirmed: true,
    };

    const { result: confirmResult } = await collect(turn(confirmInput, confirmPorts));

    expect(confirmGenerateCalled).toBe(false);
    expect(confirmResult.reply).toContain("confirmed");
  });

  it("only log_meal tool calls trigger write-proposal; other tools do not override stopReason", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up...",
          stop: false,
          toolCalls: [
            { name: "search_food", args: { food: "chicken" } },
          ],
        };
      }
      return { content: "Chicken has 31g protein per 100g.", stop: true };
    });
    const tools = new Map([["search_food", async () => "chicken: 31g protein/100g"]]);
    const input: TurnInput = { tag: "utterance", content: "chicken protein?" };
    const ports = createPorts(undefined, { adapter, tools });

    const { result } = await collect(turn(input, ports));

    // search_food is not log_meal, so stopReason stays as end_turn (not write_proposal)
    expect(result.stopReason).toBe("end_turn");
    expect(result.proposal).toBeUndefined();
  });
});
