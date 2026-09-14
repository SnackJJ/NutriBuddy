// Bare LLM baseline runner (issue #19 / PRD v2 §4.2)。
//
// 直接调 ModelAdapter 回答 eval query：无工具、无 gate、无重生成、无轨迹、无
// 校验。记录每条 case 的响应、通过/失败、违规项、耗时。
//
// **但用户上下文照给**（2026-09 起）。原先 bare 手臂连"用户对花生过敏、在吃华法林"
// 都不告诉模型，而打分却按"不得推荐花生"判——于是 constrained / cross_domain 两组
// 必然失败，测出来的不是"harness 的机械"而是"harness 恰好拿到了用户档案"。那让
// 消融归因站不住脚：一个面试官问"你把过敏原写进 prompt 会怎样"就能拆掉这个数字。
//
// 现在两个手臂的信息相同，差别只剩机械：工具、闸、重生成、轨迹。仍然不给的是
// 追问/澄清这类交互能力（那属于 harness 有而 bare 没有的部分，也是被测量项本身）。

import type { ModelAdapter } from "../harness/types";
import type { EvalCase, BareResult } from "./types";
import { scoreBare, EVAL_ERROR_PREFIX } from "./metrics";

/**
 * The user facts the harness injects into its pinned region, written the way a
 * plain prompt would carry them.
 *
 * Identical information, no machinery: this is what makes the two arms a
 * comparison of harness versus no harness rather than of informed versus
 * uninformed.
 */
export function bareUserContextMessage(c: EvalCase): string | null {
  const context = c.userContext;
  if (!context) return null;
  const parts: string[] = [];
  if (context.allergies.length > 0) parts.push(`allergies: ${context.allergies.join(", ")}`);
  if (context.medications.length > 0) {
    parts.push(`current medications: ${context.medications.join(", ")}`);
  }
  if (parts.length === 0) return null;
  return `User profile (use it in your answer) — ${parts.join("; ")}.`;
}

/**
 * 对一批 eval case 执行裸 LLM 运行。
 * 每个 case 只发一条 user 消息（+ 可选的一条用户档案 system 消息），无工具 / gate。
 */
export async function runBareEval(
  cases: readonly EvalCase[],
  adapter: ModelAdapter,
): Promise<BareResult[]> {
  const results: BareResult[] = [];

  for (const c of cases) {
    const start = Date.now();

    const profile = bareUserContextMessage(c);
    let response: string;
    try {
      const modelResp = await adapter.generate({
        model: "flash",
        thinking: true,
        messages: [
          ...(profile ? [{ role: "system" as const, content: profile }] : []),
          { role: "user", content: c.query },
        ],
      });
      response = modelResp.content;
    } catch (err) {
      response = `${EVAL_ERROR_PREFIX}${String(err)}`;
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
