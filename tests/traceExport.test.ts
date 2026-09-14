// Trace export (#91 / RFC 0008 §T9, §3.8).
//
// Two properties carry the weight here:
//   * the default export is desensitized — no user id, no free text — because
//     §3.8 makes that a decision, and a default that leaks is a decision too;
//   * the summary answers "why was this turn blocked" from the gate verdicts and
//     the terminal, without needing a reader to open the event dump.

import { describe, expect, it } from "vitest";
import {
  buildExportedTurn,
  collectExportedTurns,
  isRedactionMarker,
  pseudonymizeUserId,
  redactTraceValue,
  renderExportedJson,
  renderExportedMarkdown,
  utcDayWindow,
  TurnNotFoundError,
  type ExportedTurn,
  type TraceExportSource,
  type TurnRangeQuery,
} from "../src/harness/traceExport";
import type { AnyTurnEvent } from "../src/harness/turn";
import { SCHEMA_VERSION } from "../src/harness/turn";
import type { TurnSummary } from "../src/harness/traceStore";
import { at, fullTurn, turnEnd, turnStart } from "./helpers/traceStore";

const USER = "11111111-2222-3333-4444-555555555555";

function summary(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turnId: "turn-1",
    userId: USER,
    inputKind: "utterance",
    schemaVersion: SCHEMA_VERSION,
    startedAt: at(0),
    finishedAt: at(3),
    stopReason: "end_turn",
    steps: 3,
    costUsd: 0.0015,
    latencyMs: 3000,
    ...overrides,
  };
}

/** start → tool gate block → turn_end{gate_blocked}. */
function blockedTurn(): AnyTurnEvent[] {
  return [
    turnStart(0, at(0)),
    {
      schema: SCHEMA_VERSION,
      type: "gate_verdict",
      seq: 1,
      timestamp: at(1),
      checkpoint: "tool",
      verdict: "block",
      checkName: "tool_outcome_gate",
      reasonCode: "portion_exceeds_daily_max",
      evidence: "portion 900 g exceeds the 500 g cap for chicken",
    },
    turnEnd(2, { seconds: 2, steps: 1, stopReason: "gate_blocked" }),
  ];
}

function renderOptions(withText = false) {
  return {
    exportedAt: "2026-09-13T21:00:00.000Z",
    source: "http://127.0.0.1:54321",
    withText,
  };
}

describe("redaction", () => {
  it("replaces a user id with a stable pseudonym", () => {
    const first = pseudonymizeUserId(USER);
    expect(first).toBe(pseudonymizeUserId(USER));
    expect(first).not.toContain(USER);
    expect(first).toMatch(/^u_[0-9a-f]{12}$/);
    expect(pseudonymizeUserId("another-user")).not.toBe(first);
  });

  it("withholds free text at any depth, keeping length and a correlation hash", () => {
    const redacted = redactTraceValue({
      type: "step",
      agentEvent: { type: "observe", content: "you ate 2 eggs" },
    }) as { agentEvent: { content: unknown } };

    expect(isRedactionMarker(redacted.agentEvent.content)).toBe(true);
    const marker = redacted.agentEvent.content as { chars: number; sha256: string };
    expect(marker.chars).toBe("you ate 2 eggs".length);
    expect(JSON.stringify(redacted)).not.toContain("eggs");
  });

  it("keeps the same text recognisable across fields without keeping the words", () => {
    const first = redactTraceValue({ content: "chicken" });
    const second = redactTraceValue({ content: "chicken" });
    const other = redactTraceValue({ content: "chicken " });
    expect(first).toEqual(second);
    expect(other).not.toEqual(first);
  });

  it("keeps numbers, verdicts and structured facts untouched", () => {
    const event = blockedTurn()[1];
    const redacted = redactTraceValue(event) as Record<string, unknown>;
    expect(redacted.checkpoint).toBe("tool");
    expect(redacted.verdict).toBe("block");
    expect(redacted.reasonCode).toBe("portion_exceeds_daily_max");
    expect(redacted.seq).toBe(1);
  });

  it("pseudonymizes an identity field wherever it appears", () => {
    const redacted = redactTraceValue({ user_id: USER }) as { user_id: string };
    expect(redacted.user_id).toBe(pseudonymizeUserId(USER));
  });

  it("withText is the opt-out and keeps the text verbatim", () => {
    const redacted = redactTraceValue(
      { agentEvent: { content: "you ate 2 eggs" } },
      { withText: true },
    ) as { agentEvent: { content: string } };
    expect(redacted.agentEvent.content).toBe("you ate 2 eggs");
  });
});

describe("buildExportedTurn", () => {
  it("names the blocking gate and the checkpoint in `why`", () => {
    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked", steps: 1 }), blockedTurn());

    expect(turn.status).toBe("blocked");
    expect(turn.why).toContain("tool gate block");
    expect(turn.why).toContain("checkName=tool_outcome_gate");
    expect(turn.why).toContain("reasonCode=portion_exceeds_daily_max");
    expect(turn.gates).toHaveLength(1);
    expect(turn.gates[0].evidence).toMatchObject({ redacted: "text" } as object);
  });

  it("counts additional non-passing gates instead of hiding them", () => {
    const events: AnyTurnEvent[] = [
      turnStart(0, at(0)),
      {
        schema: SCHEMA_VERSION,
        type: "gate_verdict",
        seq: 1,
        timestamp: at(1),
        checkpoint: "input",
        verdict: "error",
        checkName: "input_gate_error",
        evidence: "gate threw",
      },
      {
        schema: SCHEMA_VERSION,
        type: "gate_verdict",
        seq: 2,
        timestamp: at(1),
        checkpoint: "tool",
        verdict: "block",
        checkName: "tool_outcome_gate",
        evidence: "blocked",
      },
      turnEnd(3, { seconds: 2, stopReason: "gate_blocked" }),
    ];

    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked" }), events);
    expect(turn.why).toContain("input gate error");
    expect(turn.why).toContain("+1 more");
  });

  it("calls a turn without a terminal unfinished, and says what that means", () => {
    const turn = buildExportedTurn(summary({ finishedAt: undefined, stopReason: undefined }), [
      turnStart(0, at(0)),
    ]);

    expect(turn.status).toBe("unfinished");
    expect(turn.why).toContain("no turn_end event");
    expect(turn.why).toContain("still running");
  });

  it("reports a crash as a crash even when a gate also failed", () => {
    const events: AnyTurnEvent[] = [
      turnStart(0, at(0)),
      turnEnd(1, { seconds: 1, stopReason: "crash" }),
    ];
    const turn = buildExportedTurn(summary({ stopReason: "crash" }), events);
    expect(turn.status).toBe("crashed");
    expect(turn.why).toContain("stopReason=crash");
  });

  it("flags a gate_blocked terminal with no blocking verdict as a trace finding", () => {
    const events: AnyTurnEvent[] = [
      turnStart(0, at(0)),
      turnEnd(1, { seconds: 1, stopReason: "gate_blocked" }),
    ];
    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked" }), events);
    expect(turn.status).toBe("blocked");
    expect(turn.why).toContain("no non-passing gate_verdict");
  });

  it("keeps a normal turn's row numbers, which the RPC aggregated in SQL", () => {
    const turn = buildExportedTurn(summary(), fullTurn());
    expect(turn.status).toBe("finished");
    expect(turn.costUsd).toBe(0.0015);
    expect(turn.latencyMs).toBe(3000);
    expect(turn.why).toBe("stopReason=end_turn steps=3");
  });

  it("never carries the raw user id", () => {
    const turn = buildExportedTurn(summary(), fullTurn());
    expect(turn.user).toBe(pseudonymizeUserId(USER));
    expect(JSON.stringify(turn)).not.toContain(USER);
  });

  it("summarises each event type on the timeline", () => {
    const turn = buildExportedTurn(summary(), fullTurn());
    const details = turn.timeline.map((row) => row.detail);
    expect(details[0]).toBe(`input=utterance <text ${"how much protein?".length} chars>`);
    expect(details.some((d) => d.startsWith("model=flash latency=900ms"))).toBe(true);
    expect(details.some((d) => d === "input pass pre_gate_input_check")).toBe(true);
    expect(details.at(-1)).toBe("stopReason=end_turn steps=3");
  });
});

describe("rendering", () => {
  it("puts the verdict and the reason above the timeline", () => {
    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked" }), blockedTurn());
    const markdown = renderExportedMarkdown([turn], renderOptions());

    expect(markdown).toContain("## `turn-1` — BLOCKED");
    expect(markdown).toContain("why: tool gate block");
    expect(markdown.indexOf("why:")).toBeLessThan(markdown.indexOf("### timeline"));
    expect(markdown).toContain("| 1 | tool | block | `tool_outcome_gate` |");
    expect(markdown).not.toContain("500 g cap");
  });

  it("renders the redaction marker instead of withheld evidence", () => {
    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked" }), blockedTurn());
    expect(renderExportedMarkdown([turn], renderOptions())).toMatch(
      /<text \d+ chars, sha256 [0-9a-f]{8}>/,
    );
  });

  it("includes evidence when the caller opts out of redaction", () => {
    const turn = buildExportedTurn(summary({ stopReason: "gate_blocked" }), blockedTurn(), {
      withText: true,
    });
    const markdown = renderExportedMarkdown([turn], renderOptions(true));
    expect(markdown).toContain("500 g cap");
    expect(markdown).toContain("**off**");
  });

  it("says so when nothing matched", () => {
    expect(renderExportedMarkdown([], renderOptions())).toContain("_No turns matched._");
  });

  it("writes machine-readable JSON that names the redaction mode", () => {
    const turn = buildExportedTurn(summary(), fullTurn());
    const parsed = JSON.parse(renderExportedJson([turn], renderOptions())) as {
      redaction: string;
      turns: ExportedTurn[];
    };
    expect(parsed.redaction).toBe("text-withheld");
    expect(parsed.turns[0].turnId).toBe("turn-1");
    expect(parsed.turns[0].events).toHaveLength(fullTurn().length);
  });
});

describe("utcDayWindow", () => {
  it("is a half-open UTC day", () => {
    expect(utcDayWindow("2026-09-13")).toEqual({
      since: "2026-09-13T00:00:00.000Z",
      until: "2026-09-14T00:00:00.000Z",
    });
  });

  it("refuses anything that is not a calendar day", () => {
    expect(() => utcDayWindow("2026-9-13")).toThrow(/YYYY-MM-DD/);
    expect(() => utcDayWindow("yesterday")).toThrow(/YYYY-MM-DD/);
    expect(() => utcDayWindow("2026-13-01")).toThrow(/real calendar day/);
  });
});

describe("collectExportedTurns", () => {
  function fakeSource(turns: readonly TurnSummary[], events: readonly AnyTurnEvent[]) {
    const ranges: TurnRangeQuery[] = [];
    const source: TraceExportSource & { readonly ranges: TurnRangeQuery[] } = {
      ranges,
      findTurn: async (turnId) => turns.find((turn) => turn.turnId === turnId),
      listTurnsInRange: async (query) => {
        ranges.push(query);
        return [...turns];
      },
      listByTurn: async () => [...events],
    };
    return source;
  }

  it("refuses to export a turn that does not exist rather than printing an empty file", async () => {
    const source = fakeSource([summary()], fullTurn());
    await expect(
      collectExportedTurns(source, { kind: "turn", turnId: "missing" }),
    ).rejects.toBeInstanceOf(TurnNotFoundError);
  });

  it("passes the day window through to the source", async () => {
    const source = fakeSource([summary()], fullTurn());
    const window = utcDayWindow("2026-09-13");
    const turns = await collectExportedTurns(source, {
      kind: "range",
      userId: USER,
      limit: 10,
      ...window,
    });

    expect(source.ranges).toEqual([{ userId: USER, limit: 10, ...window }]);
    expect(turns).toHaveLength(1);
  });
});
