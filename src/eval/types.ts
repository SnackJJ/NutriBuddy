// Eval 系统类型（issue #6 代码评层 + issue #19 baseline 对比）。
//
// 三层评分中的第一层「代码评」：零 LLM 成本，每次 CI 可跑。
// 定义 eval case、bare/harness 运行结果、对比报告的类型。

import type { TraceEvent } from "../harness/tracer";
import type { UserContext } from "../harness/gate";
import type { StopReason } from "../harness/types";

// ─── Eval Case ────────────────────────────────────────────────────────────

/** Eval case 的分类。 */
export type EvalCategory =
  | "simple"
  | "constrained"
  | "numeric"
  | "cross_domain"
  | "edge_case";

/** 预定义每条 query 的期望约束（纯 TS 断言判定，无需 LLM）。 */
export interface EvalExpected {
  /** 回复中禁止出现的模式（如过敏原、冲突食物）。 */
  readonly mustNotContain?: readonly string[];
  /** 期望 harness 调用的工具名列表。 */
  readonly mustCallTools?: readonly string[];
  /** 期望的最大轮数。 */
  readonly maxTurns?: number;
  /** 最终答复应为一次澄清追问（含「?」）。 */
  readonly shouldAskClarification?: boolean;
  /** trace 里必须出现 gate_block（跨域冲突硬拦）。 */
  readonly shouldBeBlocked?: boolean;
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

// ─── Code Scorer（issue #6）───────────────────────────────────────────────

/** 单条失败：哪类断言挂了 + 人读细节。 */
export interface ScoreFailure {
  readonly check: string;
  readonly detail: string;
}

export interface ScoreResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly failures: readonly ScoreFailure[];
}

/**
 * 把一条 eval case 跑成一条 trace 的生产者。
 * 真实实现接 runTurn；测试注入假 producer、CLI 注入 pending producer。
 */
export type TraceProducer = (
  evalCase: EvalCase,
) => Promise<readonly TraceEvent[]>;

// ─── Baseline Comparison（issue #19）──────────────────────────────────────

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
  readonly results: readonly ScoreResult[];
  readonly comparison: readonly ComparisonRow[];
  readonly summary: EvalSummary;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** 渲染为人类可读的文本报告。 */
  renderText(): string;
}
