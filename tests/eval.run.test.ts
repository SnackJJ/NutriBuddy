import { describe, it, expect } from "vitest";
import { main, pendingProducer } from "../src/eval/run";
import type { TraceProducer } from "../src/eval/types";
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
    expect(text).toContain("simple_query");
    expect(text).toContain("cross_domain_conflict");
    // 全量 = 25 条
    expect(text).toMatch(/25/);
    // pending 模式：非 strict，返回 0（框架本身绿）
    expect(code).toBe(0);
  });

  it("pendingProducer yields an empty trace (no live agent wired yet)", async () => {
    const t = await pendingProducer({
      name: "x",
      category: "simple_query",
      userProfile: {},
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
      for (const tool of c.expected.must_call_tools ?? []) {
        events.push({ step: 1, type: "tool_call", payload: tool });
      }
      if (c.expected.should_be_blocked) {
        events.push({ step: 1, type: "post_gate_blocked", payload: "blocked" });
      }
      events.push({
        step: 2,
        type: "model_return",
        payload: c.expected.should_ask_clarification
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
