// submit_answer 工具定义与参数解析（issue #43 / PRD v2 §2.2 / ADD §Loop）。
//
// 模型通过调用 submit_answer 工具提交最终答案。handler 不存在于 tools Map 中：
// loop 自身识别此工具调用并终止回合，携带从 args 解析出的 TypedOutput。
// 这样可以打通实时模型的 TypedOutput → 输出闸门路径。

import {
  CITATION_QUOTE_MAX_CHARS,
  type CitationRef,
  type FoodRef,
  type RuleRef,
  type ToolSchema,
  type TypedOutput,
} from "./types";

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
      "foodId, cite every applicable safety rule in 'ruleRefs', and — when you claim what " +
      "authoritative guidance says — cite the evidence section it came from in 'citations' " +
      "using only the section ids listed in the current evidence set.",
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
        citations: {
          type: "array",
          description:
            "Evidence citations for any claim about what guidance says. Each entry is a " +
            "section id from the current evidence set, with the document id and version " +
            "it belongs to. Omit entries you cannot resolve to a section id — an " +
            "unresolvable citation is stripped by the gate and weakens the answer.",
          items: {
            type: "object",
            properties: {
              sectionId: {
                type: "string",
                description: "Section id exactly as listed in the evidence set.",
              },
              sourceId: {
                type: "string",
                description: "Document id the section belongs to.",
              },
              docVersion: {
                type: "string",
                description: "Document version you were shown.",
              },
              quote: {
                type: "string",
                description: `Optional short quotation (at most ${CITATION_QUOTE_MAX_CHARS} characters).`,
              },
            },
            required: ["sectionId", "sourceId", "docVersion"],
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
  const citations = parseArrayItems(args.citations, parseCitation);

  // If no prose at all, return null so caller can fall back to content
  if (
    prose.length === 0 &&
    foodRefs.length === 0 &&
    ruleRefs.length === 0 &&
    citations.length === 0
  ) {
    return null;
  }

  return {
    prose,
    foodRefs,
    ruleRefs,
    // Only present when the model actually cited something: an empty array would
    // make "cited nothing" indistinguishable from "does not know how to cite",
    // and the citation gate needs that distinction to stay fail-closed without
    // punishing answers that simply have no evidence claim to make.
    ...(citations.length > 0 ? { citations } : {}),
  };
}

/**
 * One citation, parsed defensively.
 *
 * Malformed entries are dropped here rather than repaired: a citation missing its
 * document id cannot be checked, and inventing one would be the gate verifying a
 * claim the model never made. The gate still re-checks everything this keeps,
 * because being parseable is not the same as being true.
 */
function parseCitation(value: unknown): CitationRef | null {
  if (!isRecord(value)) return null;
  const sectionId = value.sectionId;
  const sourceId = value.sourceId;
  const docVersion = value.docVersion;
  if (
    typeof sectionId !== "string" ||
    typeof sourceId !== "string" ||
    typeof docVersion !== "string" ||
    sectionId.length === 0 ||
    sourceId.length === 0 ||
    docVersion.length === 0
  ) {
    return null;
  }

  const quote = typeof value.quote === "string" ? value.quote.trim() : "";
  return {
    sectionId,
    sourceId,
    docVersion,
    ...(quote.length > 0
      ? { quote: quote.slice(0, CITATION_QUOTE_MAX_CHARS) }
      : {}),
  };
}
