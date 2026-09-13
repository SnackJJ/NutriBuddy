// The NDJSON pump behind POST /api/chat (#88, RFC 0008 §3.5).
//
// The disconnect case is the reason this module exists outside the route: the
// product's core moment is logging a meal with a phone that locks, and a locked
// phone must not cost the user the answer or the trace.

import { describe, expect, it } from "vitest";
import { createTurnStream } from "../src/lib/turnStream";
import type { AnyTurnEvent, TurnResult } from "../src/harness/turn";
import { step, turnEnd, turnStart } from "./helpers/traceStore";

const TERMINAL_RESULT: TurnResult = {
  reply: "logged",
  steps: 1,
  stopReason: "end_turn",
};

function body(events: readonly AnyTurnEvent[]): AsyncGenerator<
  AnyTurnEvent,
  TurnResult,
  undefined
> {
  return (async function* () {
    for (const event of events) yield event;
    return TERMINAL_RESULT;
  })();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("createTurnStream", () => {
  it("frames every turn event and the terminal result as NDJSON", async () => {
    const events = [turnStart(0), step(1), turnEnd(2, { seconds: 1 })];

    const frames = await readAll(createTurnStream(body(events)));

    expect(frames).toEqual([
      ...events,
      { type: "terminal", ...TERMINAL_RESULT },
    ]);
  });

  it("marks the terminal when a trace write was given up on", async () => {
    let failed = false;
    const stream = createTurnStream(body([turnStart(0), turnEnd(1, { seconds: 1 })]), {
      // Read after the last event, which is where a lost write becomes known.
      tracePersistFailed: () => failed,
    });

    const frames = (await readAll(stream)) as { type: string }[];
    expect(frames.at(-1)).toMatchObject({ type: "terminal" });
    expect(frames.at(-1)).not.toHaveProperty("trace_persist_failed");

    const flagged = (await readAll(
      createTurnStream(body([turnStart(0), turnEnd(1, { seconds: 1 })]), {
        tracePersistFailed: () => true,
      }),
    )) as { type: string; trace_persist_failed?: boolean }[];
    expect(flagged.at(-1)?.trace_persist_failed).toBe(true);
    expect(failed).toBe(false);
  });

  it("keeps consuming the turn after the client disconnects", async () => {
    const yielded: number[] = [];
    const events = Array.from({ length: 5 }, (_, index) => step(index));

    async function* slowBody(): AsyncGenerator<
      AnyTurnEvent,
      TurnResult,
      undefined
    > {
      for (const event of events) {
        yielded.push(event.seq);
        yield event;
        // Long enough that the cancel below lands mid-stream.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return TERMINAL_RESULT;
    }

    let pump: Promise<void> | undefined;
    const stream = createTurnStream(slowBody(), {
      keepAlive: (work) => {
        pump = work;
      },
    });

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    // Draining is the assertion: framing stopped, the turn did not.
    await pump;
    expect(yielded).toEqual([0, 1, 2, 3, 4]);
  });

  it("reports a frame it cannot serialize as an error instead of going quiet", async () => {
    // The old route sent an error frame here. Treating a serialization bug as a
    // disconnect would drop the terminal frame and leave the UI with nothing.
    const unserializable = {
      ...step(1),
      agentEvent: { type: "observe", step: 0, content: 1n },
    } as unknown as AnyTurnEvent;

    const frames = (await readAll(
      createTurnStream(body([turnStart(0), unserializable]), {
        errorFrame: () => "cannot serialize",
      }),
    )) as unknown[];

    // The first frame made it; the stream then ends with an error frame.
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ type: "error", error: "cannot serialize" });
  });

  it("reports a failure outside turn() as an error frame", async () => {
    const failures: unknown[] = [];
    async function* exploding(): AsyncGenerator<
      AnyTurnEvent,
      TurnResult,
      undefined
    > {
      yield turnStart(0);
      throw new Error("assembly exploded");
    }

    const frames = (await readAll(
      createTurnStream(exploding(), {
        onError: (error) => failures.push(error),
        errorFrame: (error) => `mapped: ${(error as Error).message}`,
      }),
    )) as unknown[];

    expect(frames).toEqual([
      turnStart(0),
      { type: "error", error: "mapped: assembly exploded" },
    ]);
    expect(failures).toHaveLength(1);
  });
});
