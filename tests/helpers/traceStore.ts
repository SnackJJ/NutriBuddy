// Turn event fixtures for TraceStore tests. Shapes mirror src/harness/turn.ts.

import { SCHEMA_VERSION, type AnyTurnEvent } from "../../src/harness/turn";

export const T0 = "2026-07-26T10:00:00.000Z";

/** T0 + `seconds`, so latency assertions stay readable. */
export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export function turnStart(
  seq = 0,
  timestamp: string = T0,
  inputTag: "utterance" | "proposal_confirm" | "candidate_log" = "utterance",
): AnyTurnEvent {
  const input =
    inputTag === "proposal_confirm"
      ? { tag: "proposal_confirm" as const, proposalId: "p-1", confirmed: true }
      : inputTag === "candidate_log"
        ? {
            tag: "candidate_log" as const,
            foodId: "f-1",
            foodName: "apple",
            portionG: 100,
            mealType: "snack",
          }
        : { tag: "utterance" as const, content: "how much protein?" };

  return {
    schema: SCHEMA_VERSION,
    type: "turn_start",
    seq,
    timestamp,
    input,
    catalogVersion: "catalog-1",
  };
}

export function step(seq: number, timestamp: string = T0): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "step",
    seq,
    timestamp,
    agentEvent: { type: "observe", step: 0, content: "checked catalog" },
  };
}

export function modelCall(
  seq: number,
  opts: { readonly costUsd?: number; readonly seconds?: number } = {},
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "model_call",
    seq,
    timestamp: at(opts.seconds ?? 0),
    step: 0,
    model: "flash",
    thinking: false,
    latencyMs: 900,
    costUsd: opts.costUsd,
  };
}

export function gateVerdict(seq: number, seconds = 0): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "gate_verdict",
    seq,
    timestamp: at(seconds),
    checkpoint: "input",
    verdict: "pass",
    checkName: "pre_gate_input_check",
    evidence: "no constraint conflict",
  };
}

export function turnEnd(
  seq: number,
  opts: { readonly seconds?: number; readonly steps?: number; readonly stopReason?: string } = {},
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "turn_end",
    seq,
    timestamp: at(opts.seconds ?? 0),
    result: {
      reply: "about 30 g",
      steps: opts.steps ?? 3,
      stopReason: (opts.stopReason ?? "end_turn") as "end_turn",
    },
  };
}

/** The happy-path turn used by most assertions: start → step → two calls → gov → end. */
export function fullTurn(): AnyTurnEvent[] {
  return [
    turnStart(0, at(0)),
    step(1, at(1)),
    modelCall(2, { costUsd: 0.0012, seconds: 1 }),
    gateVerdict(3, 2),
    modelCall(4, { costUsd: 0.0003, seconds: 2 }),
    turnEnd(5, { seconds: 3, steps: 3, stopReason: "end_turn" }),
  ];
}
