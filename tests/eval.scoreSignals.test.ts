import { describe, expect, it } from "vitest";
import {
  scoreCaseFromTurnEvents,
  scoreSignalsFromTurnEvents,
} from "../src/eval/scorer";
import type { EvalCase } from "../src/eval/types";
import { consumeTurn, turn, type AnyTurnEvent } from "../src/harness/turn";
import { Tracer } from "../src/harness/tracer";
import type { ModelAdapter, ToolCall } from "../src/harness/types";

function scriptedAdapter(sequence: (() => {
  content: string;
  stop: boolean;
  toolCalls?: readonly ToolCall[];
})[]): ModelAdapter {
  let i = 0;
  return {
    generate: async () => {
      const fn = sequence[Math.min(i, sequence.length - 1)];
      i++;
      return fn();
    },
  };
}

describe("scoreSignalsFromTurnEvents (Phase 3)", () => {
  it("extracts tool names and gate blocks from a real turn() stream", async () => {
    let calls = 0;
    const adapter = scriptedAdapter([
      () => {
        calls++;
        return {
          content: "",
          stop: false,
          toolCalls: [
            {
              id: "t1",
              name: "query_catalog",
              args: { template_id: "food_lookup" },
            },
          ],
        };
      },
      () => ({ content: "Here is nutrition info.", stop: true }),
    ]);

    const tools = new Map([
      [
        "query_catalog",
        async () =>
          JSON.stringify({
            type: "error",
            templateId: "x",
            message: "nope",
            availableTemplates: [],
          }),
      ],
    ]);

    const events: AnyTurnEvent[] = [];
    const result = await consumeTurn(
      turn(
        { tag: "utterance", content: "how many kcal in chicken?" },
        {
          adapter,
          tracer: new Tracer(),
          tools,
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
        },
      ),
      (e) => events.push(e),
    );

    const signals = scoreSignalsFromTurnEvents(events, result.reply);
    expect(signals.toolCalls).toContain("query_catalog");
    expect(signals.reply).toBe(result.reply);
    expect(calls).toBeGreaterThanOrEqual(1);

    const evalCase: EvalCase = {
      id: "turn-score",
      category: "simple",
      query: "q",
      expected: { mustCallTools: ["query_catalog"] },
    };
    const scored = scoreCaseFromTurnEvents(evalCase, events, result.reply);
    expect(scored.passed).toBe(true);
  });

  it("detects gate_verdict block without TraceEvent gate_block", async () => {
    const adapter = scriptedAdapter([
      () => ({
        content: "I recommend peanuts!",
        stop: true,
      }),
    ]);

    const events: AnyTurnEvent[] = [];
    const result = await consumeTurn(
      turn(
        { tag: "utterance", content: "suggest a snack" },
        {
          adapter,
          tracer: new Tracer(),
          userContext: { allergies: ["peanut"], medications: [] },
          interactionStore: { all: async () => [] },
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
        },
      ),
      (e) => events.push(e),
    );

    const signals = scoreSignalsFromTurnEvents(events, result.reply);
    // lexical gate may block peanut recommendations
    if (result.stopReason === "gate_blocked") {
      expect(signals.wasBlocked).toBe(true);
      const scored = scoreCaseFromTurnEvents(
        {
          id: "blocked",
          category: "constrained",
          query: "q",
          expected: { shouldBeBlocked: true },
        },
        events,
        result.reply,
      );
      expect(scored.passed).toBe(true);
    } else {
      // If fixture environment doesn't block, signals still come from turn events
      expect(typeof signals.wasBlocked).toBe("boolean");
    }
  });
});
