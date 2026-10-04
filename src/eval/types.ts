// Eval 系统类型（issue #6 代码评层 + issue #19 baseline 对比）。
//
// 三层评分中的第一层「代码评」：零 LLM 成本，每次 CI 可跑。
// 定义 eval case、bare/harness 运行结果、对比报告的类型。

import type { UserContext } from "../harness/gate";
import type { StopReason } from "../harness/types";

// ─── Eval Case ────────────────────────────────────────────────────────────

/** Eval case 的分类。 */
export type EvalCategory =
  | "simple"
  | "constrained"
  | "numeric"
  | "cross_domain"
  | "edge_case"
  | "descriptive"
  /**
   * 写入路径：用户要求记录一餐。
   *
   * 单独一类而不是塞进 descriptive，因为这里要考的是**动作**而不是措辞：
   * 模型说"已经帮你记下了"而没调 `log_meal`，用户的数据就是静默丢失了。
   * 这正是 harness 相对于裸模型存在的理由，而 2026-09-15 之前数据集里没有一条
   * case 对它有断言。
   */
  | "write"
  /**
   * 应有依据的问题：正确答案应当引得到语料原文（RFC 0013 §0）。
   *
   * 单独一类是因为它服务的是**分母**而不是风险面：引用支撑率必须只在"本来就需要
   * 出处"的问题上计算，否则会被基础查询稀释。这类 case 用 `expected.shouldCite`
   * 标记，且不进 pass/fail。
   */
  | "evidence";

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
  /**
   * 这条 case 的答案**应当**带可核验引用（RFC 0013 §0）。
   *
   * 它是一个**软**标记：没有它，求"引用支撑率"时分母只能拿全部 case 充数，而
   * "100g 鸡胸多少蛋白"这种问题本来就不需要语料出处，于是分母被稀释、指标失去意义。
   * 与 `mustNotContain` 这类硬契约不同，它不进 pass/fail —— ADR 0004 第 3 条把缺引用
   * 定为分级处理（先剥离、再重生成），不是整体拒答。
   */
  readonly shouldCite?: boolean;
  /**
   * 这条 case 问的食物**不在 catalog 里**（issue #130）。
   *
   * 正确行为因此不是"答对"，而是**如实说查不到**：调用目录工具、发现
   * `miss_unknown`、不编数字。没有这个字段时，这类 case 与"能查到"的 case 共用同一套
   * 期望，于是通过与否取决于模型这次是否恰好诚实 —— 一个偶然的绿色。
   */
  readonly expectsCatalogMiss?: boolean;
  /**
   * 问的是快照没有的营养素（镁、B12，或只被填成 0 的维 C / 纤维 / 钾）。
   * 食物行可以在目录里。如实说明“这一列没有”不是误拒。
   * 不复用 `expectsCatalogMiss`：那个检查会把回答里的宏量数字当成编造。
   */
  readonly expectsUnstoredNutrient?: boolean;
  /**
   * 不得调用的工具（如提问类 case 不得发起 `log_meal` 写入提案）。
   * 只在 harness 手臂检查：bare 手臂没有工具。
   */
  readonly mustNotCallTools?: readonly string[];
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
  /**
   * 切片标签，只用于分组报告，不参与判分。约定形如 `intent:prescriptive`、
   * `lang:zh`、`variant:paraphrase`、`kind:allergen`、`pinned:out`。
   */
  readonly tags?: readonly string[];
}

// ─── Baseline Comparison（issue #19）──────────────────────────────────────

/**
 * A provider fault rather than a result (issue #129).
 *
 * Present only when every retry failed for a transient reason. Such a case is
 * excluded from the pass-rate denominators and named in the report, because
 * counting it as a failure turns one bad minute at the provider into a false
 * regression.
 */
export interface InfrastructureFault {
  /** What the provider said, for the report. */
  readonly reason: string;
  readonly attempts: number;
}

/** Bare LLM 运行结果（单条 case）。 */
export interface BareResult {
  readonly caseId: string;
  readonly response: string;
  readonly passed: boolean;
  readonly violations: readonly string[];
  readonly durationMs: number;
  readonly infrastructure?: InfrastructureFault;
}

/**
 * What the citation gate did to one harness answer (RFC 0013 §0).
 *
 * Structural, from the gate's own result: the count of citations that survived
 * comes from the terminal output (the turn writes the stripped output back), and
 * the two flags come from the `gate_verdict` events the runner already collects.
 *
 * It exists because the criterion for V1.1 retrieval is "a prescriptive answer
 * carries a verifiable citation", and nothing in the report could previously
 * answer that: the metric named `sourceMarkerRate` counts words like "according
 * to", and the gate's `pass` verdict is also true of an answer that cites nothing
 * at all. Neither tells you a citation was there.
 */
export interface CitationSignal {
  /** Citations that survived the gate — what the answer actually cites. */
  readonly kept: number;
  /** The tier-1 provenance check stripped at least one citation. */
  readonly stripped: boolean;
  /**
   * The tier-2 backstop fired: the answer claimed authority without naming a
   * source, which is the one citation failure severe enough to regenerate.
   */
  readonly claimedAuthorityWithoutCitation: boolean;
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
  /** See {@link InfrastructureFault}. */
  readonly infrastructure?: InfrastructureFault;
  /** See {@link CitationSignal}. Absent when the case ran without a corpus. */
  readonly citations?: CitationSignal;
  /**
   * What retrieval contributed to this case, when the run had a corpus
   * (RFC 0013 §5).
   *
   * Absent means retrieval was not wired for this run — which is not the same
   * fact as "retrieval ran and found nothing", and the difference is the whole
   * point of the attribution: without it, a scripted arm with no corpus would be
   * reported as the product failing to cite.
   */
  readonly retrieval?: RetrievalSignal;
}

/** Shape of {@link HarnessResult.retrieval}. */
export interface RetrievalSignal {
  readonly hits: number;
  /** Why retrieval contributed nothing; absent when it contributed something. */
  readonly degraded?: "unavailable" | "no_hits";
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
  /** 文体信号，不是引用检查；见 `summary.ts` 的 CitationSupport。 */
  readonly sourceMarkerRate: {
    readonly bare: number;
    readonly harness: number;
  };
  readonly gateTurnRate: number;
}

/** 完整 eval 报告。 */
export interface EvalReport {
  readonly comparison: readonly ComparisonRow[];
  readonly summary: EvalSummary;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** 渲染为人类可读的文本报告。 */
  renderText(): string;
}
