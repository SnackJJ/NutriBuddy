// Bare LLM baseline runner (issue #19 / PRD v2 §4.2)。
//
// 直接调 ModelAdapter 回答 eval query，无工具、无 gate、无 system prompt。
// 记录每条 case 的响应、通过/失败、违规项、耗时。

import type { ModelAdapter } from "../harness/types";
import type { EvalCase, BareResult } from "./types";
import { scoreBare } from "./metrics";

/**
 * 对一批 eval case 执行裸 LLM 运行。
 * 每个 case 只发一条 user 消息，无 system prompt / 工具 / gate。
 */
export async function runBareEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
): Promise<BareResult[]> {
  const results: BareResult[] = [];

  for (const c of cases) {
    const start = Date.now();

    let response: string;
    try {
      const modelResp = await adapter.generate({
        model: "flash",
        thinking: true,
        messages: [{ role: "user", content: c.query }],
      });
      response = modelResp.content;
    } catch (err) {
      response = `[ERROR] ${String(err)}`;
    }

    const durationMs = Date.now() - start;
    const { passed, violations } = scoreBare(
      response,
      c.expected,
      c.userContext,
    );

    results.push({
      caseId: c.id,
      response,
      passed,
      violations,
      durationMs,
    });
  }

  return results;
}
