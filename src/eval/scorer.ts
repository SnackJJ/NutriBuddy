// CodeScorer（issue #6 / PRD §4.1 代码评层）：纯 TypeScript 断言，零 LLM。
// 输入 EvalCase + TraceEvent[] → 输出 { passed, failures[] }。
// 每个断言只读 trace（不重跑模型），保证零成本、可在每次 CI 跑全量。

import type { TraceEvent } from "../harness/tracer";
import type { EvalCase, ScoreFailure, ScoreResult } from "./types";

/** tool_call 的 payload 约定为工具名，或 JSON {name,args}；两种都解析出工具名。 */
function extractToolName(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      const name = (parsed as { name: unknown }).name;
      if (typeof name === "string") return name.trim();
    }
  } catch {
    // 非 JSON：payload 即裸工具名。
  }
  return payload.trim();
}

/** 最终答复 = 最后一条 model_return 的 payload（无则 undefined）。 */
function finalReply(trace: readonly TraceEvent[]): string | undefined {
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i].type === "model_return") return trace[i].payload;
  }
  return undefined;
}

export function scoreCase(
  evalCase: EvalCase,
  trace: readonly TraceEvent[],
): ScoreResult {
  const failures: ScoreFailure[] = [];
  const exp = evalCase.expected;

  const calledTools = trace
    .filter((e) => e.type === "tool_call")
    .map((e) => extractToolName(e.payload));
  const reply = finalReply(trace);

  for (const tool of exp.mustCallTools ?? []) {
    if (!calledTools.includes(tool)) {
      failures.push({
        check: "mustCallTools",
        detail: `期望调用工具 "${tool}"；实际调用 [${calledTools.join(", ")}]`,
      });
    }
  }

  for (const phrase of exp.mustNotContain ?? []) {
    if (
      reply !== undefined &&
      reply.toLowerCase().includes(phrase.toLowerCase())
    ) {
      failures.push({
        check: "mustNotContain",
        detail: `最终答复含禁止子串 "${phrase}"`,
      });
    }
  }

  if (exp.shouldAskClarification) {
    if (reply === undefined || !reply.includes("?")) {
      failures.push({
        check: "shouldAskClarification",
        detail: `期望一次澄清追问（含「?」），实际：${reply ?? "<无答复>"}`,
      });
    }
  }

  if (exp.shouldBeBlocked) {
    const blocked = trace.some((e) => e.type === "post_gate_blocked");
    if (!blocked) {
      failures.push({
        check: "shouldBeBlocked",
        detail:
          "期望 post-gate 硬拦（post_gate_blocked 事件），但 trace 内未出现",
      });
    }
  }

  return { caseId: evalCase.id, passed: failures.length === 0, failures };
}
