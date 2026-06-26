// SQL Template Catalog（issue #11 / PRD v2 §3.2「CodeAct 批量数据查询」）。
//
// 高频查询提供预验证 SQL 模板，注入 system prompt 的 pinned region。
// 模型不逐小步调用单个工具，而是选模板填参数，harness 一次性执行返回结果。
//
// 白名单模式：M1 只允许执行此目录中的预定义模板，禁止任意 SQL。
// 所有模板均为 SELECT only，executor 自动追加 LIMIT 100。

/** 模板参数类型。 */
export type ParamType = "string" | "number" | "uuid";

/** 一条预验证 SQL 模板。 */
export interface SqlTemplate {
  /** 模板唯一标识（模型引用此 ID）。 */
  readonly id: string;
  /** 模板功能描述（注入 system prompt 供模型理解）。 */
  readonly description: string;
  /** 参数化 SQL（$1, $2, ...）。 */
  readonly sql: string;
  /** 形参名称（顺序对应 $1, $2, ...）。 */
  readonly paramNames: readonly string[];
  /** 形参类型（顺序对应 paramNames）。 */
  readonly paramTypes: readonly ParamType[];
}

/** SQL 模板目录（白名单）。 */
export const SQL_TEMPLATES: readonly SqlTemplate[] = [
  {
    id: "profile_query",
    description:
      "Get the current user profile: allergies, medications, goal type, " +
      "nutrition targets (protein/kcal/fat/carbs), and body metrics (height/weight).",
    sql:
      "SELECT user_id, allergies, medications, goal_type, " +
      "protein_target_g, kcal_target, fat_target_g, carbs_target_g, " +
      "height_cm, weight_kg " +
      "FROM user_profile " +
      "WHERE user_id = $1 AND valid_to IS NULL " +
      "LIMIT 1",
    paramNames: ["user_id"],
    paramTypes: ["uuid"],
  },
  {
    id: "profile_allergies",
    description:
      "Get the current user's food allergies and intolerances.",
    sql:
      "SELECT allergies " +
      "FROM user_profile " +
      "WHERE user_id = $1 AND valid_to IS NULL " +
      "LIMIT 1",
    paramNames: ["user_id"],
    paramTypes: ["uuid"],
  },
  {
    id: "profile_nutrition_targets",
    description:
      "Get the user's nutrition targets (goal type, protein, kcal, fat, carbs) " +
      "and body metrics (height, weight).",
    sql:
      "SELECT goal_type, protein_target_g, kcal_target, fat_target_g, " +
      "carbs_target_g, height_cm, weight_kg " +
      "FROM user_profile " +
      "WHERE user_id = $1 AND valid_to IS NULL " +
      "LIMIT 1",
    paramNames: ["user_id"],
    paramTypes: ["uuid"],
  },
  {
    id: "drug_interactions_for_medication",
    description:
      "Get all known drug-nutrient interactions for a specific medication " +
      "(case-insensitive match). Returns nutrient conflicts, foods to avoid, " +
      "severity, and authoritative source.",
    sql:
      "SELECT drug_name, nutrient, food_examples, severity, source " +
      "FROM drug_nutrient_interactions " +
      "WHERE LOWER(drug_name) = LOWER($1)",
    paramNames: ["drug_name"],
    paramTypes: ["string"],
  },
  {
    id: "all_drug_interactions",
    description:
      "Get all known drug-nutrient interactions in the database. " +
      "Returns drug name, nutrient, food examples, severity, and source " +
      "for every recorded interaction.",
    sql:
      "SELECT drug_name, nutrient, food_examples, severity, source " +
      "FROM drug_nutrient_interactions " +
      "ORDER BY drug_name",
    paramNames: [],
    paramTypes: [],
  },
];

/** 按 ID 查找模板（白名单检索）。O(n) 对 5 条模板可接受。 */
export function findTemplate(id: string): SqlTemplate | undefined {
  return SQL_TEMPLATES.find((t) => t.id === id);
}

/** 校验 params 与模板形参是否匹配。返回错误描述列表，空列表表示通过。 */
export function validateParams(
  template: SqlTemplate,
  params: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const provided = new Set(Object.keys(params));

  // 检查缺失的必需参数
  for (const name of template.paramNames) {
    if (!provided.has(name)) {
      errors.push(`missing required param: ${name}`);
    }
  }

  // 检查多余参数（不在模板定义中的键）
  const allowed = new Set(template.paramNames);
  for (const key of provided) {
    if (!allowed.has(key)) {
      errors.push(`unknown param: ${key}`);
    }
  }

  // 类型校验
  for (let i = 0; i < template.paramNames.length; i++) {
    const name = template.paramNames[i];
    const value = params[name];
    if (value === undefined || value === null) continue; // 缺失已报

    const expectedType = template.paramTypes[i];
    switch (expectedType) {
      case "number":
        if (typeof value !== "number") {
          errors.push(
            `param "${name}" must be a number, got ${typeof value}`,
          );
        }
        break;
      case "string":
        if (typeof value !== "string" || value === "") {
          errors.push(
            `param "${name}" must be a non-empty string`,
          );
        }
        break;
      case "uuid":
        if (typeof value !== "string" || value === "") {
          errors.push(
            `param "${name}" must be a non-empty UUID string`,
          );
        }
        break;
    }
  }

  return errors;
}

/** 构建注入 system prompt 的模板描述段。供 ContextAssembler pinned region 使用。 */
export function buildTemplatePromptSection(): string {
  const header =
    "[TOOL: code_act] You have access to a code_act tool that runs pre-validated SQL queries. " +
    "Call it with { \"template_id\": \"<id>\", \"params\": { \"<name>\": <value>, ... } }. " +
    "Available templates:\n";

  const entries = SQL_TEMPLATES.map((t) => {
    const paramsDesc =
      t.paramNames.length > 0
        ? ` Params: ${t.paramNames
            .map((n, i) => `${n}:${t.paramTypes[i]}`)
            .join(", ")}.`
        : " No params required.";
    return `  - ${t.id}: ${t.description}${paramsDesc}`;
  });

  return header + entries.join("\n");
}
