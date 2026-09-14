import { describe, it, expect } from "vitest";
import { main, pendingProducer } from "../src/eval/run";
import { bareUserContextMessage, runBareEval } from "../src/eval/bare-runner";
import type { EvalCase, TraceProducer } from "../src/eval/types";
import type { ModelAdapter, ModelRequest } from "../src/harness/types";
import type { TraceEvent, TraceInput } from "../src/harness/tracer";

function trace(...events: TraceInput[]): TraceEvent[] {
  return events.map((e, i) => ({ ...e, seq: i }));
}

describe("eval run (npm run eval entrypoint)", () => {
  it("runs the full eval set and prints a per-category summary", async () => {
    const out: string[] = [];
    const code = await main([], {
      produceTrace: pendingProducer,
      stdout: (s) => out.push(s),
    });
    const text = out.join("");
    expect(text).toContain("simple");
    expect(text).toContain("cross_domain");
    // 全量 = 29 条（含 issue #49 descriptive 4 条）
    expect(text).toMatch(/29/);
    // pending 模式：非 strict，返回 0（框架本身绿）
    expect(code).toBe(0);
  });

  it("pendingProducer yields an empty trace (no live agent wired yet)", async () => {
    const t = await pendingProducer({
      id: "x",
      category: "simple",
      query: "q",
      expected: {},
    });
    expect(t).toEqual([]);
  });

  it("--strict exits non-zero when cases fail under the given producer", async () => {
    const out: string[] = [];
    const code = await main(["--strict"], {
      produceTrace: pendingProducer,
      stdout: (s) => out.push(s),
    });
    // pending producer → tool/block/clarification 类全挂 → strict 下非零
    expect(code).toBe(1);
  });

  it("--strict exits zero when every case passes under the producer", async () => {
    // 一个理想 producer：按每条 case 的期望伪造一条全通过的 trace。
    const idealProducer: TraceProducer = async (c) => {
      const events: TraceInput[] = [];
      for (const tool of c.expected.mustCallTools ?? []) {
        events.push({ step: 1, type: "tool_call", payload: tool });
      }
      if (c.expected.shouldBeBlocked) {
        events.push({ step: 1, type: "gate_block", payload: "blocked" });
      }
      events.push({
        step: 2,
        type: "model_return",
        payload: c.expected.shouldAskClarification
          ? "Which one did you mean?"
          : "ok",
      });
      return trace(...events);
    };
    const code = await main(["--strict"], {
      produceTrace: idealProducer,
      stdout: () => {},
    });
    expect(code).toBe(0);
  });
});

// ── the ablation's independent variable (bare-arm fairness) ────────────────
//
// The bare arm must know exactly what the harness knows about the user, or the
// comparison measures the profile plumbing instead of the machinery. These
// assertions pin the information, not the wording.

describe("runBareEval user context", () => {
  const constrained: EvalCase = {
    id: "c1",
    query: "What's a good high-protein snack for me?",
    category: "constrained",
    expected: { mustNotContain: ["peanut"] },
    userContext: { allergies: ["peanut"], medications: ["warfarin"] },
  };

  it("states the profile it is judged against, in the same turn", async () => {
    const seen: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      generate: async (request) => {
        seen.push(request);
        return { content: "how about some almonds?", stop: true };
      },
    };

    await runBareEval([constrained], adapter);

    const messages = seen[0].messages;
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("allergies: peanut");
    expect(messages[0].content).toContain("current medications: warfarin");
    expect(messages[1].content).toBe(constrained.query);
  });

  it("sends no system message when the case has no profile", async () => {
    const seen: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      generate: async (request) => {
        seen.push(request);
        return { content: "ok", stop: true };
      },
    };

    await runBareEval(
      [{ id: "s1", query: "protein in chicken?", category: "simple", expected: {} }],
      adapter,
    );

    expect(seen[0].messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("says nothing about tools, gates or retries — the machinery is the variable", () => {
    const message = bareUserContextMessage(constrained) ?? "";
    for (const forbidden of ["tool", "gate", "allergen", "avoid", "do not"]) {
      expect(message.toLowerCase()).not.toContain(forbidden);
    }
  });
});
