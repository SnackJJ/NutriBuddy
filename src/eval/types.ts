// Eval 系统类型 (issue #19 / PRD v2 §4.2)。
//
// 三层评分中的第一层「代码评」：零 LLM 成本，每次 CI 可跑。
// 定义 eval case、bare/harness 运行结果、对比报告的类型。

import type { UserContext } from "../harness/gate";
import type { StopReason } from "../harness/types";

/** Eval case 的分类。 */
export type EvalCategory =
  | "simple"
  | "constrained"
  | "numeric"
  | "cross_domain"
  | "edge_case";

/** 预定义每条 query 的期望约束（PRD v2 §4.2）。 */
export interface EvalExpected {
  /** 回复中禁止出现的模式（如过敏原、冲突食物）。 */
  readonly mustNotContain?: readonly string[];
  /** 期望 harness 调用的工具名列表。 */
  readonly mustCallTools?: readonly string[];
  /** 期望的最大轮数。 */
  readonly maxTurns?: number;
}

/** 单条 eval case：手工 query + 期望约束 + 可选用户上下文。 */
export interface EvalCase {
  /** 唯一定位符，如 "s1"、"c3"。 */
  readonly id: string;
  /** 用户输入文本。 */
  readonly query: string;
  /** 分类。 */
  readonly category: EvalCategory;
  /** 期望约束。 */
  readonly expected: EvalExpected;
  /** 用户安全上下文（constrained / cross_domain case 提供）。 */
  readonly userContext?: UserContext;
}

/** Bare LLM 运行结果（单条 case）。 */
export interface BareResult {
  readonly caseId: string;
  readonly response: string;
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly durationMs: number;
}

/** Harness 运行结果（单条 case）。 */
export interface HarnessResult {
  readonly caseId: string;
  readonly response: string;
  readonly steps: number;
  readonly stopReason: StopReason;
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly toolCalls: readonly string[];
  readonly gateBlocks: number;
  readonly durationMs: number;
}

/** 单条 case 的对比行。 */
export interface ComparisonRow {
  readonly caseId: string;
  readonly query: string;
  readonly category: EvalCategory;
  readonly barePassed: boolean;
  readonly harnessPassed: boolean;
  /** Human-readable delta description. */
  readonly delta: string;
}

/** 汇总指标。 */
export interface EvalSummary {
  readonly total: number;
  readonly barePassRate: number;
  readonly harnessPassRate: number;
  readonly constraintViolationRate: {
    readonly bare: number;
    readonly harness: number;
  };
  readonly toolCallRate: number;
  readonly sourceComplianceRate: {
    readonly bare: number;
    readonly harness: number;
  };
  readonly gateTurnRate: number;
}

/** 完整 eval 报告。 */
export interface EvalReport {
  readonly comparison: readonly ComparisonRow[];
  readonly summary: EvalSummary;
  /** 渲染为人类可读的文本报告。 */
  renderText(): string;
}
