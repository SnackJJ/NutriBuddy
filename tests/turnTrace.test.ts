// The trace port's host: turn() appends before every yield and guarantees one
// terminal event even when the body throws (#88 DoD, RFC 0008 §3.2/§3.6).
//
// The reaction to write failures lives here, with the *failures* injected by
// InMemoryTraceStore (`failAt`) rather than by a second copy of Postgres error
// classification — that classification is the Supabase store's, and is asserted
// in tests/supabaseTraceStore.test.ts.

import { describe, expect, it } from "vitest";
import {
  turn,
  type AnyTurnEvent,
  type TurnInput,
  type TurnPorts,
  type TurnResult,
} from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import { InMemoryTraceStore } from "../src/harness/inMemoryTraceStore";
import { createTurnStream } from "../src/lib/turnStream";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from "../src/harness/types";

const T0 = "2026-07-26T10:00:00.000Z";
const UTTERANCE: TurnInput = { tag: "utterance", content: "how much protein?" };

function stubAdapter(
  impl: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (request) => impl(request) };
}

function createPorts(overrides: Partial<TurnPorts> = {}): TurnPorts {
  return {
    adapter: stubAdapter(() => ({ content: "OK", stop: true })),
    tracer: new Tracer(),
    clock: () => new Date(T0),
    ...overrides,
  };
}

async function collect(
  generator: AsyncGenerator<AnyTurnEvent, TurnResult, undefined>,
): Promise<{ events: AnyTurnEvent[]; result: TurnResult }> {
  const events: AnyTurnEvent[] = [];
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, result: next.value };
}

function seqs(events: readonly AnyTurnEvent[]): number[] {
  return events.map((event) => event.seq);
}

function expectGapless(events: readonly AnyTurnEvent[]): void {
  expect(seqs(events)).toEqual(events.map((_, index) => index));
}

function expectSingleTerminal(events: readonly AnyTurnEvent[]): void {
  expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
  expect(events[events.length - 1]?.type).toBe("turn_end");
}

describe("turn() with a trace port", () => {
  it("persists every event it yields, in seq order and without gaps", async () => {
    const store = new InMemoryTraceStore({ turnId: "turn-1", userId: "user-A" });

    const { events } = await collect(turn(UTTERANCE, createPorts({ trace: store })));

    const stored = await store.listByTurn("turn-1");
    expect(stored).toEqual(events);
    expectGapless(events);
    expectSingleTerminal(events);
  });

  it("runs without a trace port, so the CLI and scripted tests need no database", async () => {
    const { events } = await collect(turn(UTTERANCE, createPorts()));
    expectGapless(events);
    expectSingleTerminal(events);
  });

  it("turns an adapter exception into a persisted crash terminal", async () => {
    const store = new InMemoryTraceStore({ turnId: "turn-1", userId: "user-A" });
    const ports = createPorts({
      trace: store,
      adapter: stubAdapter(() => {
        throw new Error("adapter exploded");
      }),
    });

    const { events, result } = await collect(turn(UTTERANCE, ports));

    expect(result.stopReason).toBe("crash");
    expectSingleTerminal(events);
    expectGapless(events);

    const stored = await store.listByTurn("turn-1");
    expect(stored).toEqual(events);
    // The turn row is finalized, so replay sees a finished turn rather than a
    // turn that looks like it is still running (§2).
    const [summary] = await store.listTurns(1);
    expect(summary.stopReason).toBe("crash");
    expect(summary.finishedAt).toBe(T0);
  });

  it("emits a crash terminal without a row when the body fails before turn_start", async () => {
    const store = new InMemoryTraceStore({ turnId: "turn-1", userId: "user-A" });
    const controller = new AbortController();
    controller.abort();

    const { events, result } = await collect(
      turn(UTTERANCE, createPorts({ trace: store, signal: controller.signal })),
    );

    expect(result.stopReason).toBe("crash");
    expect(seqs(events)).toEqual([0]);
    // There is no turn row to finalize, and the RPC would reject a lone
    // turn_end with 23503 — so nothing is written at all.
    expect(await store.listByTurn("turn-1")).toEqual([]);
    expect(store.persistFailed).toBe(false);
  });

  it("uses the assembly layer's crash reply, and a generic one without it", async () => {
    const throwing = stubAdapter(() => {
      throw new Error("adapter exploded");
    });

    const { result: mapped } = await collect(
      turn(
        UTTERANCE,
        createPorts({ adapter: throwing, crashReply: () => "Try again shortly." }),
      ),
    );
    expect(mapped.reply).toBe("Try again shortly.");

    const { result: fallback } = await collect(
      turn(UTTERANCE, createPorts({ adapter: throwing })),
    );
    expect(fallback.reply).toMatch(/try again/i);
    expect(fallback.reply).not.toMatch(/adapter exploded/);
  });
});

describe("turn() when a trace write is lost", () => {
  it("crashes on the first failed write, and the terminal still lands", async () => {
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 1, times: 1 },
    });

    const { events, result } = await collect(
      turn(UTTERANCE, createPorts({ trace: store })),
    );

    expect(result.stopReason).toBe("crash");
    // seq 1 was never yielded (its write failed), and the terminal took its place.
    expect(seqs(events)).toEqual([0, 1]);
    expectSingleTerminal(events);

    const stored = await store.listByTurn("turn-1");
    expect(seqs(stored)).toEqual([0, 1]);
    expect(stored[1]).toEqual(events[1]);
    expect(store.persistFailed).toBe(true);
  });

  it("still emits exactly one terminal when the terminal's own write fails", async () => {
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 1, times: 2 },
    });

    const { events, result } = await collect(
      turn(UTTERANCE, createPorts({ trace: store })),
    );

    expect(result.stopReason).toBe("crash");
    expect(seqs(events)).toEqual([0, 1]);
    expectSingleTerminal(events);
    expect(seqs(await store.listByTurn("turn-1"))).toEqual([0]);
    expect(store.persistFailed).toBe(true);
  });

  it("reports a lost trace through the route-level terminal frame", async () => {
    // The whole chain #90 asks for: turn() + a store that loses two writes +
    // the pump. Each third of it is tested on its own above; only this case
    // catches a route that forgot to read the flag.
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 1, times: 2 },
    });

    const stream = createTurnStream(turn(UTTERANCE, createPorts({ trace: store })), {
      tracePersistFailed: () => store.persistFailed,
    });
    const frames = (
      await new Response(stream)
        .text()
        .then((text) =>
          text
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        )
    );

    expect(frames.at(-1)).toMatchObject({
      type: "terminal",
      stopReason: "crash",
      trace_persist_failed: true,
    });
    expect(store.persistFailed).toBe(true);
  });

  it("finalizes a turn row that already exists when the abort lands mid-turn", async () => {
    const store = new InMemoryTraceStore({ turnId: "turn-1", userId: "user-A" });
    const controller = new AbortController();
    let calls = 0;

    // Step 1 answers normally; the abort then makes the loop itself refuse step
    // 2, which is the path a real mid-turn abort takes.
    const adapter = stubAdapter(() => {
      calls += 1;
      if (calls === 1) return { content: "thinking", stop: false, toolCalls: [] };
      controller.abort();
      return { content: "unreachable", stop: false };
    });

    const { events, result } = await collect(
      turn(UTTERANCE, createPorts({ trace: store, adapter, signal: controller.signal })),
    );

    expect(result.stopReason).toBe("crash");
    expect(result.steps).toBe(2);
    expectSingleTerminal(events);
    expectGapless(events);

    const stored = await store.listByTurn("turn-1");
    expect(stored).toEqual(events);
    expect((await store.listTurns(1))[0].stopReason).toBe("crash");
  });

  it("holds the D3 predicate: min(seq)=0, max(seq)+1=count(*), exactly one turn_end", async () => {
    const store = new InMemoryTraceStore({ turnId: "turn-1", userId: "user-A" });

    await collect(turn(UTTERANCE, createPorts({ trace: store })));

    const stored = await store.listByTurn("turn-1");
    const sequences = seqs(stored);
    expect(Math.min(...sequences)).toBe(0);
    expect(Math.max(...sequences) + 1).toBe(stored.length);
    expect(stored.filter((event) => event.type === "turn_end")).toHaveLength(1);
  });

  it("holds the D3 predicate after the lost write too", async () => {
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 3, times: 1 },
    });

    await collect(turn(UTTERANCE, createPorts({ trace: store })));

    const stored = await store.listByTurn("turn-1");
    const sequences = seqs(stored);
    expect(Math.min(...sequences)).toBe(0);
    expect(Math.max(...sequences) + 1).toBe(stored.length);
    expect(stored.filter((event) => event.type === "turn_end")).toHaveLength(1);
  });
});
