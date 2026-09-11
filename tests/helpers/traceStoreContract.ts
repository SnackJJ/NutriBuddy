// The TraceStore contract suite (RFC 0008 §7).
//
// One suite, every implementation: `InMemoryTraceStore` today, the Supabase
// store in #88 (which will call this with its own fixture). The assertions are
// written against the behaviour migration 0011 defines — turn_start creating the
// row, turn_end finalizing it, idempotent (turn_id, seq), owner resolved from
// the turn row rather than the caller, and read isolation between users.

import { describe, expect, it } from "vitest";
import type { TraceStore } from "../../src/harness/traceStore";
import {
  fullTurn,
  gateVerdict,
  modelCall,
  step,
  at,
  turnEnd,
  turnStart,
} from "./traceStore";

export interface TraceStoreFixture {
  readonly store: TraceStore;
  readonly userId: string;
  readonly turnId: string;
  /** A store for a different user on the same backing data. */
  otherUser(userId: string, turnId: string): TraceStore;
}

export function runTraceStoreContract(
  name: string,
  createFixture: () => TraceStoreFixture,
): void {
  describe(`${name}: TraceStore contract`, () => {
    it("turn_start creates the turn and turn_end finalizes it with cost and latency", async () => {
      const { store, turnId, userId } = createFixture();

      for (const event of fullTurn()) await store.append(event);

      const summaries = await store.listTurns(10);
      expect(summaries).toHaveLength(1);
      const summary = summaries[0];
      expect(summary.turnId).toBe(turnId);
      expect(summary.userId).toBe(userId);
      expect(summary.inputKind).toBe("utterance");
      expect(summary.startedAt).toBe(at(0));
      expect(summary.finishedAt).toBe(at(3));
      expect(summary.stopReason).toBe("end_turn");
      expect(summary.steps).toBe(3);
      // Cost aggregates every model_call, including regenerate attempts.
      expect(summary.costUsd).toBeCloseTo(0.0015, 6);
      expect(summary.latencyMs).toBe(3000);
    });

    it("replays events in seq order and `since` returns only later events", async () => {
      const { store } = createFixture();
      for (const event of fullTurn()) await store.append(event);

      const all = await store.listByTurn(store.turnId);
      expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);

      const tail = await store.listByTurn(store.turnId, 2);
      expect(tail.map((e) => e.seq)).toEqual([3, 4, 5]);

      const beyondEnd = await store.listByTurn(store.turnId, 5);
      expect(beyondEnd).toEqual([]);
    });

    it("ignores a repeated (turnId, seq) so retries are idempotent", async () => {
      const { store } = createFixture();

      await store.append(turnStart(0));
      await store.append(turnStart(0));
      await store.append(modelCall(1, { costUsd: 0.002, seconds: 1 }));
      await store.append(modelCall(1, { costUsd: 9.99, seconds: 1 }));
      await store.append(turnEnd(2, { seconds: 1 }));

      const events = await store.listByTurn(store.turnId);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);

      const summary = (await store.listTurns(10))[0];
      expect(summary.costUsd).toBeCloseTo(0.002, 6);
    });

    it("rejects a non-start event for an unknown turn with 23503", async () => {
      const { store } = createFixture();

      await expect(store.append(step(1))).rejects.toMatchObject({ code: "23503" });
    });

    it("rejects a malformed event with 22P02", async () => {
      const { store } = createFixture();

      await expect(
        store.append({ type: "step" } as never),
      ).rejects.toMatchObject({ code: "22P02" });
    });

    it("hides another user's turn from listByTurn and listTurns", async () => {
      const { store, otherUser, turnId } = createFixture();

      await store.append(turnStart(0));
      await store.append(turnEnd(1, { seconds: 1 }));

      const outsider = otherUser("user-B", turnId);
      expect(await outsider.listByTurn(turnId)).toEqual([]);
      expect(await outsider.listTurns(10)).toEqual([]);
    });

    it("lists only this user's turns, newest first, respecting the limit", async () => {
      const { store, otherUser } = createFixture();

      await store.append(turnStart(0, at(0)));
      await store.append(turnEnd(1, { seconds: 1 }));

      // Same user, a later turn.
      const later = otherUser("user-A", "turn-2");
      await later.append(turnStart(0, at(60)));
      await later.append(turnEnd(1, { seconds: 61 }));

      // A stranger's turn must not appear.
      const stranger = otherUser("user-B", "turn-3");
      await stranger.append(turnStart(0, at(120)));
      await stranger.append(turnEnd(1, { seconds: 121 }));

      const summaries = await store.listTurns(10);
      expect(summaries.map((s) => s.turnId)).toEqual(["turn-2", store.turnId]);
      expect(summaries.every((s) => s.userId === "user-A")).toBe(true);

      expect((await store.listTurns(1)).map((s) => s.turnId)).toEqual(["turn-2"]);
    });

    it("returns stored events that do not alias the caller's objects", async () => {
      const { store } = createFixture();
      const event = gateVerdict(1, 1) as { evidence?: string };

      await store.append(turnStart(0));
      await store.append(event as never);

      event.evidence = "mutated after append";

      const stored = (await store.listByTurn(store.turnId, 0))[0] as {
        evidence?: string;
      };
      expect(stored.evidence).toBe("no constraint conflict");
    });
  });
}
