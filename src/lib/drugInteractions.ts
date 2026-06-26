// 药物-营养素相互作用查询（issue #9 / PRD v2 §3.1「硬约束规则」）。
//
// 这是 pre/post-gate 的硬约束数据源：代码层确定性查询，零 LLM 依赖。
// 规则表 `drug_nutrient_interactions` 由 supabase/migrations 建表 + 种子，
// 本模块只负责「按用户用药取出命中的规则」这一步——匹配逻辑留在被测的 TS
// 里，而非难以验证的 SQL 字符串里。表只有 20-30 行，全量取回再在内存里
// 按药名匹配，既稳（大小写/空白归一）又够快。
//
// 沿用 harness/Supabase 既有约定：数据源（InteractionStore）可注入，单测不触网。

/** 相互作用严重度。high = 硬拦 fail loud；moderate/low = 提示。 */
export type Severity = "high" | "moderate" | "low";

/** 一条药物-营养素相互作用规则（已映射为 camelCase）。 */
export interface DrugNutrientInteraction {
  /** 通用药名，小写存储（如 "warfarin"）。 */
  readonly drugName: string;
  /** 冲突的营养素 / 成分（如 "vitamin K"）。 */
  readonly nutrient: string;
  /** 富含该营养素的食物示例（如 ["kale", "spinach"]）。 */
  readonly foodExamples: readonly string[];
  readonly severity: Severity;
  /** 权威来源（NIH ODS / MedlinePlus）。 */
  readonly source: string;
}

/** 规则数据源：返回全部相互作用规则。可注入以便单测不触网。 */
export interface InteractionStore {
  all(): Promise<DrugNutrientInteraction[]>;
}

/** 归一药名，使 profile 里的大小写/空白差异不会漏匹配规则。 */
export function normalizeDrug(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 取出用户当前用药命中的所有相互作用规则（pre-gate 用）。
 * 大小写不敏感；一种药可命中多条（warfarin → vitamin K + cranberry）。
 * 无有效用药时直接返回空，不打扰数据源。
 */
export async function getInteractions(
  userMedications: string[],
  store: InteractionStore,
): Promise<DrugNutrientInteraction[]> {
  const meds = new Set(userMedications.map(normalizeDrug).filter(Boolean));
  if (meds.size === 0) return [];
  const rows = await store.all();
  return rows.filter((rule) => meds.has(normalizeDrug(rule.drugName)));
}

/** Supabase 行的原始形状（snake_case，与建表列一致）。 */
interface InteractionRow {
  readonly drug_name: string;
  readonly nutrient: string;
  readonly food_examples: string[] | null;
  readonly severity: string;
  readonly source: string;
}

/** supabaseInteractionStore 所需的最小客户端接口（结构化兼容 SupabaseClient）。 */
export interface InteractionQueryClient {
  from(table: string): {
    select(columns: string): PromiseLike<{
      data: InteractionRow[] | null;
      error: { message: string } | null;
    }>;
  };
}

const TABLE = "drug_nutrient_interactions";
const COLUMNS = "drug_name, nutrient, food_examples, severity, source";

/** 由 Supabase 客户端构造的规则数据源。失败时 fail loud，绝不静默返回空。 */
export function supabaseInteractionStore(
  client: InteractionQueryClient,
): InteractionStore {
  return {
    async all() {
      const { data, error } = await client.from(TABLE).select(COLUMNS);
      if (error) {
        throw new Error(
          `Failed to load ${TABLE}: ${error.message}. 药物相互作用是硬约束数据源，不能静默放行。`,
        );
      }
      return (data ?? []).map((row) => ({
        drugName: row.drug_name,
        nutrient: row.nutrient,
        foodExamples: row.food_examples ?? [],
        severity: row.severity as Severity,
        source: row.source,
      }));
    },
  };
}
