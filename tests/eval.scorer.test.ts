import { describe, it, expect } from "vitest";
import { scoreCase } from "../src/eval/scorer";
import type { EvalCase } from "../src/eval/types";
import type { TraceEvent, TraceInput } from "../src/harness/tracer";

// 小工具：把一串 TraceInput 编号成 TraceEvent[]（与 Tracer 的 seq 约定一致）。
function trace(...events: TraceInput[]): TraceEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

const baseCase: EvalCase = {
  name: "x",
  category: "simple_query",
  userProfile: {},
  query: "q",
  expected: {},
};

describe("scoreCase", () => {
  it("passes when no expectations are declared", () => {
    const r = scoreCase(baseCase, trace());
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.name).toBe("x");
  });

  describe("must_call_tools", () => {
    it("passes when the required tool was called", () => {
      const c = {
        ...baseCase,
        expected: { must_call_tools: ["get_food_nutrition"] },
      };
      const r = scoreCase(
        c,
        trace({ step: 1, type: "tool_call", payload: "get_food_nutrition" }),
      );
      expect(r.passed).toBe(true);
    });

    it("fails when the required tool was not called", () => {
      const c = {
        ...baseCase,
        expected: { must_call_tools: ["get_food_nutrition"] },
      };
      const r = scoreCase(
        c,
        trace({ step: 1, type: "model_return", payload: "guessing" }),
      );
      expect(r.passed).toBe(false);
      expect(r.failures[0].check).toBe("must_call_tools");
    });

    it("reads the tool name out of a JSON tool_call payload", () => {
      const c = {
        ...baseCase,
        expected: { must_call_tools: ["normalize_food"] },
      };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "tool_call",
          payload: '{"name":"normalize_food","args":{"q":"rice"}}',
        }),
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("must_not_contain", () => {
    it("fails when the final reply contains a forbidden phrase (case-insensitive)", () => {
      const c = { ...baseCase, expected: { must_not_contain: ["peanut"] } };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "model_return",
          payload: "Try a PEANUT butter snack",
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.failures[0].check).toBe("must_not_contain");
    });

    it("only checks the final model_return, not intermediate steps", () => {
      const c = { ...baseCase, expected: { must_not_contain: ["peanut"] } };
      const r = scoreCase(
        c,
        trace(
          { step: 1, type: "model_return", payload: "maybe peanut?" },
          {
            step: 2,
            type: "model_return",
            payload: "actually, almonds-free oat bars",
          },
        ),
      );
      expect(r.passed).toBe(true);
    });
  });

  describe("should_ask_clarification", () => {
    it("passes when the final reply asks a question", () => {
      const c = { ...baseCase, expected: { should_ask_clarification: true } };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "model_return",
          payload: "What kind of sandwich was it?",
        }),
      );
      expect(r.passed).toBe(true);
    });

    it("fails when the final reply just answers without asking", () => {
      const c = { ...baseCase, expected: { should_ask_clarification: true } };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "model_return",
          payload: "A sandwich has about 300 calories.",
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.failures[0].check).toBe("should_ask_clarification");
    });
  });

  describe("should_be_blocked", () => {
    it("passes when a post_gate_blocked event is present", () => {
      const c = { ...baseCase, expected: { should_be_blocked: true } };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "post_gate_blocked",
          payload: "warfarin ∩ vitamin K",
        }),
      );
      expect(r.passed).toBe(true);
    });

    it("fails when nothing blocked the reply", () => {
      const c = { ...baseCase, expected: { should_be_blocked: true } };
      const r = scoreCase(
        c,
        trace({
          step: 1,
          type: "model_return",
          payload: "Sure, eat lots of spinach!",
        }),
      );
      expect(r.passed).toBe(false);
      expect(r.failures[0].check).toBe("should_be_blocked");
    });
  });

  it("accumulates multiple failures across checks", () => {
    const c: EvalCase = {
      ...baseCase,
      expected: {
        must_call_tools: ["get_food_nutrition"],
        should_be_blocked: true,
      },
    };
    const r = scoreCase(
      c,
      trace({ step: 1, type: "model_return", payload: "..." }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.check).sort()).toEqual([
      "must_call_tools",
      "should_be_blocked",
    ]);
  });
});
