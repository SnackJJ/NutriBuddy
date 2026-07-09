import { describe, it, expect } from "vitest";
import { runLiveComplianceEval } from "../src/eval/live-compliance";
import type { EvalCase } from "../src/eval/types";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolCall,
} from "../src/harness/types";
import type {
  DrugNutrientInteraction,
  InteractionStore,
} from "../src/lib/drugInteractions";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stubAdapter(
  impl: (req: ModelRequest) => ModelResponse | Promise<ModelResponse>,
): ModelAdapter {
  return { generate: async (req) => impl(req) };
}

function fakeInteractionStore(
  rows: DrugNutrientInteraction[],
): InteractionStore {
  return { all: async () => rows };
}

function emptyTools(): ReadonlyMap<string, ToolHandler> {
  return new Map<string, ToolHandler>();
}

function searchFoodTools(
  result = "chicken: 31g protein/100g",
): ReadonlyMap<string, ToolHandler> {
  return new Map([["search_food", async () => result]]);
}

// ─── runLiveComplianceEval ────────────────────────────────────────────────

describe("runLiveComplianceEval", () => {
  it("records compliance signals for a basic case", async () => {
    const adapter = stubAdapter(() => ({
      content: "Chicken has 31g protein per 100g.",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: {},
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    expect(report.signals).toHaveLength(1);
    const signal = report.signals[0];
    expect(signal.caseId).toBe("t1");
    expect(signal.response).toBe("Chicken has 31g protein per 100g.");
    expect(signal.toolUse).toBeDefined();
    expect(signal.gateVerdicts).toBeDefined();
    expect(signal.typedOutput).toBeDefined();
    expect(signal.terminalOutcome).toBeDefined();
  });

  it("collects all gate verdicts from the turn stream", async () => {
    const adapter = stubAdapter(() => ({
      content: "Here is some nutritional advice.",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];

    // Expect at minimum: input, output, commit gate verdicts
    expect(signal.gateVerdicts.length).toBeGreaterThanOrEqual(3);
    const checkpoints = signal.gateVerdicts.map((v) => v.checkpoint);
    expect(checkpoints).toContain("input");
    expect(checkpoints).toContain("output");
    expect(checkpoints).toContain("commit");
  });

  it("detects tool compliance when expected tools are called", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up food...",
          stop: false,
          toolCalls: [
            {
              name: "search_food",
              args: { food: "chicken" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "Chicken has 31g protein per 100g.", stop: true };
    });

    const tools = searchFoodTools();

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: { mustCallTools: ["search_food"] },
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.toolUse.compliant).toBe(true);
    expect(signal.toolUse.called).toContain("search_food");
    expect(signal.toolUse.missing).toHaveLength(0);
  });

  it("detects tool non-compliance when expected tools are not called", async () => {
    const adapter = stubAdapter(() => ({
      content: "I think chicken has about 30g protein.",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: { mustCallTools: ["search_food"] },
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.toolUse.compliant).toBe(false);
    expect(signal.toolUse.called).toHaveLength(0);
    expect(signal.toolUse.missing).toContain("search_food");
  });

  it("detects typed output compliance when model returns structured output", async () => {
    const adapter = stubAdapter(() => ({
      content: "Here is your recommendation.",
      stop: true,
      output: {
        prose: "Chicken breast is a lean protein source.",
        foodRefs: [
          {
            foodId: "f1",
            foodName: "chicken breast",
            matchType: "exact" as const,
            allergens: [],
          },
        ],
        ruleRefs: [],
      },
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.typedOutput.returned).toBe(true);
    expect(signal.typedOutput.hasFoodRefs).toBe(true);
    expect(signal.typedOutput.hasRuleRefs).toBe(false);
  });

  it("detects typed output with rule refs", async () => {
    const adapter = stubAdapter(() => ({
      content: "Here is your recommendation with safety advisory.",
      stop: true,
      output: {
        prose: "Avoid grapefruit with your medication.",
        foodRefs: [],
        ruleRefs: [
          { ruleId: "r1", summary: "grapefruit-simvastatin interaction" },
        ],
      },
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "cross_domain", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.typedOutput.returned).toBe(true);
    expect(signal.typedOutput.hasFoodRefs).toBe(false);
    expect(signal.typedOutput.hasRuleRefs).toBe(true);
  });

  it("records typedOutput.returned=false when model does not provide structured output", async () => {
    const adapter = stubAdapter(() => ({
      content: "Just some prose advice.",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.typedOutput.returned).toBe(false);
    expect(signal.typedOutput.hasFoodRefs).toBe(false);
    expect(signal.typedOutput.hasRuleRefs).toBe(false);
  });

  it("records terminal outcome with stopReason and steps", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up food...",
          stop: false,
          toolCalls: [
            {
              name: "search_food",
              args: { food: "chicken" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "Chicken has 31g protein per 100g.", stop: true };
    });

    const tools = searchFoodTools();

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: {},
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.terminalOutcome.stopReason).toBe("end_turn");
    expect(signal.terminalOutcome.steps).toBe(2);
    expect(signal.terminalOutcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("builds a compliance report with summary metrics", async () => {
    const adapter = stubAdapter(() => ({
      content: "OK",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "q1", category: "simple", expected: {} },
      { id: "t2", query: "q2", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    expect(report.summary.total).toBe(2);
    expect(report.summary.toolComplianceRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.gateBlockRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.typedOutputRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.terminalSuccessRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.overallPassRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.terminalSuccessRate).toBe(1.0);
    expect(report.summary.overallPassRate).toBe(1.0);
  });

  it("renders text report without throwing", async () => {
    const adapter = stubAdapter(() => ({
      content: "OK",
      stop: true,
    }));

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const text = report.renderText();
    expect(text).toContain("Live Compliance");
    expect(text).toContain("Compliance Signals");
    expect(text).toContain("t1");
    expect(text).toContain("Summary");
    expect(typeof text).toBe("string");
  });

  it("handles adapter errors with crash stopReason and EVAL_ERROR_PREFIX", async () => {
    const adapter = stubAdapter(() => {
      throw new Error("network timeout");
    });

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];
    expect(signal.terminalOutcome.stopReason).toBe("crash");
    expect(signal.response).toContain("[ERROR]");
    expect(signal.response).toContain("network timeout");
    expect(signal.passed).toBe(false);
  });

  it("records gate block verdicts when post-gate blocks a response", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return { content: "Drink more milk for calcium!", stop: true };
      }
      return {
        content: "Try calcium-fortified orange juice instead.",
        stop: true,
      };
    });

    const tools = emptyTools();
    const store = fakeInteractionStore([]);

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How can I get more calcium?",
        category: "constrained",
        expected: { mustNotContain: ["milk"] },
        userContext: { allergies: ["milk"], medications: [] },
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools, store);
    const signal = report.signals[0];

    expect(signal.gateVerdicts.length).toBeGreaterThanOrEqual(3);
    expect(signal.response).toBe("Try calcium-fortified orange juice instead.");
    expect(signal.passed).toBe(true);
  });

  it("records output gate block verdict when gate is exhausted", async () => {
    const adapter = stubAdapter(() => {
      return { content: "Drink more milk for calcium!", stop: true };
    });

    const tools = emptyTools();
    const store = fakeInteractionStore([]);

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How can I get more calcium?",
        category: "constrained",
        expected: { mustNotContain: ["milk"], shouldBeBlocked: true },
        userContext: { allergies: ["milk"], medications: [] },
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools, store);
    const signal = report.signals[0];

    expect(signal.terminalOutcome.stopReason).toBe("gate_blocked");

    const blockVerdicts = signal.gateVerdicts.filter(
      (v) => v.verdict === "block",
    );
    expect(blockVerdicts.length).toBeGreaterThanOrEqual(1);

    expect(report.summary.gateBlockRate).toBeGreaterThan(0);
  });

  it("reports terminalSuccessRate correctly with mixed outcomes", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return { content: "OK", stop: true };
      }
      throw new Error("crash");
    });

    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "q1", category: "simple", expected: {} },
      { id: "t2", query: "q2", category: "simple", expected: {} },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);

    expect(report.summary.total).toBe(2);
    expect(report.summary.terminalSuccessRate).toBe(0.5);
    expect(report.summary.overallPassRate).toBe(0.5);
  });

  it("records tool gate verdicts from tool observations", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up chicken...",
          stop: false,
          toolCalls: [
            {
              name: "search_food",
              args: { food: "chicken" },
            } satisfies ToolCall,
          ],
        };
      }
      return { content: "Chicken has 31g protein per 100g.", stop: true };
    });

    const tools = searchFoodTools();

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: {},
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);
    const signal = report.signals[0];

    const toolVerdicts = signal.gateVerdicts.filter(
      (v) => v.checkpoint === "tool",
    );
    expect(toolVerdicts.length).toBeGreaterThanOrEqual(1);
    expect(toolVerdicts[0].verdict).toBe("pass");
    expect(toolVerdicts[0].checkName).toBe("tool_gate_check");
  });
});

// ─── ComplianceReport ────────────────────────────────────────────────────

describe("ComplianceReport", () => {
  it("summary rates are bounded between 0 and 1", async () => {
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const tools = emptyTools();

    const cases: EvalCase[] = [
      { id: "t1", query: "q1", category: "simple", expected: {} },
      {
        id: "t2",
        query: "q2",
        category: "simple",
        expected: { mustCallTools: ["search_food"] },
      },
    ];

    const report = await runLiveComplianceEval(cases, adapter, tools);

    expect(report.summary.toolComplianceRate).toBe(0.5);

    const { summary } = report;
    expect(summary.toolComplianceRate).toBeGreaterThanOrEqual(0);
    expect(summary.toolComplianceRate).toBeLessThanOrEqual(1);
    expect(summary.gateBlockRate).toBeGreaterThanOrEqual(0);
    expect(summary.gateBlockRate).toBeLessThanOrEqual(1);
    expect(summary.typedOutputRate).toBeGreaterThanOrEqual(0);
    expect(summary.typedOutputRate).toBeLessThanOrEqual(1);
    expect(summary.terminalSuccessRate).toBeGreaterThanOrEqual(0);
    expect(summary.terminalSuccessRate).toBeLessThanOrEqual(1);
    expect(summary.overallPassRate).toBeGreaterThanOrEqual(0);
    expect(summary.overallPassRate).toBeLessThanOrEqual(1);
  });

  it("handles empty case list gracefully", async () => {
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const tools = emptyTools();

    const report = await runLiveComplianceEval([], adapter, tools);
    expect(report.signals).toHaveLength(0);
    expect(report.summary.total).toBe(0);
    expect(report.summary.toolComplianceRate).toBe(0);
    expect(report.summary.overallPassRate).toBe(0);
    const text = report.renderText();
    expect(text).toContain("Live Compliance");
  });
});
