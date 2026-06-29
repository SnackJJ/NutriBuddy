import { describe, it, expect } from "vitest";
import { loadEvalCases, type EvalCase } from "../src/eval/dataset";
import { scoreBare, scoreHarness, computeMetrics } from "../src/eval/metrics";
import { runBareEval } from "../src/eval/bare-runner";
import { runHarnessEval } from "../src/eval/harness-runner";
import { generateReport } from "../src/eval/reporter";
import type { BareResult, HarnessResult } from "../src/eval/types";
import { Tracer } from "../src/harness/tracer";
import { run } from "../src/harness/loop";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  AgentEvent,
  TerminalResult,
  ToolCall,
} from "../src/harness/types";
import type { UserContext } from "../src/harness/gate";
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

async function collect(
  gen: AsyncGenerator<AgentEvent, TerminalResult, undefined>,
): Promise<{ events: AgentEvent[]; result: TerminalResult }> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

function fakeInteractionStore(
  rows: DrugNutrientInteraction[],
): InteractionStore {
  return { all: async () => rows };
}

// ─── Dataset tests ───────────────────────────────────────────────────────

describe("EvalDataset", () => {
  it("loads at least 20 eval cases", () => {
    const cases = loadEvalCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("every case has a unique id", () => {
    const cases = loadEvalCases();
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every case has a non-empty query", () => {
    const cases = loadEvalCases();
    for (const c of cases) {
      expect(c.query.length).toBeGreaterThan(0);
    }
  });

  it("every case has a valid category", () => {
    const validCategories = [
      "simple",
      "constrained",
      "numeric",
      "cross_domain",
      "edge_case",
    ] as const;
    const cases = loadEvalCases();
    for (const c of cases) {
      expect(validCategories).toContain(c.category);
    }
  });

  it("constrained and cross_domain cases provide user context", () => {
    const cases = loadEvalCases();
    const gatedCategories = ["constrained", "cross_domain"];
    for (const c of cases) {
      if (gatedCategories.includes(c.category)) {
        expect(c.userContext).toBeDefined();
      }
    }
  });

  it("all expected.mustNotContain values are non-empty strings", () => {
    const cases = loadEvalCases();
    for (const c of cases) {
      if (c.expected.mustNotContain) {
        for (const s of c.expected.mustNotContain) {
          expect(s.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("covers all five categories", () => {
    const cases = loadEvalCases();
    const categories = new Set(cases.map((c) => c.category));
    expect(categories.has("simple")).toBe(true);
    expect(categories.has("constrained")).toBe(true);
    expect(categories.has("numeric")).toBe(true);
    expect(categories.has("cross_domain")).toBe(true);
    expect(categories.has("edge_case")).toBe(true);
  });
});

// ─── Metrics tests ───────────────────────────────────────────────────────

describe("scoreBare", () => {
  it("returns passed=true with no violations when nothing is wrong", () => {
    const result = scoreBare(
      "Eggs are a great source of protein.",
      { mustNotContain: ["peanut"] },
      undefined,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects mustNotContain violations", () => {
    const result = scoreBare(
      "I recommend peanut butter for protein.",
      { mustNotContain: ["peanut"] },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Response contains forbidden term: "peanut"',
    );
  });

  it("detects multiple mustNotContain violations", () => {
    const result = scoreBare(
      "I recommend milk and peanut butter.",
      { mustNotContain: ["milk", "peanut"] },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("returns passed=true when mustNotContain is empty", () => {
    const result = scoreBare("Any response is fine.", {}, undefined);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects allergen mentions via gate-style check when userContext provided", () => {
    const result = scoreBare(
      "Drink more milk for calcium.",
      {},
      { allergies: ["milk"], medications: [] },
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.toLowerCase().includes("milk"))).toBe(
      true,
    );
  });

  it("fails when response starts with [ERROR] prefix (adapter failure)", () => {
    const result = scoreBare(
      "[ERROR] RateLimitExceeded: Too many requests",
      {}, // empty expected — would previously pass silently
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      "Adapter error: RateLimitExceeded: Too many requests",
    );
  });

  it("fails [ERROR] prefix even with non-empty expected constraints", () => {
    const result = scoreBare(
      "[ERROR] NetworkError: connection refused",
      { mustNotContain: ["peanut"] },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.startsWith("Adapter error:"))).toBe(
      true,
    );
  });
});

describe("scoreHarness", () => {
  it("returns passed=true when no constraints violated", () => {
    const result = scoreHarness(
      "Eggs are a safe choice.",
      [],
      { mustNotContain: ["peanut"] },
      undefined,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects mustNotContain violations", () => {
    const result = scoreHarness(
      "Try peanut butter.",
      [],
      { mustNotContain: ["peanut"] },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Response contains forbidden term: "peanut"',
    );
  });

  it("reports tool calls from trace", () => {
    const result = scoreHarness(
      "OK",
      ["search_food", "log_meal"],
      {},
      undefined,
    );
    expect(result.toolCalls).toEqual(["search_food", "log_meal"]);
  });

  it("reports gate blocks from trace", () => {
    const result = scoreHarness(
      "OK",
      [],
      {},
      undefined,
      2, // gateBlocks
    );
    expect(result.gateBlocks).toBe(2);
  });

  it("detects allergen mentions via gate-style check", () => {
    const result = scoreHarness(
      "I recommend dairy products.",
      [],
      {},
      { allergies: ["milk"], medications: [] },
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.toLowerCase().includes("dairy"))).toBe(
      true,
    );
  });

  // ── mustCallTools ────────────────────────────────────────────────────

  it("fails when an expected tool was not called", () => {
    const result = scoreHarness(
      "Here is the nutrition info.",
      [], // no tools called
      { mustCallTools: ["search_food"] },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Expected tool "search_food" was not called',
    );
  });

  it("passes when all expected tools were called", () => {
    const result = scoreHarness(
      "Here is the nutrition info.",
      ["search_food", "log_meal"],
      { mustCallTools: ["search_food"] },
      undefined,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // ── shouldAskClarification ───────────────────────────────────────────

  it("passes when asked to clarify and reply contains a question mark", () => {
    const result = scoreHarness(
      "What kind of sandwich was it?",
      [],
      { shouldAskClarification: true },
      undefined,
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when clarification is expected but reply does not ask a question", () => {
    const result = scoreHarness(
      "A sandwich has about 300 calories.",
      [],
      { shouldAskClarification: true },
      undefined,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Expected clarification question but reply did not contain "?"',
    );
  });

  // ── shouldBeBlocked ──────────────────────────────────────────────────

  it("passes when a block was expected and gate did block", () => {
    const result = scoreHarness(
      "Blocked by gate.",
      [],
      { shouldBeBlocked: true },
      undefined,
      1, // gateBlocks > 0
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when a block was expected but gate did not block", () => {
    const result = scoreHarness(
      "Sure, eat lots of spinach!",
      [],
      { shouldBeBlocked: true },
      undefined,
      0, // gateBlocks === 0
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      "Expected gate to block but it did not",
    );
  });

  // ── Multiple violations ──────────────────────────────────────────────

  it("accumulates violations across mustNotContain, mustCallTools, and shouldBeBlocked", () => {
    const result = scoreHarness(
      "Try peanut butter.",
      [], // search_food not called
      {
        mustNotContain: ["peanut"],
        mustCallTools: ["search_food"],
        shouldBeBlocked: true,
      },
      undefined,
      0, // gate did not block
    );
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.violations).toContain(
      'Response contains forbidden term: "peanut"',
    );
    expect(result.violations).toContain(
      'Expected tool "search_food" was not called',
    );
    expect(result.violations).toContain(
      "Expected gate to block but it did not",
    );
  });
});

describe("computeMetrics", () => {
  const bareResults: BareResult[] = [
    {
      caseId: "s1",
      response: "ok",
      passed: true,
      violations: [],
      durationMs: 100,
    },
    {
      caseId: "s2",
      response: "bad: milk",
      passed: false,
      violations: ["milk"],
      durationMs: 200,
    },
    {
      caseId: "s3",
      response: "bad: peanut",
      passed: false,
      violations: ["peanut"],
      durationMs: 150,
    },
  ];

  const harnessResults: HarnessResult[] = [
    {
      caseId: "s1",
      response: "ok",
      passed: true,
      violations: [],
      toolCalls: ["search_food"],
      gateBlocks: 0,
      steps: 1,
      stopReason: "end_turn",
      durationMs: 300,
    },
    {
      caseId: "s2",
      response: "bad: milk",
      passed: false,
      violations: ["milk"],
      toolCalls: [],
      gateBlocks: 1,
      steps: 2,
      stopReason: "gate_blocked",
      durationMs: 500,
    },
    {
      caseId: "s3",
      response: "safe after retry",
      passed: true,
      violations: [],
      toolCalls: ["search_food"],
      gateBlocks: 1,
      steps: 3,
      stopReason: "end_turn",
      durationMs: 600,
    },
  ];

  it("computes pass rates", () => {
    const metrics = computeMetrics(bareResults, harnessResults);
    expect(metrics.total).toBe(3);
    expect(metrics.barePassRate).toBeCloseTo(1 / 3);
    expect(metrics.harnessPassRate).toBeCloseTo(2 / 3);
  });

  it("computes tool call rate", () => {
    const metrics = computeMetrics(bareResults, harnessResults);
    // 2 out of 3 harness results have tool calls
    expect(metrics.toolCallRate).toBeCloseTo(2 / 3);
  });

  it("computes gate turn rate", () => {
    const metrics = computeMetrics(bareResults, harnessResults);
    // 2 out of 3 harness results have gate blocks
    expect(metrics.gateTurnRate).toBeCloseTo(2 / 3);
  });

  it("computes constraint violation rate", () => {
    const metrics = computeMetrics(bareResults, harnessResults);
    // bare: 2/3 violated, harness: 1/3 violated
    expect(metrics.constraintViolationRate.bare).toBeCloseTo(2 / 3);
    expect(metrics.constraintViolationRate.harness).toBeCloseTo(1 / 3);
  });
});

// ─── Bare runner tests ───────────────────────────────────────────────────

describe("runBareEval", () => {
  it("calls adapter.generate() once per case with only user message", async () => {
    const generateCalls: ModelRequest[] = [];
    const adapter = stubAdapter((req) => {
      generateCalls.push(req);
      return { content: "test response", stop: true };
    });

    const cases: EvalCase[] = [
      { id: "t1", query: "How much protein in an egg?", category: "simple", expected: {} },
    ];

    const results = await runBareEval(cases, adapter);
    expect(results).toHaveLength(1);
    expect(generateCalls).toHaveLength(1);

    // Must be a single user message, no system prompt
    const messages = generateCalls[0].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("How much protein in an egg?");
  });

  it("returns a BareResult per case with response, passed flag, and violations", async () => {
    const adapter = stubAdapter(() => ({
      content: "I recommend milk.",
      stop: true,
    }));

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "drink?",
        category: "constrained",
        expected: { mustNotContain: ["milk"] },
        userContext: { allergies: ["milk"], medications: [] },
      },
    ];

    const results = await runBareEval(cases, adapter);
    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("t1");
    expect(results[0].response).toBe("I recommend milk.");
    expect(results[0].passed).toBe(false);
    expect(results[0].violations.length).toBeGreaterThan(0);
  });

  it("marks passed when bare response is clean", async () => {
    const adapter = stubAdapter(() => ({
      content: "Water is a safe choice.",
      stop: true,
    }));

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "drink?",
        category: "constrained",
        expected: { mustNotContain: ["milk"] },
        userContext: { allergies: ["milk"], medications: [] },
      },
    ];

    const results = await runBareEval(cases, adapter);
    expect(results[0].passed).toBe(true);
  });

  it("marks failed when adapter throws on a case with empty expected (issue #22)", async () => {
    const adapter = stubAdapter(() => {
      throw new Error("RateLimitExceeded");
    });

    const cases: EvalCase[] = [
      { id: "n1", query: "test", category: "numeric", expected: {} },
    ];

    const results = await runBareEval(cases, adapter);
    expect(results[0].caseId).toBe("n1");
    expect(results[0].response).toContain("[ERROR]");
    expect(results[0].passed).toBe(false);
    expect(results[0].violations.length).toBeGreaterThan(0);
  });
});

// ─── Harness runner tests ────────────────────────────────────────────────

describe("runHarnessEval", () => {
  it("runs cases through the full harness loop (with tools, gate)", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up...",
          stop: false,
          toolCalls: [{ name: "search_food", args: { food: "chicken" } } satisfies ToolCall],
        };
      }
      return { content: "Chicken has 31g protein per 100g.", stop: true };
    });

    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "How much protein in chicken?",
        category: "simple",
        expected: { mustCallTools: ["search_food"] },
      },
    ];

    const results = await runHarnessEval(cases, adapter, tools);
    expect(results).toHaveLength(1);
    expect(results[0].caseId).toBe("t1");
    expect(results[0].response).toBe("Chicken has 31g protein per 100g.");
    expect(results[0].steps).toBe(2);
    expect(results[0].stopReason).toBe("end_turn");
    // Tool was called
    expect(results[0].toolCalls).toContain("search_food");
  });

  it("passes userContext and interactionStore for gate-enabled cases", async () => {
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return { content: "Drink milk for calcium!", stop: true };
      }
      // "oat milk" still contains "milk" → would trigger allergen check again
      return { content: "Try calcium-fortified orange juice instead.", stop: true };
    });

    const tools = new Map<string, (args: Readonly<Record<string, unknown>>) => Promise<string>>();

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

    const results = await runHarnessEval(cases, adapter, tools, store);
    expect(results).toHaveLength(1);
    // Gate should have blocked the first response and retried
    // The second call should produce the safe answer
    expect(results[0].response).toBe("Try calcium-fortified orange juice instead.");
    expect(results[0].gateBlocks).toBeGreaterThanOrEqual(1);
  });

  it("records duration per case", async () => {
    const adapter = stubAdapter(() => ({ content: "OK", stop: true }));
    const tools = new Map<string, (args: Readonly<Record<string, unknown>>) => Promise<string>>();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const results = await runHarnessEval(cases, adapter, tools);
    // Stub adapters can resolve instantly (0ms), especially in CI
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records adapter error with EVAL_ERROR_PREFIX when adapter throws", async () => {
    const adapter = stubAdapter(() => {
      throw new Error("network timeout");
    });

    const tools = new Map<string, (args: Readonly<Record<string, unknown>>) => Promise<string>>();

    const cases: EvalCase[] = [
      { id: "t1", query: "test", category: "simple", expected: {} },
    ];

    const results = await runHarnessEval(cases, adapter, tools);
    expect(results).toHaveLength(1);
    // Crash must be distinguishable from normal zero-step completion (issue #21)
    expect(results[0].stopReason).toBe("crash");
    expect(results[0].response).toContain("[ERROR]");
    expect(results[0].response).toContain("network timeout");
  });

  it("preserves tool calls collected before adapter throws mid-loop", async () => {
    // Adapter that succeeds once (with a tool call so step 1 completes)
    // and then throws on the next call.
    let callCount = 0;
    const adapter = stubAdapter(() => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Looking up...",
          stop: false,
          toolCalls: [{ name: "search_food", args: { food: "chicken" } } satisfies ToolCall],
        };
      }
      throw new Error("model offline at step 2");
    });

    const tools = new Map([
      ["search_food", async () => "chicken: 31g protein/100g"],
    ]);

    const cases: EvalCase[] = [
      {
        id: "t1",
        query: "test",
        category: "simple",
        expected: {},
      },
    ];

    const results = await runHarnessEval(cases, adapter, tools);
    expect(results).toHaveLength(1);
    // Crash must be distinguishable from normal completion (issue #21)
    expect(results[0].stopReason).toBe("crash");
    // Last step reached before the crash should be preserved
    expect(results[0].steps).toBe(2);
    // Tool calls made before the crash are preserved
    expect(results[0].toolCalls).toContain("search_food");
    // Error is recorded with EVAL_ERROR_PREFIX for scoring
    expect(results[0].response).toContain("[ERROR]");
    expect(results[0].response).toContain("model offline at step 2");
  });
});

// ─── Reporter tests ──────────────────────────────────────────────────────

describe("generateReport", () => {
  const bareResults: BareResult[] = [
    {
      caseId: "s1",
      response: "Eggs have 6g protein.",
      passed: true,
      violations: [],
      durationMs: 100,
    },
    {
      caseId: "c1",
      response: "I recommend milk for calcium.",
      passed: false,
      violations: ['Response contains forbidden term: "milk"'],
      durationMs: 150,
    },
  ];

  const harnessResults: HarnessResult[] = [
    {
      caseId: "s1",
      response: "Eggs have 6g protein.",
      passed: true,
      violations: [],
      toolCalls: ["search_food"],
      gateBlocks: 0,
      steps: 2,
      stopReason: "end_turn",
      durationMs: 300,
    },
    {
      caseId: "c1",
      response: "Try fortified oat milk instead.",
      passed: true,
      violations: [],
      toolCalls: ["search_food"],
      gateBlocks: 1,
      steps: 3,
      stopReason: "end_turn",
      durationMs: 500,
    },
  ];

  const cases: EvalCase[] = [
    {
      id: "s1",
      query: "How much protein in an egg?",
      category: "simple",
      expected: { mustCallTools: ["search_food"] },
    },
    {
      id: "c1",
      query: "How can I get more calcium?",
      category: "constrained",
      expected: { mustNotContain: ["milk"] },
      userContext: { allergies: ["milk"], medications: [] },
    },
  ];

  it("generates a comparison table with all cases", () => {
    const report = generateReport(cases, bareResults, harnessResults);
    expect(report.comparison).toHaveLength(2);
    expect(report.comparison[0].caseId).toBe("s1");
    expect(report.comparison[1].caseId).toBe("c1");
  });

  it("computes correct delta for each case", () => {
    const report = generateReport(cases, bareResults, harnessResults);

    // s1: both passed → delta "same"
    expect(report.comparison[0].barePassed).toBe(true);
    expect(report.comparison[0].harnessPassed).toBe(true);
    expect(report.comparison[0].delta).toContain("same");

    // c1: bare failed, harness passed → delta "+harness"
    expect(report.comparison[1].barePassed).toBe(false);
    expect(report.comparison[1].harnessPassed).toBe(true);
    expect(report.comparison[1].delta).toContain("+harness");
  });

  it("generates summary with key metrics", () => {
    const report = generateReport(cases, bareResults, harnessResults);
    expect(report.summary.total).toBe(2);
    expect(report.summary.barePassRate).toBeCloseTo(0.5);
    expect(report.summary.harnessPassRate).toBeCloseTo(1.0);
  });

  it("renders text report without throwing", () => {
    const report = generateReport(cases, bareResults, harnessResults);
    const text = report.renderText();
    expect(text).toContain("NutriBuddy Eval Report");
    expect(text).toContain("Comparison");
    expect(text).toContain("Summary");
    expect(text).toContain("s1");
    expect(text).toContain("c1");
  });
});
