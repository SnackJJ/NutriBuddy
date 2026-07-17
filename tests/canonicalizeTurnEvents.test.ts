import { describe, expect, it } from "vitest";
import {
  canonicalizeTurnEvents,
  commitGateShape,
} from "../src/harness/canonicalizeTurnEvents";
import type { AnyTurnEvent } from "../src/harness/turn";
import { SCHEMA_VERSION } from "../src/harness/turn";

function gate(
  partial: Omit<
    Extract<AnyTurnEvent, { type: "gate_verdict" }>,
    "schema" | "type"
  > & { schema?: string },
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "gate_verdict",
    ...partial,
  };
}

function turnEnd(
  proposalId: string,
  timestamp: string,
  seq: number,
): AnyTurnEvent {
  return {
    schema: SCHEMA_VERSION,
    type: "turn_end",
    seq,
    timestamp,
    result: {
      reply: `ok ${proposalId}`,
      steps: 1,
      stopReason: "write_proposal",
      proposal: {
        proposalId,
        foodName: "egg",
        portionG: 100,
        mealType: "breakfast",
        nutritionSource: "catalog",
        createdAt: timestamp,
      },
    },
  };
}

describe("canonicalizeTurnEvents (RFC 0001 Appendix A)", () => {
  it("maps the same proposal id to the same placeholder across events", () => {
    const rawId = "proposal-aaa-111";
    const events: AnyTurnEvent[] = [
      gate({
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        checkpoint: "commit",
        verdict: "pass",
        checkName: "commit_gate_check",
        evidence: `Proposal ${rawId} stored`,
      }),
      turnEnd(rawId, "2026-07-01T00:00:01.000Z", 1),
    ];

    const canonical = canonicalizeTurnEvents(events);
    const commit = canonical[0] as {
      evidence: string;
    };
    const end = canonical[1] as {
      result: { proposal: { proposalId: string; createdAt: string } };
    };

    expect(end.result.proposal.proposalId).toBe("<id:0>");
    expect(commit.evidence).toContain("<id:0>");
    expect(commit.evidence).not.toContain(rawId);
    expect(end.result.proposal.createdAt).toBe("<ts>");
  });

  it("assigns distinct placeholders in first-seen order, not raw string sort", () => {
    // Lexicographic order would sort "proposal-a-..." before "proposal-z-...";
    // first-seen must keep z → <id:0>, a → <id:1>.
    const first = "proposal-z-later-alpha";
    const second = "proposal-a-earlier-alpha";
    const events: AnyTurnEvent[] = [
      turnEnd(first, "2026-07-01T00:00:00.000Z", 0),
      turnEnd(second, "2026-07-01T00:00:01.000Z", 1),
    ];

    const canonical = canonicalizeTurnEvents(events) as {
      result: { proposal: { proposalId: string } };
    }[];

    expect(canonical[0].result.proposal.proposalId).toBe("<id:0>");
    expect(canonical[1].result.proposal.proposalId).toBe("<id:1>");

    // Reverse appearance: second raw id becomes <id:0>.
    const swapped = canonicalizeTurnEvents([events[1], events[0]]) as {
      result: { proposal: { proposalId: string } };
    }[];
    expect(swapped[0].result.proposal.proposalId).toBe("<id:0>");
    expect(swapped[1].result.proposal.proposalId).toBe("<id:1>");

    // Same raw id always maps to the same placeholder within a stream, but
    // which placeholder index it gets depends on first-seen order.
    expect(JSON.stringify(canonical)).toContain('"<id:0>"');
    expect(JSON.stringify(canonical)).toContain('"<id:1>"');
    expect(canonical).not.toEqual(swapped);
  });

  it("preserves cross-event structured id equality after canonicalize", () => {
    const rawId = "proposal-shared-99";
    const events: AnyTurnEvent[] = [
      {
        schema: SCHEMA_VERSION,
        type: "step",
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        agentEvent: {
          type: "act",
          step: 1,
          toolCall: {
            id: "call-1",
            name: "log_meal",
            args: { food: "egg" },
          },
        },
      },
      turnEnd(rawId, "2026-07-01T00:00:02.000Z", 1),
      gate({
        seq: 2,
        timestamp: "2026-07-01T00:00:03.000Z",
        checkpoint: "commit",
        verdict: "pass",
        checkName: "commit_gate_check",
        evidence: `Proposal ${rawId} stored — no meal ledger mutation`,
      }),
    ];

    const canonical = canonicalizeTurnEvents(events);
    const step = canonical[0] as {
      agentEvent: { toolCall: { id: string } };
    };
    const end = canonical[1] as {
      result: { proposal: { proposalId: string } };
    };

    expect(step.agentEvent.toolCall.id).toBe("<id:0>");
    expect(end.result.proposal.proposalId).toBe("<id:1>");
    // Lineage: evidence rewrite uses the same map entry as structured proposalId.
    const commit = canonical[2] as { evidence: string };
    expect(commit.evidence).toContain(end.result.proposal.proposalId);
  });

  it("is neutral to timestamp and latency/cost noise", () => {
    const base: AnyTurnEvent[] = [
      {
        schema: SCHEMA_VERSION,
        type: "model_call",
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        step: 1,
        model: "flash",
        thinking: true,
        latencyMs: 12,
        costUsd: 0.001,
      },
      gate({
        seq: 1,
        timestamp: "2026-07-01T00:00:01.000Z",
        checkpoint: "output",
        verdict: "pass",
        checkName: "post_gate_output_check",
        evidence: "ok",
      }),
    ];

    const noisy: AnyTurnEvent[] = [
      {
        ...base[0],
        timestamp: "2099-01-01T12:34:56.789Z",
        latencyMs: 9999,
        costUsd: 42,
      } as AnyTurnEvent,
      {
        ...base[1],
        timestamp: "2099-01-01T12:34:57.000Z",
      } as AnyTurnEvent,
    ];

    expect(canonicalizeTurnEvents(base)).toEqual(canonicalizeTurnEvents(noisy));
  });

  it("does not bijection-normalize catalog food ids", () => {
    const foodId = "fdc-seed-egg-001";
    const events: AnyTurnEvent[] = [
      {
        schema: SCHEMA_VERSION,
        type: "turn_end",
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        result: {
          reply: "recommend",
          steps: 1,
          stopReason: "end_turn",
          output: {
            prose: "eggs",
            foodRefs: [
              {
                foodId,
                foodName: "Egg",
                matchType: "exact",
                allergens: ["egg"],
              },
            ],
            ruleRefs: [],
          },
        },
      },
    ];

    const canonical = canonicalizeTurnEvents(events) as {
      result: { output: { foodRefs: { foodId: string }[] } };
    }[];

    expect(canonical[0].result.output.foodRefs[0].foodId).toBe(foodId);
  });

  it("K5 vs K6 commit-gate shapes match when only reason fields are compared", () => {
    // Different free-text evidence (would be illegal in Phase 1 goldens) —
    // commitGateShape ignores evidence so collapsed contract is enforceable.
    const k5: AnyTurnEvent[] = [
      gate({
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        checkpoint: "input",
        verdict: "pass",
        checkName: "pre_gate_input_check",
        evidence: "n/a",
      }),
      gate({
        seq: 1,
        timestamp: "2026-07-01T00:00:01.000Z",
        checkpoint: "commit",
        verdict: "block",
        checkName: "not_committable",
        evidence: "belongs to user A not B",
      }),
    ];
    const k6: AnyTurnEvent[] = [
      gate({
        seq: 0,
        timestamp: "2026-07-01T00:00:00.000Z",
        checkpoint: "input",
        verdict: "pass",
        checkName: "pre_gate_input_check",
        evidence: "n/a",
      }),
      gate({
        seq: 1,
        timestamp: "2026-07-01T00:00:01.000Z",
        checkpoint: "commit",
        verdict: "block",
        checkName: "not_committable",
        evidence: "already committed",
      }),
    ];

    expect(commitGateShape(k5)).toEqual(commitGateShape(k6));
    expect(commitGateShape(k5)).toEqual([
      {
        checkpoint: "commit",
        verdict: "block",
        checkName: "not_committable",
      },
    ]);
  });
});
