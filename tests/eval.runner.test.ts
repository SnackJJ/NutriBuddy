import { describe, it, expect } from "vitest";
import { runEval } from "../src/eval/runner";
import type { EvalCase, TraceProducer } from "../src/eval/types";
import type { TraceEvent, TraceInput } from "../src/harness/tracer";

function trace(...events: TraceInput[]): TraceEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

const cases: EvalCase[] = [
  {
    name: "needs-tool",
    category: "simple_query",
    userProfile: {},
    query: "q1",
    expected: { must_call_tools: ["get_food_nutrition"] },
  },
  {
    name: "needs-block",
    category: "cross_domain_conflict",
    userProfile: { medications: ["warfarin"] },
    query: "q2",
    expected: { should_be_blocked: true },
  },
];

describe("runEval", () => {
  it("scores each case via the injected producer and aggregates totals", async () => {
    // producer: first case calls the tool (pass), second never blocks (fail).
    const producer: TraceProducer = async (c) =>
      c.name === "needs-tool"
        ? trace({ step: 1, type: "tool_call", payload: "get_food_nutrition" })
        : trace({
            step: 1,
            type: "model_return",
            payload: "sure, eat spinach",
          });

    const report = await runEval(cases, producer);

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results.map((r) => r.name)).toEqual([
      "needs-tool",
      "needs-block",
    ]);
    expect(report.results.find((r) => r.name === "needs-tool")?.passed).toBe(
      true,
    );
    expect(report.results.find((r) => r.name === "needs-block")?.passed).toBe(
      false,
    );
  });

  it("reports a case as failed when its producer throws (rather than crashing the run)", async () => {
    const producer: TraceProducer = async () => {
      throw new Error("model offline");
    };

    const report = await runEval(cases, producer);

    expect(report.total).toBe(2);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.results[0].failures[0].detail).toContain("model offline");
  });
});
