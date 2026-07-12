// submit_answer 工具定义与参数解析（issue #43 / PRD v2 §2.2 / ADD §Loop）。
//
// 模型通过调用 submit_answer 工具提交最终答案。handler 不存在于 tools Map 中：
// loop 自身识别此工具调用并终止回合，携带从 args 解析出的 TypedOutput。
// 这样可以打通实时模型的 TypedOutput → 输出闸门路径。

import type { FoodRef, RuleRef, ToolSchema, TypedOutput } from "./types";

// ─── 常量 ─────────────────────────────────────────────────────────────────

export const SUBMIT_ANSWER_TOOL = "submit_answer";
const VALID_MATCH_TYPES = ["exact", "alias", "fuzzy"] as const;

// ─── OpenAI Function-Calling Schema ────────────────────────────────────────

/** submit_answer 的 OpenAI function-calling 工具定义。 */
export const SUBMIT_ANSWER_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: SUBMIT_ANSWER_TOOL,
    description:
      "Submit the final answer with structured food references and advisory rule citations. " +
      "Always use this tool to deliver your final response. Provide your full prose response " +
      "in the 'prose' field, cite every food you recommend in 'foodRefs' with its catalog " +
      "foodId, and cite every applicable safety rule in 'ruleRefs'.",
    parameters: {
      type: "object",
      properties: {
        prose: {
          type: "string",
          description:
            "The full prose response to the user. Include all recommendations, " +
            "explanations, and numeric facts here.",
        },
        foodRefs: {
          type: "array",
          description:
            "Structured references for every food recommended in the prose. " +
            "Each entry must include the catalog foodId, display name, and match type.",
          items: {
            type: "object",
            properties: {
              foodId: {
                type: "string",
                description: "Catalog food identifier.",
              },
              foodName: {
                type: "string",
                description: "Human-readable food name.",
              },
              matchType: {
                type: "string",
                enum: ["exact", "alias", "fuzzy"],
                description: "How the food was matched in the catalog.",
              },
            },
            required: ["foodId", "foodName", "matchType"],
          },
        },
        ruleRefs: {
          type: "array",
          description:
            "Structured references for every safety advisory rule cited in the prose. " +
            "Include this whenever there are food recommendations, especially when " +
            "allergies or drug interactions are present.",
          items: {
            type: "object",
            properties: {
              ruleId: {
                type: "string",
                description: "Stable identifier for the cited rule.",
              },
              summary: {
                type: "string",
                description: "One-line summary of the rule.",
              },
            },
            required: ["ruleId", "summary"],
          },
        },
      },
      required: ["prose", "foodRefs", "ruleRefs"],
    },
  },
};

// ─── 参数解析 ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMatchType(value: unknown): value is FoodRef["matchType"] {
  return (
    typeof value === "string" &&
    VALID_MATCH_TYPES.includes(value as FoodRef["matchType"])
  );
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every((item) => typeof item === "string") ? value : undefined;
}

function parseFoodRef(ref: unknown): FoodRef | null {
  if (
    !isRecord(ref) ||
    typeof ref.foodId !== "string" ||
    ref.foodId.length === 0 ||
    typeof ref.foodName !== "string" ||
    ref.foodName.length === 0 ||
    !isMatchType(ref.matchType)
  ) {
    return null;
  }

  const allergens = readStringArray(ref.allergens);
  if (allergens) {
    return {
      foodId: ref.foodId,
      foodName: ref.foodName,
      matchType: ref.matchType,
      allergens,
    };
  }

  return {
    foodId: ref.foodId,
    foodName: ref.foodName,
    matchType: ref.matchType,
  };
}

function parseRuleRef(ref: unknown): RuleRef | null {
  if (
    !isRecord(ref) ||
    typeof ref.ruleId !== "string" ||
    ref.ruleId.length === 0 ||
    typeof ref.summary !== "string"
  ) {
    return null;
  }

  return {
    ruleId: ref.ruleId,
    summary: ref.summary,
  };
}

function parseArrayItems<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: T[] = [];
  for (const item of value) {
    const parsedItem = parseItem(item);
    if (parsedItem) {
      parsed.push(parsedItem);
    }
  }
  return parsed;
}

/**
 * 将 submit_answer 工具调用参数解析为 TypedOutput。
 *
 * 防御性解析：prose 缺省为空字符串，foodRefs/ruleRefs 过滤非法条目，
 * 因此即使模型参数格式有偏差也不会崩溃。
 *
 * 如果 prose 为空且 content 有值（模型同时在 text content 和
 * tool call args 中提供了 prose），返回 null 让调用方使用 content
 * 作为 prose 降级。
 */
export function parseSubmitAnswerArgs(
  args: Readonly<Record<string, unknown>>,
): TypedOutput | null {
  const prose = typeof args.prose === "string" ? args.prose : "";
  const foodRefs = parseArrayItems(args.foodRefs, parseFoodRef);
  const ruleRefs = parseArrayItems(args.ruleRefs, parseRuleRef);

  // If no prose at all, return null so caller can fall back to content
  if (prose.length === 0 && foodRefs.length === 0 && ruleRefs.length === 0) {
    return null;
  }

  return { prose, foodRefs, ruleRefs };
}
