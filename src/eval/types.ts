// Eval 体系（PRD §4 代码评层 / issue #6）的窄类型。
// 代码评 = 纯 TypeScript 断言，零 LLM、零成本、每次 CI 跑（PRD §4.1）。
// 评分器消费 harness 的 TraceEvent[]（模型看到什么 → 调了什么工具 → 产出什么），
// 不依赖任何 LLM judge。

import type { TraceEvent } from "../harness/tracer";

/**
 * 用户 profile（MemoryStore profile 层，PRD §3 表）。
 * eval case 只取其中确定性约束相关的子集（过敏/用药/疾病/目标），故 case 里用 Partial。
 */
export interface UserProfile {
  readonly allergies: readonly string[];
  readonly medications: readonly string[];
  readonly conditions: readonly string[];
  readonly goals: readonly string[];
  /** 身体指标（weight_kg / height_cm 等），代码评当前不用但保留以贴合真实 profile。 */
  readonly metrics: Readonly<Record<string, number>>;
}

/**
 * 一条 eval 对 agent 行为的期望。所有字段可选——每条 case 只声明它要把守的失败模式。
 * 字段语义全部可由 TraceEvent[] + 纯断言判定（无需 LLM）：
 * - must_call_tools：trace 里必须出现对应 tool_call。
 * - must_not_contain：最终答复不得包含这些子串（大小写不敏感，把守约束违反/过敏原泄漏）。
 * - should_ask_clarification：最终答复应是一次澄清追问（含「?」）。
 * - should_be_blocked：trace 里必须出现 post_gate_blocked（跨域冲突硬拦）。
 */
export interface EvalExpectations {
  readonly must_call_tools?: readonly string[];
  readonly must_not_contain?: readonly string[];
  readonly should_ask_clarification?: boolean;
  readonly should_be_blocked?: boolean;
}

/** 五类失败模式（issue #6 验收项 / PRD §4.2）。 */
export type EvalCategory =
  | "simple_query"
  | "constrained_query"
  | "number_hallucination"
  | "cross_domain_conflict"
  | "ambiguous_food";

export interface EvalCase {
  /** 全集内唯一，作为报告里的稳定标识。 */
  readonly name: string;
  readonly category: EvalCategory;
  readonly userProfile: Partial<UserProfile>;
  readonly query: string;
  readonly expected: EvalExpectations;
}

/** 单条失败：哪类断言挂了 + 人读细节。 */
export interface ScoreFailure {
  readonly check: keyof EvalExpectations;
  readonly detail: string;
}

export interface ScoreResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly ScoreFailure[];
}

/**
 * 把一条 eval case 跑成一条 trace 的生产者。
 * 真实实现要等 ToolRegistry + Verifier 切片落地后接 runTurn；
 * 本切片只定义契约，runner 注入即可（测试注入假 producer、CLI 注入 pending producer）。
 */
export type TraceProducer = (
  evalCase: EvalCase,
) => Promise<readonly TraceEvent[]>;

export interface EvalReport {
  readonly results: readonly ScoreResult[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}
