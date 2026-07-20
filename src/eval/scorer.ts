// CodeScorer（issue #6 / PRD §4.1 代码评层）：纯 TypeScript 断言，零 LLM。
// Phase 3: primary input is ScoreSignals (from turn events). TraceEvent path is a demoted adapter.

import type { TraceEvent } from "../harness/tracer";
import type { AnyTurnEvent } from "../harness/turn";
import type { EvalCase, ScoreFailure, ScoreResult } from "./types";
import {
  checkMustCallTools,
  checkShouldAskClarification,
  checkShouldBeBlocked,
} from "./checks";
import {
  scoreSignalsFromTrace,
  scoreSignalsFromTurnEvents,
  type ScoreSignals,
} from "./scoreSignals";

export type { ScoreSignals } from "./scoreSignals";
export { scoreSignalsFromTurnEvents, scoreSignalsFromTrace } from "./scoreSignals";

/** Score from turn-event facts (structural Phase 3 primary path). */
export function scoreFromSignals(
  evalCase: EvalCase,
  signals: ScoreSignals,
): ScoreResult {
  const failures: ScoreFailure[] = [];
  const exp = evalCase.expected;
  const calledTools = signals.toolCalls;
  const reply = signals.reply;

  for (const tool of checkMustCallTools(
    exp.mustCallTools ?? [],
    calledTools,
  )) {
    failures.push({
      check: "mustCallTools",
      detail: `期望调用工具 "${tool}"；实际调用 [${calledTools.join(", ")}]`,
    });
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

  if (exp.shouldAskClarification && !checkShouldAskClarification(reply)) {
    failures.push({
      check: "shouldAskClarification",
      detail: `期望一次澄清追问（含「?」），实际：${reply ?? "<无答复>"}`,
    });
  }

  const wasBlocked = checkShouldBeBlocked(signals.wasBlocked);
  if (exp.shouldBeBlocked && !wasBlocked) {
    failures.push({
      check: "shouldBeBlocked",
      detail: "期望 post-gate 硬拦（gate_block / gate_verdict block），但未出现",
    });
  }

  return { caseId: evalCase.id, passed: failures.length === 0, failures };
}

/** Score a real turn event stream (+ optional terminal reply override). */
export function scoreCaseFromTurnEvents(
  evalCase: EvalCase,
  events: readonly AnyTurnEvent[],
  terminalReply?: string,
): ScoreResult {
  return scoreFromSignals(
    evalCase,
    scoreSignalsFromTurnEvents(events, terminalReply),
  );
}

/**
 * Demoted TraceEvent path (legacy producers / unit fixtures).
 * Prefer scoreCaseFromTurnEvents for harness truth.
 */
export function scoreCase(
  evalCase: EvalCase,
  trace: readonly TraceEvent[],
): ScoreResult {
  return scoreFromSignals(evalCase, scoreSignalsFromTrace(trace));
}
