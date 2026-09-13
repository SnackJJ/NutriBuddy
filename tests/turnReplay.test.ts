// The replay endpoint's decisions (RFC 0008 §5) and the client's memory of an
// unfinished turn. Both are framework-free on purpose: the route and the page
// are thin shells around them.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  encodeNdjson,
  foldReplayedTurn,
  isTurnId,
  loadTurnReplay,
  parseSinceParam,
} from "../src/lib/turnReplay";
import {
  PENDING_TURN_KEY,
  beginTurn,
  completeTurn,
  readPendingTurn,
  recordEventSeq,
  replayUrl,
  type KeyValueStorage,
} from "../src/lib/turnSession";
import { InMemoryTraceDb, InMemoryTraceStore } from "../src/harness/inMemoryTraceStore";
import { createTurnStream } from "../src/lib/turnStream";
import { fullTurn, turnEnd, turnStart } from "./helpers/traceStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe("loadTurnReplay", () => {
  function storeFor(db: InMemoryTraceDb, userId = "user-A") {
    return new InMemoryTraceStore({ turnId: "turn-1", userId, db });
  }

  it("returns the whole turn when no `since` is given", async () => {
    const db = new InMemoryTraceDb();
    const store = storeFor(db);
    for (const event of fullTurn()) await store.append(event);

    const outcome = await loadTurnReplay(store, "turn-1");
    expect(outcome.kind).toBe("events");
    if (outcome.kind !== "events") return;
    // turn_start included: that is the event the page renders as the user's own
    // message after a refresh.
    expect(outcome.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("returns only later events when `since` is given", async () => {
    const db = new InMemoryTraceDb();
    const store = storeFor(db);
    for (const event of fullTurn()) await store.append(event);

    const outcome = await loadTurnReplay(store, "turn-1", 4);
    expect(outcome.kind).toBe("events");
    if (outcome.kind !== "events") return;
    expect(outcome.events.map((e) => e.seq)).toEqual([5]);
  });

  it("reports a turn with nothing after `since` as an empty event list", async () => {
    const db = new InMemoryTraceDb();
    const store = storeFor(db);
    await store.append(turnStart(0));
    await store.append(turnEnd(1, { seconds: 1 }));

    const outcome = await loadTurnReplay(store, "turn-1", 1);
    expect(outcome).toEqual({ kind: "events", events: [] });
  });

  it("reports someone else's turn as not found", async () => {
    const db = new InMemoryTraceDb();
    const owner = storeFor(db);
    await owner.append(turnStart(0));

    const outsider = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-B",
      db,
    });
    expect(await loadTurnReplay(outsider, "turn-1")).toEqual({
      kind: "not_found",
    });
  });

  it("reports an unknown turn as not found", async () => {
    const db = new InMemoryTraceDb();
    expect(await loadTurnReplay(storeFor(db), "turn-unknown")).toEqual({
      kind: "not_found",
    });
  });
});

describe("replay after a client that left mid-turn (acceptance D4)", () => {
  it("returns exactly the events the interrupted client had not seen", async () => {
    const db = new InMemoryTraceDb();
    const store = new InMemoryTraceStore({
      turnId: "turn-1",
      userId: "user-A",
      db,
    });

    // The turn keeps being persisted after the client stops reading (§3.5), so
    // the sink only has to stop the framing for this to be the interesting case.
    let pump: Promise<void> | undefined;
    const stream = createTurnStream(
      (async function* () {
        // Append-then-yield, exactly as turn() does. Appending everything up
        // front would make the assertions below hold even if the pump abandoned
        // the generator when the client cancelled.
        for (const event of fullTurn()) {
          await store.append(event);
          yield event;
        }
        return { reply: "done", steps: 3, stopReason: "end_turn" } as const;
      })(),
      { keepAlive: (work) => { pump = work; } },
    );

    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await pump;

    // The reader consumed one frame (seq 0) before it cancelled.
    const lastSeen = 0;
    const outcome = await loadTurnReplay(store, "turn-1", lastSeen);
    expect(outcome.kind).toBe("events");
    if (outcome.kind !== "events") return;

    const everything = await store.listByTurn("turn-1");
    expect(outcome.events).toEqual(
      everything.filter((event) => event.seq > lastSeen),
    );
    // Nothing was lost by the disconnect, and the tail is what a resuming client
    // needs to finish rendering.
    expect(everything.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outcome.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("replay endpoint surface", () => {
  it("reads through the session client, never the service role", () => {
    // RFC 0008 §3.3: the trace tables are written by the service role and read
    // through the owner-only select policies, so the replay route must not be
    // able to see another user's turn even if its id leaks.
    const source = readFileSync("app/api/turns/[id]/events/route.ts", "utf-8");

    expect(source).toContain("createUserSupabase");
    expect(source).toContain("getSessionFromHeader");
    expect(source).not.toContain("createServerSupabase");
    expect(source).toContain("loadTurnReplay");
  });
});

describe("parseSinceParam", () => {
  it("treats an absent or blank value as the beginning, not as zero", () => {
    // since=0 means "after seq 0", which would drop turn_start.
    expect(parseSinceParam(null)).toEqual({ ok: true });
    expect(parseSinceParam("")).toEqual({ ok: true });
    expect(parseSinceParam("  ")).toEqual({ ok: true });
    expect(parseSinceParam("0")).toEqual({ ok: true, sinceSeq: 0 });
  });

  it("accepts a non-negative integer", () => {
    expect(parseSinceParam("7")).toEqual({ ok: true, sinceSeq: 7 });
    expect(parseSinceParam(" 12 ")).toEqual({ ok: true, sinceSeq: 12 });
  });

  it("rejects anything else rather than defaulting to replaying everything", () => {
    for (const value of ["-1", "1.5", "abc", "0x2", "1e3", "9".repeat(20)]) {
      expect(parseSinceParam(value)).toEqual({ ok: false });
    }
  });
});

describe("isTurnId", () => {
  it("accepts canonical uuids and rejects everything else", () => {
    expect(isTurnId("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isTurnId("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe(true);
    for (const value of ["", "turn-1", "../../etc/passwd", "3f2504e0"]) {
      expect(isTurnId(value)).toBe(false);
    }
  });
});

describe("encodeNdjson", () => {
  it("writes one JSON object per line, and nothing for no events", () => {
    expect(encodeNdjson([])).toBe("");
    expect(encodeNdjson([{ type: "step", seq: 1 }, { type: "turn_end" }])).toBe(
      '{"type":"step","seq":1}\n{"type":"turn_end"}\n',
    );
  });
});

describe("foldReplayedTurn", () => {
  it("reads the user's own message and the turn's start time", () => {
    const folded = foldReplayedTurn([
      {
        type: "turn_start",
        seq: 0,
        timestamp: "2026-09-13T15:04:27.587Z",
        input: { tag: "utterance", content: "how much protein?" },
      },
      { type: "step", seq: 1 },
    ]);

    expect(folded.userText).toBe("how much protein?");
    expect(folded.startedAtMs).toBe(Date.parse("2026-09-13T15:04:27.587Z"));
    expect(folded.sawTerminal).toBe(false);
    expect(folded.lastSeq).toBe(1);
  });

  it("reports a terminal in the very first replay — the turn finished while the page was loading", () => {
    // This is the case that decides whether the restored turn still gets its
    // proposal card: the resume must not treat "already finished" as "nothing
    // to restore".
    const folded = foldReplayedTurn([
      { type: "turn_start", seq: 0 },
      { type: "turn_end", seq: 1 },
      { type: "terminal" },
    ]);

    expect(folded.sawTerminal).toBe(true);
  });

  it("carries no user message for a turn that is not an utterance", () => {
    const folded = foldReplayedTurn([
      {
        type: "turn_start",
        seq: 0,
        input: { tag: "proposal_confirm", proposalId: "p-1" },
      },
    ]);

    expect(folded.userText).toBeUndefined();
    expect(folded.lastSeq).toBe(0);
  });

  it("survives an empty replay", () => {
    expect(foldReplayedTurn([])).toEqual({ sawTerminal: false });
  });
});

describe("pending turn state", () => {
  it("remembers the turnId from turn_meta and advances lastSeq monotonically", () => {
    const storage = fakeStorage();

    beginTurn(storage, "turn-1");
    expect(readPendingTurn(storage)).toEqual({ turnId: "turn-1" });

    recordEventSeq(storage, "turn-1", 0);
    recordEventSeq(storage, "turn-1", 1);
    expect(readPendingTurn(storage)).toEqual({ turnId: "turn-1", lastSeq: 1 });

    // A replay can deliver an older event after a newer one; the high-water
    // mark must not move backwards.
    recordEventSeq(storage, "turn-1", 0);
    expect(readPendingTurn(storage)?.lastSeq).toBe(1);
  });

  it("clears the turn on a terminal event", () => {
    const storage = fakeStorage();
    beginTurn(storage, "turn-1");
    recordEventSeq(storage, "turn-1", 3);

    completeTurn(storage);
    expect(readPendingTurn(storage)).toBeUndefined();
    expect(storage.getItem(PENDING_TURN_KEY)).toBeNull();
  });

  it("ignores an event that belongs to a different turn", () => {
    const storage = fakeStorage();
    beginTurn(storage, "turn-1");
    recordEventSeq(storage, "turn-2", 5);

    // A late event from the turn the page has already moved past must not
    // advance (or resurrect) this turn's cursor.
    expect(readPendingTurn(storage)).toEqual({ turnId: "turn-1" });
  });

  it("keeps working when the browser refuses site data", () => {
    // A browser blocking storage throws SecurityError on access; bookkeeping is
    // a side channel and must not be able to fail the turn itself.
    const hostile: KeyValueStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
    };

    expect(() => beginTurn(hostile, "turn-1")).not.toThrow();
    expect(() => recordEventSeq(hostile, "turn-1", 1)).not.toThrow();
    expect(() => completeTurn(hostile)).not.toThrow();
    expect(readPendingTurn(hostile)).toBeUndefined();
  });

  it("ignores seq updates when no turn is being watched", () => {
    const storage = fakeStorage();
    recordEventSeq(storage, "turn-1", 2);
    expect(readPendingTurn(storage)).toBeUndefined();
  });

  it("treats a corrupt or foreign entry as absent instead of guessing", () => {
    for (const raw of [
      "not json",
      "{}",
      '{"turnId":""}',
      '{"turnId":"turn-1","lastSeq":-1}',
      '{"turnId":"turn-1","lastSeq":1.5}',
      '{"turnId":42}',
    ]) {
      const storage = fakeStorage({ [PENDING_TURN_KEY]: raw });
      expect(readPendingTurn(storage)).toBeUndefined();
    }
  });

  it("builds the replay URL with and without a cursor", () => {
    expect(replayUrl("turn-1")).toBe("/api/turns/turn-1/events");
    expect(replayUrl("turn-1", 4)).toBe("/api/turns/turn-1/events?since=4");
  });
});
