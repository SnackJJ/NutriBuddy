import { describe, expect, it } from "vitest";
import {
  INFRA_ERROR_PUBLIC_CAUSE,
  INFRA_ERROR_RENDER,
  isJsonValue,
  isToolOutcomePayloadSerializable,
  renderToolOutcome,
  toolGateFromOutcome,
  type ToolGateReasonCode,
  type ToolOutcome,
} from "../src/harness/toolOutcome";

describe("toolGateFromOutcome (§2.2 mapping table)", () => {
  const cases: {
    readonly kind: ToolOutcome["kind"];
    readonly outcome: ToolOutcome;
    readonly verdict: "pass" | "error";
    readonly reasonCode: ToolGateReasonCode;
  }[] = [
    {
      kind: "ok",
      outcome: { kind: "ok", name: "query_catalog", data: { type: "observation" } },
      verdict: "pass",
      reasonCode: "tool_ok",
    },
    {
      kind: "typed_miss",
      outcome: {
        kind: "typed_miss",
        name: "log_meal",
        message: 'food not found in catalog: "xyz"',
        data: {
          error: 'food not found in catalog: "xyz"',
          match_type: "miss_unknown",
          catalog_snapshot: "snap-1",
          message: "not found",
        },
      },
      verdict: "pass",
      reasonCode: "typed_miss",
    },
    {
      kind: "typed_error",
      outcome: {
        kind: "typed_error",
        name: "query_catalog",
        message: "Unknown template",
        data: {
          type: "error",
          templateId: "nope",
          message: "Unknown template",
          availableTemplates: ["food_lookup"],
        },
      },
      verdict: "error",
      reasonCode: "typed_error",
    },
    {
      kind: "dispatch_error",
      outcome: {
        kind: "dispatch_error",
        name: "missing_tool",
        message: 'tool "missing_tool" not found — no handler registered',
      },
      verdict: "error",
      reasonCode: "dispatch_error",
    },
    {
      kind: "infra_error",
      outcome: {
        kind: "infra_error",
        name: "log_meal",
        cause: INFRA_ERROR_PUBLIC_CAUSE,
      },
      verdict: "error",
      reasonCode: "infra_error",
    },
  ];

  it.each(cases)("$kind → verdict=$verdict reasonCode=$reasonCode", ({
    outcome,
    verdict,
    reasonCode,
  }) => {
    const gate = toolGateFromOutcome(outcome);
    expect(gate.checkpoint).toBe("tool");
    expect(gate.checkName).toBe("tool_gate_check");
    expect(gate.verdict).toBe(verdict);
    expect(gate.reasonCode).toBe(reasonCode);
    expect(typeof gate.evidence).toBe("string");
    expect(gate.evidence.length).toBeGreaterThan(0);
  });
});

describe("renderToolOutcome (§2.1.1 snapshots)", () => {
  it("ok-object → JSON.stringify(data)", () => {
    const data = {
      proposal_id: "p1",
      message: "Log 100g chicken?",
      proposal: { id: "p1", food_id: "f1" },
    };
    expect(
      renderToolOutcome({ kind: "ok", name: "log_meal", data }),
    ).toBe(JSON.stringify(data));
  });

  it("ok-string → as-is", () => {
    expect(
      renderToolOutcome({
        kind: "ok",
        name: "search_food",
        data: "chicken breast (100g): 165 kcal",
      }),
    ).toBe("chicken breast (100g): 165 kcal");
  });

  it("typed_miss with candidates → full data JSON", () => {
    const data = {
      error: 'food not found in catalog: "amb"',
      match_type: "miss_ambiguous",
      catalog_snapshot: "snap-1",
      message: "matched multiple foods",
      candidates: [
        {
          food_id: "f1",
          food_name: "A",
          match_score: 0.9,
          allergen_tags: [] as string[],
        },
      ],
    };
    expect(
      renderToolOutcome({
        kind: "typed_miss",
        name: "log_meal",
        message: data.error,
        data,
        candidates: data.candidates,
      }),
    ).toBe(JSON.stringify(data));
  });

  it("typed_error with availableTemplates → full data JSON", () => {
    const data = {
      type: "error",
      templateId: "unknown_tpl",
      message: "Unknown template: unknown_tpl",
      availableTemplates: ["food_lookup", "meal_history"],
    };
    expect(
      renderToolOutcome({
        kind: "typed_error",
        name: "query_catalog",
        message: data.message,
        data,
      }),
    ).toBe(JSON.stringify(data));
  });

  it("dispatch_error → message", () => {
    const message = 'tool "x" not found — no handler registered';
    expect(
      renderToolOutcome({ kind: "dispatch_error", name: "x", message }),
    ).toBe(message);
  });

  it("infra_error → fixed user-safe string (no raw cause)", () => {
    const rendered = renderToolOutcome({
      kind: "infra_error",
      name: "log_meal",
      cause: INFRA_ERROR_PUBLIC_CAUSE,
    });
    expect(rendered).toBe(INFRA_ERROR_RENDER);
    expect(rendered).not.toContain("Error");
    expect(rendered).not.toContain("stack");
  });

  it("submit_answer ok with TypedOutput projection", () => {
    expect(
      renderToolOutcome({
        kind: "ok",
        name: "submit_answer",
        data: {
          prose: "Eat chicken.",
          foodRefs: [{ foodId: "f1", foodName: "chicken", matchType: "exact" }],
          ruleRefs: [],
        },
      }),
    ).toBe("Answer submitted with 1 food ref(s) and 0 rule ref(s)");
  });

  it("submit_answer ok with data null", () => {
    expect(
      renderToolOutcome({ kind: "ok", name: "submit_answer", data: null }),
    ).toBe("Answer submitted (prose-only fallback)");
  });
});

describe("isJsonValue / serializability", () => {
  it("accepts plain JSON trees and shared DAG refs", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue({ a: 1, b: [true, "x"] })).toBe(true);
    const shared = { x: 1 };
    expect(isJsonValue({ a: shared, b: shared })).toBe(true);
  });

  it("rejects non-finite numbers, path cycles, and non-plain objects", () => {
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
    // undefined fields are omitted (JSON.stringify semantics)
    expect(isJsonValue({ a: undefined, b: 1 })).toBe(true);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(new Set())).toBe(false);
  });

  it("isToolOutcomePayloadSerializable checks data and observation", () => {
    expect(isToolOutcomePayloadSerializable({ ok: true })).toBe(true);
    expect(isToolOutcomePayloadSerializable({ a: 1 })).toBe(true);
    expect(
      isToolOutcomePayloadSerializable(
        { type: "observation" },
        {
          templateId: "food_lookup",
          columns: [{ name: "kcal", unit: "kcal" }],
          rows: [{ kcal: 100 }],
          rowCount: 1,
          truncated: false,
        },
      ),
    ).toBe(true);
    expect(
      isToolOutcomePayloadSerializable({ ok: true }, new Date()),
    ).toBe(false);
  });
});

describe("infra_error fail-closed integration (RFC §2.5)", () => {
  it("act → observe(infra) → tool gate error → crash; no remaining tools; no proposal override", async () => {
    const { turn, consumeTurn } = await import("../src/harness/turn");
    const { Tracer } = await import("../src/harness/tracer");
    const { INFRA_ERROR_PUBLIC_CAUSE, INFRA_ERROR_RENDER } = await import(
      "../src/harness/toolOutcome"
    );

    let calls = 0;
    const adapter = {
      generate: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: "",
            stop: false as const,
            toolCalls: [
              {
                id: "c1",
                name: "boom_tool",
                args: {},
              },
              {
                id: "c2",
                name: "should_not_run",
                args: {},
              },
            ],
          };
        }
        return { content: "should not get another model step", stop: true as const };
      },
    };

    let secondToolRan = false;
    const tools = new Map([
      [
        "boom_tool",
        async () => {
          throw new Error("secret DB password=hunter2");
        },
      ],
      [
        "should_not_run",
        async () => {
          secondToolRan = true;
          return "ok";
        },
      ],
    ]);

    const events: unknown[] = [];
    const result = await consumeTurn(
      turn(
        { tag: "utterance", content: "crash please" },
        {
          adapter,
          tracer: new Tracer(),
          tools,
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
        },
      ),
      (e) => events.push(e),
    );

    expect(secondToolRan).toBe(false);
    expect(result.stopReason).toBe("crash");
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.reply).not.toContain("hunter2");
    expect(result.reply).not.toContain("password");

    const steps = events.filter(
      (e): e is { type: string; agentEvent?: { type: string; toolOutcome?: { kind: string; cause?: string }; toolResult?: { result: string } } } =>
        typeof e === "object" && e !== null && (e as { type: string }).type === "step",
    );
    const observe = steps.find((s) => s.agentEvent?.type === "observe");
    expect(observe?.agentEvent?.toolOutcome?.kind).toBe("infra_error");
    expect(observe?.agentEvent?.toolOutcome?.cause).toBe(INFRA_ERROR_PUBLIC_CAUSE);
    expect(observe?.agentEvent?.toolResult?.result).toBe(INFRA_ERROR_RENDER);

    const gates = events.filter(
      (e): e is { type: string; checkpoint: string; verdict: string; reasonCode?: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type: string }).type === "gate_verdict",
    );
    const toolGate = gates.find((g) => g.checkpoint === "tool");
    expect(toolGate?.verdict).toBe("error");
    expect(toolGate?.reasonCode).toBe("infra_error");
    // No output/commit after crash
    expect(gates.some((g) => g.checkpoint === "output")).toBe(false);
    expect(gates.some((g) => g.checkpoint === "commit")).toBe(false);

    const ends = events.filter(
      (e): e is { type: string } =>
        typeof e === "object" && e !== null && (e as { type: string }).type === "turn_end",
    );
    expect(ends).toHaveLength(1);
    // Only one model call (no later ReAct step)
    expect(calls).toBe(1);
  });
});
