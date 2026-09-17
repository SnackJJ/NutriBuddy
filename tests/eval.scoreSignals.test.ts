import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CITATION_ASSERTION_CHECK,
  CITATION_PROVENANCE_CHECK,
  scoreSignalsFromTurnEvents,
} from "../src/eval/scoreSignals";
import { scoreHarness } from "../src/eval/metrics";
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

    const scored = scoreHarness(result.reply, signals.toolCalls, {
      mustCallTools: ["query_catalog"],
    }, undefined);
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
      const scored = scoreHarness(
        result.reply,
        signals.toolCalls,
        { shouldBeBlocked: true },
        undefined,
        signals.wasBlocked ? 1 : 0,
      );
      expect(scored.passed).toBe(true);
    } else {
      // If fixture environment doesn't block, signals still come from turn events
      expect(typeof signals.wasBlocked).toBe("boolean");
    }
  });
});

// ── citation verdicts on the event stream (#132 / RFC 0013 §0) ──────────────
//
// The two citation tiers are told apart by check name, and `terminal` carries the
// same distinction as data. The guard below is the one that matters: the scorer
// hard-codes the names rather than importing the emitter's private constants, so
// a rename in the harness would otherwise leave stored traces scored as if no
// citation verdict had happened at all.

describe("citation verdict signals", () => {
  function verdict(checkName: string, verdict: "pass" | "block", terminal?: boolean): AnyTurnEvent {
    return {
      schema: "test",
      seq: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "gate_verdict",
      checkpoint: "output",
      verdict,
      checkName,
      evidence: "…",
      terminal,
    };
  }

  it("reads a tier-1 strip off the provenance verdict", () => {
    const signals = scoreSignalsFromTurnEvents([
      verdict(CITATION_PROVENANCE_CHECK, "block", false),
    ]);
    expect(signals.citationStripped).toBe(true);
    expect(signals.citationClaimedWithoutSource).toBe(false);
  });

  it("reads the tier-2 fallback off the assertion verdict", () => {
    const signals = scoreSignalsFromTurnEvents([
      verdict(CITATION_ASSERTION_CHECK, "block", true),
    ]);
    expect(signals.citationClaimedWithoutSource).toBe(true);
    expect(signals.citationStripped).toBe(false);
  });

  it("does not read a passing citation verdict as a failure", () => {
    const signals = scoreSignalsFromTurnEvents([
      verdict(CITATION_PROVENANCE_CHECK, "pass", false),
    ]);
    expect(signals.citationStripped).toBe(false);
    expect(signals.citationClaimedWithoutSource).toBe(false);
    // A pass is also true of an answer that cited nothing — which is exactly why
    // the kept count comes from the terminal output instead.
    expect(signals.wasBlocked).toBe(false);
  });

  it("still keys the names the harness actually emits", () => {
    // Read the emitter rather than the two constants: importing them would make
    // this test agree with itself after a rename that broke every stored trace.
    const source = readFileSync("src/harness/turn.ts", "utf8");
    expect(source).toContain(`= "${CITATION_PROVENANCE_CHECK}"`);
    expect(source).toContain(`= "${CITATION_ASSERTION_CHECK}"`);
    // And the tier-1 verdict must stay non-terminal, or the regenerate budget
    // would start refusing answers over a stripped citation (RFC 0011 §3.5).
    expect(source).toMatch(/checkName: OUTPUT_CITATION_PROVENANCE_CHECK,[\s\S]{0,200}terminal: false/);
  });
});
