// Trace aggregation (#93 / RFC 0009 §4).
//
// The numbers that matter are the ones the report will be read for: "is it the
// model or the database", "what does a turn cost", "how often does a gate fire".
// The one thing this module must not do is a second aggregation of a number SQL
// already computed — cost and turn latency come from the row (RFC 0008 §3.4),
// and the tests say so by making the events disagree with the row and asserting
// the row wins.

import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type AnyTurnEvent } from "../src/harness/turn";
import type { TurnSummary } from "../src/harness/traceStore";
import {
  aggregateTraces,
  collectTraceMetrics,
  sampleTurn,
  traceWriteLatencyMs,
  type TraceAggregateSource,
  type TraceEventRow,
  type TurnSampleWithWrites,
} from "../src/eval/traceMetrics";
import { METRIC_DEFINITIONS } from "../src/eval/summary";

const T0 = "2026-09-13T10:00:00.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function row(payload: AnyTurnEvent, createdAt: string): TraceEventRow {
  return { payload, createdAt };
}

function turnStart(seq = 0, timestamp = T0): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "turn_start",
    seq,
    timestamp,
    input: { tag: "utterance", content: "how much protein?" },
  };
}

function modelCall(
  seq: number,
  opts: { readonly seconds?: number; readonly latencyMs?: number; readonly costUsd?: number } = {},
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "model_call",
    seq,
    timestamp: at(opts.seconds ?? 0),
    step: 0,
    model: "flash",
    thinking: false,
    latencyMs: opts.latencyMs,
    costUsd: opts.costUsd,
  };
}

function modelCallWithUsage(
  seq: number,
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number },
  seconds = 0,
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "model_call",
    seq,
    timestamp: at(seconds),
    step: 0,
    model: "flash",
    thinking: false,
    latencyMs: 100,
    usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens },
  };
}

function gate(
  seq: number,
  checkpoint: "input" | "tool" | "output" | "commit",
  verdict: "pass" | "block" | "error",
  checkName: string,
  seconds = 0,
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "gate_verdict",
    seq,
    timestamp: at(seconds),
    checkpoint,
    verdict,
    checkName,
    evidence: "evidence",
  };
}

function turnEnd(seq: number, stopReason = "end_turn", steps = 3, seconds = 2): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "turn_end",
    seq,
    timestamp: at(seconds),
    result: { reply: "about 30 g", steps, stopReason: stopReason as "end_turn" },
  };
}

function summary(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turnId: "turn-1",
    userId: "user-a",
    inputKind: "utterance",
    schemaVersion: SCHEMA_VERSION,
    startedAt: T0,
    finishedAt: at(2),
    stopReason: "end_turn",
    steps: 3,
    costUsd: 0.002,
    latencyMs: 2000,
    ...overrides,
  };
}

const WINDOW = { since: "2026-09-13T00:00:00.000Z", until: "2026-09-14T00:00:00.000Z" };

describe("sampleTurn", () => {
  it("pulls the gates, the model calls and the terminal out of the event stream", () => {
    const rows = [
      row(turnStart(), at(0)),
      row(gate(1, "input", "pass", "pre_gate_input_check"), at(0)),
      row(modelCall(2, { latencyMs: 900, costUsd: 0.0012 }), at(1)),
      row(gate(3, "tool", "block", "tool_outcome_gate"), at(1)),
      row(turnEnd(4), at(2)),
    ];

    const sample = sampleTurn(summary(), rows);
    expect(sample.modelCalls).toEqual([{ latencyMs: 900, usage: undefined }]);
    expect(sample.gates).toEqual([
      { checkpoint: "input", verdict: "pass", checkName: "pre_gate_input_check" },
      { checkpoint: "tool", verdict: "block", checkName: "tool_outcome_gate" },
    ]);
    expect(sample.stopReason).toBe("end_turn");
    expect(sample.steps).toBe(3);
  });

  it("falls back to the terminal event for a row whose columns were never written", () => {
    const unfinished = summary({ stopReason: undefined, steps: undefined, finishedAt: undefined });
    const sample = sampleTurn(unfinished, [row(turnStart(), at(0)), row(turnEnd(1, "end_turn", 7), at(2))]);
    expect(sample.stopReason).toBe("end_turn");
    expect(sample.steps).toBe(7);
  });
});

describe("traceWriteLatencyMs", () => {
  it("is the difference between the producer timestamp and the write", () => {
    expect(traceWriteLatencyMs([row(turnStart(0, T0), at(1))])).toEqual([1000]);
  });

  it("clamps a negative difference to zero: that is clock skew, not speed", () => {
    expect(traceWriteLatencyMs([row(turnStart(0, at(5)), at(1))])).toEqual([0]);
  });

  it("skips an unparsable timestamp instead of reporting NaN", () => {
    const rows = [row(turnStart(0, "not-a-date"), at(1)), row(turnStart(0, T0), "junk")];
    expect(traceWriteLatencyMs(rows)).toEqual([]);
  });
});

describe("aggregateTraces", () => {
  function samples(): TurnSampleWithWrites[] {
    const first = summary({ turnId: "t1", costUsd: 0.002, latencyMs: 2000, stopReason: "end_turn" });
    const second = summary({
      turnId: "t2",
      costUsd: 0.01,
      latencyMs: 4000,
      stopReason: "gate_blocked",
      steps: 5,
    });

    return [
      {
        turn: sampleTurn(first, [
          row(turnStart(), at(0)),
          row(modelCall(1, { latencyMs: 800 }), at(1)),
          row(gate(2, "output", "pass", "output_entity_gate"), at(1)),
          row(turnEnd(3), at(2)),
        ]),
        writeLatenciesMs: [30, 40],
      },
      {
        turn: sampleTurn(second, [
          row(turnStart(), at(0)),
          row(modelCall(1, { latencyMs: 1200 }), at(1)),
          row(gate(2, "input", "block", "pre_gate_input_check"), at(1)),
          row(gate(3, "input", "pass", "pre_gate_input_check"), at(1)),
          row(turnEnd(4, "gate_blocked", 5), at(4)),
        ]),
        writeLatenciesMs: [50],
      },
    ];
  }

  it("takes turn latency and cost from the row the RPC aggregated", () => {
    const metrics = aggregateTraces(samples(), WINDOW, METRIC_DEFINITIONS);
    expect(metrics.turnLatency.n).toBe(2);
    expect(metrics.turnLatency.p50).toBe(2000);
    expect(metrics.turnLatency.p95).toBe(4000);
    expect(metrics.cost.totalUsd).toBeCloseTo(0.012);
    expect(metrics.cost.perTurn.mean).toBeCloseTo(0.006);
  });

  it("leaves a turn without a latency column out of the distribution rather than recomputing it", () => {
    const noLatency: TurnSampleWithWrites[] = [
      {
        turn: sampleTurn(summary({ latencyMs: undefined }), [
          row(turnStart(), at(0)),
          row(turnEnd(1, "end_turn", 3, 9), at(9)),
        ]),
        writeLatenciesMs: [],
      },
    ];
    const metrics = aggregateTraces(noLatency, WINDOW, METRIC_DEFINITIONS);
    expect(metrics.turnLatency).toEqual({ n: 0 });
  });

  it("keeps model-call latency and trace-write latency apart from each other", () => {
    const metrics = aggregateTraces(samples(), WINDOW, METRIC_DEFINITIONS);
    expect(metrics.modelCallLatency).toMatchObject({ n: 2, p50: 800, p95: 1200 });
    expect(metrics.traceWriteLatency).toMatchObject({ n: 3, p50: 40, p95: 50 });
  });

  it("counts terminal reasons and gate outcomes", () => {
    const metrics = aggregateTraces(samples(), WINDOW, METRIC_DEFINITIONS);
    expect(metrics.stopReasons).toEqual([
      { key: "end_turn", count: 1, share: 0.5 },
      { key: "gate_blocked", count: 1, share: 0.5 },
    ]);
    expect(metrics.gates.checkpointVerdict).toEqual([
      { key: "input/block", count: 1, share: 1 / 3 },
      { key: "input/pass", count: 1, share: 1 / 3 },
      { key: "output/pass", count: 1, share: 1 / 3 },
    ]);
    expect(metrics.gates.topCheckNames[0]).toEqual({
      key: "pre_gate_input_check",
      count: 2,
      share: 2 / 3,
    });
    expect(metrics.steps).toMatchObject({ n: 2, p50: 3, p95: 5 });
  });

  it("has no cache-hit rate when the provider reported no prompt tokens (除零)", () => {
    const withoutUsage: TurnSampleWithWrites[] = [
      { turn: sampleTurn(summary(), [row(turnStart(), at(0))]), writeLatenciesMs: [] },
    ];
    const metrics = aggregateTraces(withoutUsage, WINDOW, METRIC_DEFINITIONS);
    expect(metrics.cost.promptTokens).toBe(0);
    expect(metrics.cost.cacheHitRate).toBeUndefined();
    expect(metrics.cost.tokenIn).toBe(0);
    expect(metrics.cost.tokenOut).toBe(0);
  });

  it("computes the cache-hit share from the usage it read off the events", () => {
    const withUsage: TurnSampleWithWrites[] = [
      {
        turn: sampleTurn(summary(), [
          row(turnStart(), at(0)),
          row(modelCallWithUsage(1, { promptTokens: 1000, completionTokens: 50, cacheHitTokens: 600 }), at(1)),
          row(modelCallWithUsage(2, { promptTokens: 200, completionTokens: 10, cacheHitTokens: 0 }), at(1)),
        ]),
        writeLatenciesMs: [],
      },
    ];
    const metrics = aggregateTraces(withUsage, WINDOW, METRIC_DEFINITIONS);
    expect(metrics.cost.tokenIn).toBe(1200);
    expect(metrics.cost.tokenOut).toBe(60);
    expect(metrics.cost.cacheHitRate).toBeCloseTo(600 / 1200);
  });

  it("describes an empty window without pretending to have data", () => {
    const metrics = aggregateTraces([], WINDOW, METRIC_DEFINITIONS);
    expect(metrics.turns).toBe(0);
    expect(metrics.turnLatency).toEqual({ n: 0 });
    expect(metrics.cost).toMatchObject({ n: 0, totalUsd: 0 });
    expect(metrics.stopReasons).toEqual([]);
    expect(metrics.window).toEqual(WINDOW);
  });
});

describe("collectTraceMetrics", () => {
  function fakeSource(): TraceAggregateSource & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      listTurns: async (query) => {
        calls.push(`listTurns:${query.since}..${query.until}:${query.limit}`);
        return [summary({ turnId: "t1" }), summary({ turnId: "t2", costUsd: 0.004 })];
      },
      listEvents: async (turnId) => {
        calls.push(`listEvents:${turnId}`);
        return [
          row(turnStart(), at(0)),
          row(modelCall(1, { latencyMs: 500 }), at(1)),
        ];
      },
    };
  }

  it("reads the window it was given and aggregates per turn", async () => {
    const source = fakeSource();
    const metrics = await collectTraceMetrics(
      source,
      { ...WINDOW, limit: 25 },
      METRIC_DEFINITIONS,
    );

    expect(source.calls).toEqual([
      `listTurns:${WINDOW.since}..${WINDOW.until}:25`,
      "listEvents:t1",
      "listEvents:t2",
    ]);
    expect(metrics.turns).toBe(2);
    expect(metrics.cost.totalUsd).toBeCloseTo(0.006);
    expect(metrics.window).toEqual(WINDOW);
  });
});
