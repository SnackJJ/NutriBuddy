// ② ContextAssembler：拼装发给模型的上下文窗口。
//
// 分成两个区域：
//   1. Pinned Region（AOT — 字节稳定，最大化 prompt cache 命中）
//      System prompt + user profile + SQL 模板 catalog + tool definitions
//   2. Dynamic Region（JIT — 每轮变化）
//      当前轮用户消息 + 历史对话（含 tool_call/tool_result 对 + Thought）
//
// 用法：
//   const pinned = { systemPrompt, userProfile, sqlTemplates, toolDefs };
//   const messages = assembleContext({ pinned, history, userInput });
//
// pinned 跨轮不变 → system message 字节一致 → prompt cache 命中。

import type { ChatMessage } from "./types";
import type {
  ColumnDef,
  ParamDef,
  QueryCatalog,
} from "../catalog/queryCatalog";

export const DEFAULT_SYSTEM_PROMPT =
  "你是 NutriBuddy，一个谨慎、循证的个人营养顾问。\n\n" +
  "When you are ready to deliver your final answer, you MUST call the " +
  "submit_answer tool. Provide your full prose response in the 'prose' field, " +
  "structured food references in 'foodRefs' (with foodId, foodName, and matchType " +
  "for every food you recommend), and applicable safety advisory rules in " +
  "'ruleRefs' (with ruleId and summary). Do NOT end the turn with plain prose — " +
  "always deliver the final answer through submit_answer.";

// ─── Tool Definitions ─────────────────────────────────────────────────

/** 工具描述，注入 system prompt 告知模型可调用哪些工具。 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** 可选的 JSON Schema 参数描述。 */
  readonly parameters?: string;
}

// ─── Pinned Region ─────────────────────────────────────────────────────

/** Pinned region 输入：跨轮不变，字节稳定，最大化 prompt cache 命中。 */
export interface PinnedRegion {
  /** Agent 角色定义 + 行为约束。 */
  readonly systemPrompt: string;
  /** 用户档案文本：过敏、用药、目标（来自 #8 / gate）。 */
  readonly userProfile?: string;
  /** SQL 模板 catalog（来自 #11，由 buildTemplatePromptSection() 产出）。 */
  readonly sqlTemplates?: string;
  /** 当前可用工具的 JSON schema 列表。 */
  readonly toolDefs?: readonly ToolDef[];
}

/**
 * 从各组件拼装稳定的 pinned region 文本。
 * 相同输入 → 字节一致的输出 → 最大化 prompt cache 命中。
 */
export function assemblePinnedRegion(pinned: PinnedRegion): string {
  const sections: string[] = [pinned.systemPrompt];

  if (pinned.userProfile) {
    sections.push(pinned.userProfile);
  }

  if (pinned.sqlTemplates) {
    sections.push(pinned.sqlTemplates);
  }

  if (pinned.toolDefs && pinned.toolDefs.length > 0) {
    const lines = pinned.toolDefs.map((t) => {
      let entry = `  - ${t.name}: ${t.description}`;
      if (t.parameters) {
        entry += `\n    Parameters: ${t.parameters}`;
      }
      return entry;
    });
    sections.push(`[AVAILABLE TOOLS]\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

// ─── Dynamic Region ────────────────────────────────────────────────────

export interface AssembleInput {
  /** Pinned region（AOT — 字节稳定，跨轮不变）。 */
  readonly pinned: PinnedRegion;
  /** 历史对话（含 tool_call/tool_result 对 + Thought）。动态增长。 */
  readonly history: readonly ChatMessage[];
  /** 当前轮用户输入。 */
  readonly userInput: string;
}

/**
 * 拼装发给模型的完整消息列表。
 *
 * Layout（关键：prompt cache 依赖稳定前缀）：
 *   1. system 消息（pinned region — 字节稳定）
 *   2. 历史对话消息
 *   3. 当前轮 user 消息
 */
export function assembleContext(input: AssembleInput): ChatMessage[] {
  const systemContent = assemblePinnedRegion(input.pinned);
  return [
    { role: "system", content: systemContent },
    ...input.history,
    { role: "user", content: input.userInput },
  ];
}

// ─── Query Catalog Template Injection ──────────────────────────────────────

function formatTemplateParameter(parameter: ParamDef): string {
  const required = parameter.required ? "(required)" : "(optional)";
  const enumHint =
    parameter.enumValues && parameter.enumValues.length > 0
      ? ` [${parameter.enumValues.join(" | ")}]`
      : "";

  return `    - ${parameter.name}: ${parameter.type} ${required}${enumHint} — ${parameter.description}`;
}

function formatResultColumn(column: ColumnDef): string {
  const unit = column.unit ? ` (${column.unit})` : "";
  return `    - ${column.name}: ${column.type}${unit} — ${column.description}`;
}

/**
 * Build a prompt section exposing reviewed query template signatures.
 *
 * When a {@link QueryCatalog} is provided, each template's id, description,
 * typed parameters, and result schema are rendered as a stable prompt section
 * for model consumption. The model selects templates by id and provides typed
 * parameters; deterministic code validates, executes, and returns observations.
 *
 * Returns undefined when no catalog is provided (backward compat: no templates
 * exposed = model cannot invoke query_catalog).
 */
export function buildTemplatePromptSection(
  catalog?: QueryCatalog,
): string | undefined {
  if (!catalog || catalog.templateList.length === 0) {
    return undefined;
  }

  const lines: string[] = [
    "[QUERY TEMPLATE CATALOG]",
    "You have access to the following reviewed query templates. To use one, call the",
    "query_catalog tool with a template_id and typed parameters. You may NOT invent",
    "template IDs or parameters — only the ones listed below are valid.",
    "",
  ];

  for (const t of catalog.templateList) {
    lines.push(`Template: ${t.id}`);
    lines.push(`  Description: ${t.description}`);

    if (t.parameters.length > 0) {
      lines.push("  Parameters:");
      for (const p of t.parameters) {
        lines.push(formatTemplateParameter(p));
      }
    }

    lines.push("  Result columns:");
    for (const c of t.resultSchema) {
      lines.push(formatResultColumn(c));
    }

    lines.push("");
  }

  return lines.join("\n");
}
