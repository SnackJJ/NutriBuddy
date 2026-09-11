import { describe, expect, it } from "vitest";
import {
  InMemoryTraceDb,
  InMemoryTraceStore,
  latencyMs,
  sumModelCallCostUsd,
} from "../src/harness/inMemoryTraceStore";
import type { TraceStore } from "../src/harness/traceStore";
import { at, fullTurn, modelCall, step, turnEnd, turnStart } from "./helpers/traceStore";
import { runTraceStoreContract, type TraceStoreFixture } from "./helpers/traceStoreContract";

function memoryFixture(): TraceStoreFixture {
  const db = new InMemoryTraceDb();
  const turnId = "turn-1";
  const userId = "user-A";

  return {
    store: new InMemoryTraceStore({ turnId, userId, db, meta: { appVersion: "1.0.0" } }),
    turnId,
    userId,
    otherUser: (otherUserId: string, otherTurnId: string): TraceStore =>
      new InMemoryTraceStore({ turnId: otherTurnId, userId: otherUserId, db }),
  };
}

// The contract suite is what #88's Supabase store will also have to satisfy.
runTraceStoreContract("InMemoryTraceStore", memoryFixture);

describe("InMemoryTraceStore", () => {
  it("binds turnId at construction so turn() never passes it", () => {
    const store = new InMemoryTraceStore({ turnId: "turn-9", userId: "user-A" });
    expect(store.turnId).toBe("turn-9");
  });

  it("surfaces appVersion from meta, since the event stream does not carry it", async () => {
    const { store } = memoryFixture();
    await store.append(turnStart(0));
    expect((await store.listTurns(1))[0].appVersion).toBe("1.0.0");
  });

  it("leaves the summary unfinished until turn_end arrives", async () => {
    const { store } = memoryFixture();
    await store.append(turnStart(0));
    await store.append(modelCall(1, { costUsd: 0.004, seconds: 1 }));

    const summary = (await store.listTurns(1))[0];
    expect(summary.finishedAt).toBeUndefined();
    expect(summary.stopReason).toBeUndefined();
    expect(summary.costUsd).toBeUndefined();
    expect(summary.latencyMs).toBeUndefined();
  });

  it("injects write failures for reaction tests: `times` times, then succeeds", async () => {
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 1, times: 1 },
    });

    await store.append(turnStart(0));
    await expect(store.append(step(1))).rejects.toThrow(/injected trace write failure/);
    await store.append(step(1));
    await store.append(turnEnd(2, { seconds: 2 }));

    expect((await store.listByTurn("turn-1")).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("keeps failing while failures remain", async () => {
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      failAt: { seq: 1, times: 2 },
    });

    await store.append(turnStart(0));
    await expect(store.append(step(1))).rejects.toThrow();
    await expect(store.append(step(1))).rejects.toThrow();
    await store.append(step(1));
    expect((await store.listByTurn("turn-1")).map((e) => e.seq)).toEqual([0, 1]);
  });
});

// The RPC aggregates cost and latency in SQL; these helpers are the in-memory
// equivalents, so they get their own direct assertions.
describe("trace aggregation helpers", () => {
  it("sums every model_call cost and ignores events without one", () => {
    const events = [
      turnStart(0, at(0)),
      modelCall(1, { costUsd: 0.001, seconds: 1 }),
      step(2, at(1)),
      modelCall(3, { seconds: 2 }),
    ];
    expect(sumModelCallCostUsd(events)).toBeCloseTo(0.001, 6);
  });

  it("measures latency from turn_start to turn_end", () => {
    expect(latencyMs(fullTurn())).toBe(3000);
    expect(latencyMs([turnStart(0, at(0))])).toBeUndefined();
  });
});
