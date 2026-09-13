// SupabaseTraceStore classification, retry and write-budget tests (#88/#90,
// RFC 0008 §3.7).
//
// A fake client stands in for PostgREST: these are assertions about *how the
// store reacts* to each class of failure, and the real RPC cannot be made to
// raise 08xxx or to hang on demand. What the real RPC does with a well-formed
// call is the live smoke's job (#124), and what the SQL layer guarantees is
// migration 0011's.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseTraceStore } from "../src/harness/supabaseTraceStore";
import { at, step, turnEnd, turnStart } from "./helpers/traceStore";

interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type RpcResult = {
  readonly data?: unknown;
  readonly error?: unknown;
  /** PostgREST's HTTP status, which is where a gateway failure shows up. */
  readonly status?: number;
};

interface FakeRpc {
  readonly client: SupabaseClient;
  readonly calls: RpcCall[];
}

/**
 * A client whose `rpc(...).abortSignal(signal)` runs `handler` for each attempt.
 *
 * It mirrors postgrest-js on purpose: a failed `rpc()` *resolves* with
 * `{ error, status }` instead of rejecting (postgrest-js converts a failed fetch
 * into `{ error: { code: "" }, status: 0 }`), so a fake that rejects would be
 * testing a shape the real client never produces.
 */
function fakeRpc(
  handler: (call: RpcCall, attempt: number) => Promise<RpcResult>,
): FakeRpc {
  const calls: RpcCall[] = [];

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      const call: RpcCall = { name, args, signal: undefined };
      calls.push(call);
      return {
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return handler(call, calls.length);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

/** A PostgREST SQLSTATE failure: the code travels in the error body. */
function errorWith(code: string, status = 400): RpcResult {
  return { error: { message: `sqlstate ${code}`, code }, status };
}

/** A transport failure the way postgrest-js reports one: no SQLSTATE, status 0. */
function transportFailure(message = "FetchError: fetch failed"): RpcResult {
  return { error: { message, details: "", hint: "", code: "" }, status: 0 };
}

function store(rpc: FakeRpc, timeoutMs = 5000): SupabaseTraceStore {
  return new SupabaseTraceStore({
    client: rpc.client,
    userId: "user-A",
    turnId: "turn-1",
    meta: { appVersion: "1.0.0", sourceVersion: "usda-2026-01" },
    timeoutMs,
    log: () => {},
  });
}

describe("SupabaseTraceStore.append", () => {
  it("sends one RPC with the bound turn, user and meta", async () => {
    const rpc = fakeRpc(async () => ({ data: null, error: null }));

    await store(rpc).append(turnStart(0));

    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0].name).toBe("append_turn_event");
    expect(rpc.calls[0].args).toMatchObject({
      p_turn_id: "turn-1",
      p_user_id: "user-A",
      // camelCase, because the RPC reads `p_meta->>'appVersion'`. Snake_case
      // here would leave every turns.app_version null without failing anything.
      p_meta: { appVersion: "1.0.0", sourceVersion: "usda-2026-01" },
    });
    expect((rpc.calls[0].args.p_event as { seq: number }).seq).toBe(0);
    // Every write carries its own budget: supabase-js's fetch has none.
    expect(rpc.calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("treats 23505 as success — the first attempt committed and its response was lost", async () => {
    const rpc = fakeRpc(async () => errorWith("23505", 409));
    const trace = store(rpc);

    await expect(trace.append(step(1))).resolves.toBeUndefined();
    expect(rpc.calls).toHaveLength(1);
    expect(trace.persistFailed).toBe(false);
  });

  it.each([
    ["unknown turn", "23503"],
    ["permission", "42501"],
    ["malformed payload", "22P02"],
    ["bad timestamp", "22007"],
    ["null user", "23502"],
    ["integrity conflict", "23514"],
    ["an unrecognized class", "40001"],
  ])("gives up immediately on %s (%s)", async (_label, code) => {
    const rpc = fakeRpc(async () => errorWith(code));
    const trace = store(rpc);

    await expect(trace.append(step(1))).rejects.toMatchObject({ code });
    // No retry: a state nobody has seen must stop the turn, not loop.
    expect(rpc.calls).toHaveLength(1);
    expect(trace.persistFailed).toBe(true);
  });

  it.each([
    ["a dropped connection", errorWith("08006")],
    ["a canceled statement", errorWith("57014")],
    ["a dead socket", transportFailure()],
    ["a gateway failure", { error: { message: "Bad Gateway", code: "" }, status: 503 }],
    // PostgREST's own pooler failures carry a code but no SQLSTATE, and are the
    // shape the Supabase wake-up window takes (§3.7).
    [
      "a PostgREST pooler failure",
      { error: { message: "connection to database failed", code: "PGRST001" }, status: 503 },
    ],
  ])("retries once after %s and keeps the event", async (_label, first) => {
    const rpc = fakeRpc(async (_call, attempt) =>
      attempt === 1 ? first : { data: null, error: null },
    );
    const trace = store(rpc);

    await expect(trace.append(step(1))).resolves.toBeUndefined();
    expect(rpc.calls).toHaveLength(2);
    expect(trace.persistFailed).toBe(false);
  });

  it("gives up when the retry fails as well, and reports the loss", async () => {
    const rpc = fakeRpc(async () => errorWith("08006"));
    const trace = store(rpc);

    await expect(trace.append(step(1))).rejects.toMatchObject({ code: "08006" });
    expect(rpc.calls).toHaveLength(2);
    expect(trace.persistFailed).toBe(true);
  });

  it("logs a given-up write, since the client only sees a boolean", async () => {
    const logged: { message: string; detail: Readonly<Record<string, unknown>> }[] = [];
    const rpc = fakeRpc(async () => errorWith("42501"));
    const trace = new SupabaseTraceStore({
      client: rpc.client,
      userId: "user-A",
      turnId: "turn-1",
      log: (message, detail) => logged.push({ message, detail }),
    });

    await expect(trace.append(step(1))).rejects.toMatchObject({ code: "42501" });

    expect(logged).toHaveLength(1);
    expect(logged[0].message).toMatch(/given up/);
    expect(logged[0].detail).toMatchObject({ turnId: "turn-1", seq: 1, code: "42501" });
  });

  it("treats a rejected promise as a transport fault, for clients with a custom fetch", async () => {
    // postgrest-js itself resolves failed fetches, so this is the defensive
    // path; it must still be a retryable transport failure rather than a crash.
    const rpc = fakeRpc(async (_call, attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
      return { data: null, error: null };
    });

    await expect(store(rpc).append(step(1))).resolves.toBeUndefined();
    expect(rpc.calls).toHaveLength(2);
  });

  it("prefers a real SQLSTATE over an abort that happens to be set", async () => {
    // A database that answered is authoritative: an integrity conflict must not
    // be relabelled retryable because the write budget expired in the meantime.
    const rpc = fakeRpc(
      (_call, attempt) =>
        new Promise((resolve) => {
          rpc.calls[attempt - 1].signal?.addEventListener("abort", () =>
            resolve({ error: { message: "conflict", code: "23514" }, status: 409 }),
          );
        }),
    );
    const trace = store(rpc, 5);

    await expect(trace.append(step(1))).rejects.toMatchObject({ code: "23514" });
    expect(rpc.calls).toHaveLength(1);
  });

  it("gives up when each attempt outlives the write budget", async () => {
    // Mirrors the real client: the aborted fetch resolves with an empty code and
    // status 0, so the timeout is recognised from the signal, not the error.
    const rpc = fakeRpc(
      (_call, attempt) =>
        new Promise((resolve) => {
          rpc.calls[attempt - 1].signal?.addEventListener("abort", () =>
            resolve({
              error: { message: "AbortError: aborted", code: "" },
              status: 0,
            }),
          );
        }),
    );
    const trace = store(rpc, 5);

    await expect(trace.append(step(1))).rejects.toMatchObject({ code: "57014" });
    expect(rpc.calls).toHaveLength(2);
    expect(rpc.calls[0].signal?.aborted).toBe(true);
    expect(trace.persistFailed).toBe(true);
  });
});

// ── reads ──────────────────────────────────────────────────────────────────

interface ReadCall {
  readonly table: string;
  readonly filters: [string, unknown][];
  order?: [string, { ascending: boolean }];
  limit?: number;
  maybeSingle?: boolean;
}

function fakeTable(rows: Record<string, unknown[]>): {
  readonly client: SupabaseClient;
  readonly calls: ReadCall[];
} {
  const calls: ReadCall[] = [];

  const client = {
    from(table: string) {
      const call: ReadCall = { table, filters: [] };
      calls.push(call);

      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return builder;
        },
        gt: (column: string, value: unknown) => {
          call.filters.push([`${column}>`, value]);
          return builder;
        },
        order: (column: string, options: { ascending: boolean }) => {
          call.order = [column, options];
          return builder;
        },
        limit: (count: number) => {
          call.limit = count;
          return builder;
        },
        maybeSingle: () => {
          call.maybeSingle = true;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const matched = (rows[table] ?? []).filter((row) =>
            call.filters.every(([key, value]) =>
              key.endsWith(">")
                ? Number((row as Record<string, unknown>)[key.slice(0, -1)]) >
                  Number(value)
                : (row as Record<string, unknown>)[key] === value,
            ),
          );
          // `maybeSingle` answers with the row or null, like PostgREST's
          // `Accept: application/vnd.pgrst.object` does.
          const data = call.maybeSingle ? (matched[0] ?? null) : matched;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };

      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

function readStore(client: SupabaseClient): SupabaseTraceStore {
  return new SupabaseTraceStore({
    client,
    userId: "user-A",
    turnId: "turn-1",
    log: () => {},
  });
}

describe("SupabaseTraceStore reads", () => {
  it("replays one turn in seq order, scoped to the store's own user", async () => {
    const table = fakeTable({
      turn_events: [
        { user_id: "user-A", turn_id: "turn-1", seq: 0, payload: turnStart(0) },
        { user_id: "user-A", turn_id: "turn-1", seq: 1, payload: step(1) },
        { user_id: "user-B", turn_id: "turn-1", seq: 1, payload: step(1) },
        { user_id: "user-A", turn_id: "turn-2", seq: 0, payload: turnStart(0) },
      ],
    });

    const events = await readStore(table.client).listByTurn("turn-1", 0);

    expect(events.map((event) => event.seq)).toEqual([1]);
    expect(table.calls[0]).toMatchObject({
      table: "turn_events",
      order: ["seq", { ascending: true }],
    });
    // The user filter is explicit as well as RLS-enforced: writes use the
    // service role, which bypasses RLS.
    expect(table.calls[0].filters).toEqual([
      ["user_id", "user-A"],
      ["turn_id", "turn-1"],
      ["seq>", 0],
    ]);
  });

  it("maps turn rows, coercing numerics and dropping nulls", async () => {
    const table = fakeTable({
      turns: [
        {
          id: "turn-1",
          user_id: "user-A",
          input_kind: "utterance",
          schema_version: "1.9.0",
          started_at: at(0),
          app_version: null,
          finished_at: at(3),
          stop_reason: "end_turn",
          steps: 3,
          cost_usd: "0.001500",
          latency_ms: 3000,
        },
      ],
    });

    const [summary] = await readStore(table.client).listTurns(5);

    expect(summary).toMatchObject({
      turnId: "turn-1",
      inputKind: "utterance",
      stopReason: "end_turn",
      steps: 3,
      latencyMs: 3000,
    });
    // Postgres `numeric` arrives as a string through PostgREST.
    expect(summary.costUsd).toBeCloseTo(0.0015, 6);
    expect(summary.appVersion).toBeUndefined();
  });

  it("throws a coded error when a read fails", async () => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain,
      eq: chain,
      gt: chain,
      order: async () => ({ data: null, error: { message: "denied", code: "42501" } }),
    });
    const client = { from: chain } as unknown as SupabaseClient;

    await expect(
      readStore(client).listByTurn("turn-1", 0),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("finds one turn with the owner filter applied explicitly", async () => {
    const table = fakeTable({
      turns: [
        { id: "turn-1", user_id: "user-A", input_kind: "utterance", schema_version: "1.9.0", started_at: at(0) },
        { id: "turn-2", user_id: "user-B", input_kind: "utterance", schema_version: "1.9.0", started_at: at(0) },
      ],
    });

    const found = await readStore(table.client).findTurn("turn-1");

    expect(found?.turnId).toBe("turn-1");
    // The user filter is explicit as well as RLS-enforced: an export script
    // reading through the service role must not see another user's turn (#91).
    expect(table.calls[0].filters).toEqual([
      ["user_id", "user-A"],
      ["id", "turn-1"],
    ]);
    expect(table.calls[0].maybeSingle).toBe(true);
  });

  it("reports an unknown or hidden turn as absent rather than throwing", async () => {
    const table = fakeTable({
      turns: [
        { id: "turn-9", user_id: "user-B", input_kind: "utterance", schema_version: "1.9.0", started_at: at(0) },
      ],
    });

    expect(await readStore(table.client).findTurn("turn-9")).toBeUndefined();
  });

  it("counts a stored turn_end as unfinished until the RPC finalizes it", async () => {
    // Guards the read path's own assumption: nothing here invents a stop reason
    // that the row did not carry.
    const table = fakeTable({
      turns: [
        {
          id: "turn-1",
          user_id: "user-A",
          input_kind: "utterance",
          schema_version: "1.9.0",
          started_at: at(0),
          finished_at: null,
          stop_reason: null,
          steps: null,
          cost_usd: null,
          latency_ms: null,
        },
      ],
    });

    const [summary] = await readStore(table.client).listTurns(5);
    expect(summary.finishedAt).toBeUndefined();
    expect(summary.stopReason).toBeUndefined();
    expect(summary.steps).toBeUndefined();
  });
});

describe("SupabaseTraceStore persistFailed", () => {
  it("stays false while every write lands", async () => {
    const rpc = fakeRpc(async () => ({ data: null, error: null }));
    const trace = store(rpc);

    await trace.append(turnStart(0));
    await trace.append(turnEnd(1, { seconds: 1 }));

    expect(trace.persistFailed).toBe(false);
  });
});
