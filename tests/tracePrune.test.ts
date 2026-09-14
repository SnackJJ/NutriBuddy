// Trace retention (#122 / RFC 0008 §3.8).
//
// The clock is an argument, not a `Date.now()` inside: "90 days before now" is
// the whole rule, and a test that has to wait 90 days to exercise it is a test
// that will never be written.

import { describe, expect, it } from "vitest";
import {
  applyPrune,
  DEFAULT_RETENTION_DAYS,
  planPrune,
  pruneCutoff,
  type PrunableTurn,
  type TracePruneSource,
} from "../src/harness/tracePrune";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * In-memory source with the two behaviours that matter: it filters by the
 * cutoff exactly like the SQL (`started_at < cutoff`), and it records every
 * delete so "a dry run changed nothing" is checkable.
 */
function fakeSource(turns: readonly PrunableTurn[]) {
  let live = [...turns];
  const deleteCalls: string[][] = [];
  const source: TracePruneSource = {
    listTurnsStartedBefore: async (cutoff, limit) =>
      live
        .filter((turn) => turn.startedAt < cutoff)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(0, limit),
    deleteTurns: async (turnIds) => {
      deleteCalls.push([...turnIds]);
      const before = live.length;
      live = live.filter((turn) => !turnIds.includes(turn.turnId));
      return before - live.length;
    },
  };
  return {
    source,
    deleteCalls,
    live: () => live,
  };
}

describe("pruneCutoff", () => {
  it("is 90 days before now by default", () => {
    expect(pruneCutoff(NOW)).toBe("2026-06-15T12:00:00.000Z");
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it("takes an explicit retention window", () => {
    expect(pruneCutoff(NOW, 30)).toBe("2026-08-14T12:00:00.000Z");
  });
});

describe("planPrune", () => {
  it("plans only turns started before the cutoff", async () => {
    const { source } = fakeSource([
      { turnId: "old", startedAt: daysAgo(120) },
      { turnId: "edge-inside", startedAt: daysAgo(89) },
      { turnId: "oldest", startedAt: daysAgo(400) },
    ]);

    const plan = await planPrune(source, { now: NOW, batchSize: 100 });
    expect(plan.turns.map((turn) => turn.turnId)).toEqual(["oldest", "old"]);
    expect(plan.cutoff).toBe("2026-06-15T12:00:00.000Z");
    expect(plan.oldest).toBe(daysAgo(400));
    expect(plan.newest).toBe(daysAgo(120));
  });

  it("reports an empty plan rather than an absent one", async () => {
    const { source } = fakeSource([{ turnId: "fresh", startedAt: daysAgo(1) }]);
    const plan = await planPrune(source, { now: NOW, batchSize: 100 });
    expect(plan.turns).toEqual([]);
    expect(plan.oldest).toBeUndefined();
  });

  it("caps a round at batchSize", async () => {
    const turns = [1, 2, 3, 4, 5].map((n) => ({
      turnId: `t${n}`,
      startedAt: daysAgo(100 + n),
    }));
    const { source } = fakeSource(turns);
    const plan = await planPrune(source, { now: NOW, batchSize: 2 });
    expect(plan.turns.map((t) => t.turnId)).toEqual(["t5", "t4"]);
  });

  it("is a read: the default path deletes nothing", async () => {
    const { source, deleteCalls, live } = fakeSource([
      { turnId: "old", startedAt: daysAgo(300) },
    ]);
    const plan = await planPrune(source, { now: NOW, batchSize: 10 });
    expect(plan.turns).toHaveLength(1);
    expect(deleteCalls).toEqual([]);
    expect(live()).toHaveLength(1);
  });
});

describe("applyPrune", () => {
  it("deletes in rounds until nothing is older than the cutoff", async () => {
    const { source, deleteCalls, live } = fakeSource([
      { turnId: "a", startedAt: daysAgo(200) },
      { turnId: "b", startedAt: daysAgo(150) },
      { turnId: "c", startedAt: daysAgo(100) },
      { turnId: "keep", startedAt: daysAgo(10) },
    ]);

    const result = await applyPrune(source, { now: NOW, batchSize: 2 });

    expect(result.stop).toBe("done");
    expect(result.planned).toBe(3);
    expect(result.deleted).toBe(3);
    expect(deleteCalls).toEqual([["a", "b"], ["c"]]);
    expect(live().map((turn) => turn.turnId)).toEqual(["keep"]);
  });

  it("stops on a round that deletes nothing instead of looping on it", async () => {
    const neverDeletes: TracePruneSource = {
      listTurnsStartedBefore: async () => [
        { turnId: "stuck", startedAt: daysAgo(500) },
      ],
      deleteTurns: async () => 0,
    };

    const result = await applyPrune(neverDeletes, { now: NOW, batchSize: 10 });
    expect(result.stop).toBe("no-progress");
    expect(result.planned).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it("gives up at the round limit rather than running forever", async () => {
    const { source } = fakeSource([
      { turnId: "a", startedAt: daysAgo(200) },
      { turnId: "b", startedAt: daysAgo(150) },
    ]);
    const result = await applyPrune(source, { now: NOW, batchSize: 1, maxRounds: 1 });
    expect(result.stop).toBe("round-limit");
    expect(result.deleted).toBe(1);
  });

  it("honours a shorter retention window", async () => {
    const { source, live } = fakeSource([{ turnId: "30d", startedAt: daysAgo(45) }]);
    const result = await applyPrune(source, { now: NOW, retentionDays: 30, batchSize: 10 });
    expect(result.retentionDays).toBe(30);
    expect(result.cutoff).toBe("2026-08-14T12:00:00.000Z");
    expect(live()).toEqual([]);
  });
});
