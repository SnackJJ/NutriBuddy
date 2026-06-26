// CodeAct Executor（issue #11 / PRD v2 §3.2「CodeAct 批量数据查询」）。
//
// 白名单模式执行器：只允许跑预定义 SQL 模板，模型产出 { template_id, params }
// → executor 填参执行 → 返回结构化结果。
//
// 安全约束（M1 硬执行）：
//   - 白名单：仅 SQL_TEMPLATES 中的模板可执行
//   - 只读：SELECT only，拒 INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE
//   - 上限：所有查询自动追加 LIMIT 100
//   - 超时：2s 硬限制
//
// 执行接口（QueryExecutor）可注入，单测不触网。

import type { ToolHandler } from "./types";
import {
  findTemplate,
  validateParams,
} from "./sqlTemplates";

/** 参数化查询执行器。接收 SQL 模板（含 $1, $2, ... 占位符）和参数数组。 */
export type QueryExecutor = (
  sql: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

/** CodeAct 执行器依赖。 */
export interface CodeActDeps {
  /** 参数化查询执行器（注入 Supabase 或 mock）。 */
  readonly executeQuery: QueryExecutor;
  /** 超时毫秒数（默认 2000）。 */
  readonly timeout?: number;
}

/** 默认超时（2s 硬限制，PRD §3.2）。 */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * 验证 SQL 文本为只读（SELECT only）。
 * 防御性深度校验 —— 即使模板目录已预验证，运行时再查一次。
 */
export function validateSqlReadOnly(sql: string): boolean {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();

  if (!upper.startsWith("SELECT")) {
    return false;
  }

  // 在 SELECT 关键字之后的部分检查危险关键字
  const afterSelect = upper.slice(6);
  const dangerous = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "CREATE",
  ];
  return !dangerous.some((kw) => {
    // 使用词边界防止子串误判（如 "SELECT_DELETE" 不会误触发）
    const re = new RegExp(`\\b${kw}\\b`);
    return re.test(afterSelect);
  });
}

/**
 * 带超时的 Promise 竞速。
 * 超时抛 Error，不清除原 Promise（让它自然完成/失败）。
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Query timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在 SQL 末尾追加 LIMIT 100（若尚无 LIMIT 子句）。
 * 保留原 SQL 的空白/分号结构。
 */
function ensureLimit(sql: string): string {
  if (/\bLIMIT\b/i.test(sql)) return sql;
  const trimmed = sql.trimEnd();
  // 移除末尾分号（如果有），追加 LIMIT，再还原分号
  const semi = trimmed.endsWith(";");
  const base = semi ? trimmed.slice(0, -1).trimEnd() : trimmed;
  return `${base} LIMIT 100${semi ? ";" : ""}`;
}

/**
 * 创建 CodeAct 工具处理器。
 *
 * 返回的 ToolHandler 可注入 loop 的 tools Map：
 *   tools.set("code_act", createCodeActHandler({ executeQuery }))
 *
 * 模型调用格式：
 *   { template_id: "profile_query", params: { user_id: "..." } }
 *
 * 返回 JSON 字符串：
 *   { rows: [...], rowCount: N, templateId: "..." }
 *   或错误：{ error: "..." }
 */
export function createCodeActHandler(deps: CodeActDeps): ToolHandler {
  const timeoutMs = deps.timeout ?? DEFAULT_TIMEOUT_MS;

  return async (args: Readonly<Record<string, unknown>>): Promise<string> => {
    try {
      // 1. 解析输入 ────────────────────────────────────────────────
      const templateId = args.template_id;
      if (typeof templateId !== "string" || templateId.length === 0) {
        return JSON.stringify({
          error: "missing or invalid template_id. Must be a non-empty string.",
        });
      }

      const params =
        (args.params as Record<string, unknown> | undefined) ?? {};

      // 2. 白名单检索 ──────────────────────────────────────────────
      const template = findTemplate(templateId);
      if (!template) {
        return JSON.stringify({
          error: `unknown template: "${templateId}". Use one of the available templates listed in the system prompt.`,
        });
      }

      // 3. 参数校验 ────────────────────────────────────────────────
      const paramErrors = validateParams(template, params);
      if (paramErrors.length > 0) {
        return JSON.stringify({
          error: `param validation failed: ${paramErrors.join("; ")}`,
        });
      }

      // 4. 构建 SQL（追加 LIMIT） ─────────────────────────────────
      const sql = ensureLimit(template.sql);

      // 5. 只读校验（防御性深度检查） ────────────────────────────
      if (!validateSqlReadOnly(sql)) {
        return JSON.stringify({
          error:
            "non-SELECT query blocked. Only read-only SQL templates are allowed.",
        });
      }

      // 6. 按模板形参顺序构建参数数组 ─────────────────────────────
      const paramValues: unknown[] = template.paramNames.map(
        (name) => params[name],
      );

      // 7. 带超时的查询执行 ────────────────────────────────────────
      const rows = await withTimeout(
        deps.executeQuery(sql, paramValues),
        timeoutMs,
      );

      // 8. 返回结构化结果 ──────────────────────────────────────────
      return JSON.stringify({
        rows,
        rowCount: rows.length,
        templateId: template.id,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  };
}
