// log_meal 工具处理器（issue #14 / PRD v2 §3.1「ToolRegistry」/ issue #36 / issue #44）。
//
// Proposal-only writes: resolves food strings through the deterministic catalog
// resolver cascade (exact → alias → fuzzy), computes nutrition from per-100g
// catalog values server-side, and stores an immutable proposal. A resolver miss
// (ambiguous / low-confidence / unknown) returns a typed clarification error so
// the turn ends asking for clarification instead of guessing.
//
// The turn ends with a write-proposal terminal event; the user confirms
// in a later turn before any mutation occurs.
//
// 所有副作用依赖（catalog / 提案存储）皆可注入，单测不触网。

import type { ToolHandler } from "./types";
import type {
  Catalog,
  FoodRef,
  ResolveMissResult,
  ResolveResult,
} from "../catalog/catalog";
import { resolveFood } from "../catalog/resolver";
import type { HandlerOutcome, JsonValue } from "./toolOutcome";

// ─── 常量 ─────────────────────────────────────────────────────────────────

const VALID_MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);

const DEFAULT_MEAL_TYPE = "snack";

type ResolvedMatchType = FoodRef["matchType"];

// ── 提案写入端口（issue #36 / PRD v2 §3.4 / ADD §Tools）──

/** 提案状态机（issue #37 / PRD v2 §3.4 / ADD §Memory：proposed → committed | voided | superseded | expired）。 */
export type ProposalStatus =
  | "proposed"
  | "committed"
  | "voided"
  | "expired"
  | "superseded";

/** 写入提案所需的不可变数据。 */
export interface ProposalInput {
  readonly userId: string;
  readonly foodId: string;
  readonly foodName: string;
  readonly canonicalName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
  readonly nutritionSource: string;
  readonly matchType: ResolvedMatchType;
  readonly allergenTags: readonly string[];
}

/** 已持久化的不可变提案。 */
export interface Proposal {
  readonly id: string;
  readonly userId: string;
  readonly foodId: string;
  readonly foodName: string;
  readonly canonicalName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
  readonly nutritionSource: string;
  readonly matchType: ResolvedMatchType;
  readonly allergenTags: readonly string[];
  readonly status: ProposalStatus;
  readonly createdAt: string;
}

type ScaledNutrition = Pick<
  ProposalInput,
  "kcal" | "proteinG" | "fatG" | "carbsG"
>;

/**
 * Result of an atomic commit + meal insert (RFC 0001 Phase 1).
 * Discriminant `kind` is the sole business control-flow signal.
 */
export type CommitResult =
  | {
      readonly kind: "committed";
      readonly proposalId: string;
      readonly mealLogId: number;
    }
  | { readonly kind: "not_committable" }
  | { readonly kind: "error"; readonly cause: string };

/**
 * Result of voiding a proposal (RFC 0001 Phase 1).
 * Same business status set as CommitResult (committed | voided | not_committable).
 */
export type VoidResult =
  | { readonly kind: "voided"; readonly proposalId: string }
  | { readonly kind: "not_committable" }
  | { readonly kind: "error"; readonly cause: string };

/** 提案存储端口。可注入 Supabase 实现或单测 mock。 */
export interface ProposalStore {
  /** Store a new proposal in "proposed" status. */
  store(input: ProposalInput): Promise<Proposal>;
  /** Look up a proposal by id. */
  get(id: string): Promise<Proposal | undefined>;
  /**
   * Atomically transition proposal to committed and insert the meal ledger
   * row. Ownership and status checks are inside this call (RPC / critical
   * section) — callers must not pre-check ownership.
   */
  commitProposalAndInsertMeal(proposalId: string): Promise<CommitResult>;
  /**
   * Transition a proposed proposal to voided. Same ownership collapse as
   * commit: missing / wrong-owner / non-proposed → not_committable.
   */
  voidProposal(proposalId: string): Promise<VoidResult>;
}

// ─── 膳食存储端口（utterance 读路径 / 遗留；confirm 写经 ProposalStore RPC）─

/** 一条已持久化的饮食记录。 */
export interface MealLogEntry {
  readonly id: number;
  readonly userId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly loggedAt: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
  /** The committed proposal that authorised this write (issue #37). */
  readonly proposalId: string;
  /** Resolver-minted food id copied from the proposal (issue #59). Legacy rows lack it. */
  readonly foodId?: string;
  /** Resolver match type copied from the proposal (issue #59). */
  readonly matchType?: string;
  /** Allergen tags copied from the proposal (issue #59). */
  readonly allergenTags?: readonly string[];
}

/** 插入餐食记录所需的参数（不含 id / loggedAt，由 store 生成）。 */
export interface MealLogInsert {
  readonly userId: string;
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
  readonly kcal: number;
  readonly proteinG: number;
  readonly fatG: number;
  readonly carbsG: number;
  /**
   * The committed proposal id that authorised this write.
   * Meal ledger rows always reference their source proposal (issue #37).
   */
  readonly proposalId: string;
  /** Resolver-minted food id from the committed proposal (issue #59). */
  readonly foodId: string;
  /** Resolver match type from the committed proposal (issue #59). */
  readonly matchType: string;
  /** Allergen tags from the committed proposal (issue #59). */
  readonly allergenTags: readonly string[];
}

/** 餐食存储端口。可注入 Supabase 实现或单测 mock。 */
export interface MealLogStore {
  insert(params: MealLogInsert): Promise<MealLogEntry>;
}

// ─── 工具依赖 ─────────────────────────────────────────────────────────────

export interface LogMealDeps {
  /** Local food catalog for resolver lookup (issue #44). */
  readonly catalog: Catalog;
  /** 不可变提案存储（不直接写入 meal ledger — issue #36）。 */
  readonly proposalStore: ProposalStore;
  /** 当前用户 ID（由调用方注入，不暴露给模型）。 */
  readonly userId: string;
}

// ─── 参数校验 ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  readonly foodName: string;
  readonly portionG: number;
  readonly mealType: string;
}

function parseArgs(
  args: Readonly<Record<string, unknown>>,
): ParsedArgs | string {
  const foodName = args.food_name;
  if (typeof foodName !== "string" || foodName.trim().length === 0) {
    return "missing or invalid food_name: must be a non-empty string";
  }

  const portionG = args.portion_g;
  if (
    typeof portionG !== "number" ||
    !Number.isFinite(portionG) ||
    portionG <= 0
  ) {
    return "missing or invalid portion_g: must be a positive number (grams)";
  }

  let mealType = DEFAULT_MEAL_TYPE;
  if (args.meal_type !== undefined) {
    if (
      typeof args.meal_type !== "string" ||
      !VALID_MEAL_TYPES.has(args.meal_type)
    ) {
      return (
        `invalid meal_type "${String(args.meal_type)}": ` +
        `must be one of ${[...VALID_MEAL_TYPES].join(", ")}`
      );
    }
    mealType = args.meal_type;
  }

  return { foodName: foodName.trim(), portionG, mealType };
}

// ─── 营养缩放 ─────────────────────────────────────────────────────────────

/** Scale per-100g nutrition values to the requested portion. */
function scaleNutrition(
  per100g: FoodRef["per100g"],
  portionG: number,
): ScaledNutrition {
  const scale = portionG / 100;
  const round = (v: number) => Math.round(v * scale * 10) / 10;
  return {
    kcal: round(per100g.kcal),
    proteinG: round(per100g.proteinG),
    fatG: round(per100g.fatG),
    carbsG: round(per100g.carbsG),
  };
}

// ─── 响应构建 ─────────────────────────────────────────────────────────────

function proposalResponse(proposal: Proposal): HandlerOutcome {
  const data: JsonValue = {
    proposal_id: proposal.id,
    message: `Log ${proposal.portionG}g ${proposal.foodName} for ${proposal.mealType}? (${proposal.kcal} kcal, ${proposal.proteinG}g protein) — Confirm?`,
    proposal: {
      id: proposal.id,
      food_id: proposal.foodId,
      food_name: proposal.foodName,
      canonical_name: proposal.canonicalName,
      portion_g: proposal.portionG,
      meal_type: proposal.mealType,
      created_at: proposal.createdAt,
      nutrition: {
        kcal: proposal.kcal,
        protein_g: proposal.proteinG,
        fat_g: proposal.fatG,
        carbs_g: proposal.carbsG,
      },
      nutrition_source: proposal.nutritionSource,
      match_type: proposal.matchType,
      allergen_tags: [...proposal.allergenTags],
    },
    nutrition_summary: {
      kcal: proposal.kcal,
      protein_g: proposal.proteinG,
      fat_g: proposal.fatG,
      carbs_g: proposal.carbsG,
    },
  };
  return { kind: "ok", data };
}

function isResolverMiss(result: ResolveResult): result is ResolveMissResult {
  return result.foodRef === null;
}

function resolverMissResponse(result: ResolveMissResult): HandlerOutcome {
  const candidates = (result.candidates ?? []).map((candidate) => {
    const row: { [key: string]: JsonValue } = {
      food_id: candidate.foodId,
      food_name: candidate.canonicalName,
      match_score: Math.round(candidate.matchScore * 100) / 100,
    };
    // Preserve unreviewed allergen state: omit key when undefined (not []).
    if (candidate.allergenTags !== undefined) {
      row.allergen_tags = [...candidate.allergenTags];
    }
    return row;
  });

  const data: JsonValue = {
    error: `food not found in catalog: "${result.input}"`,
    match_type: result.matchType,
    catalog_snapshot: result.catalogSnapshotId,
    message: clarificationMessage(result),
    ...(candidates.length > 0 ? { candidates } : {}),
  };

  return {
    kind: "typed_miss",
    message: `food not found in catalog: "${result.input}"`,
    data,
    candidates: candidates.length > 0 ? candidates : undefined,
  };
}

function clarificationMessage(result: ResolveMissResult): string {
  switch (result.matchType) {
    case "miss_ambiguous":
      return (
        `"${result.input}" matched multiple foods with similar scores. ` +
        "Could you be more specific?"
      );
    case "miss_low_confidence":
      return (
        `"${result.input}" had a low-confidence match. ` +
        "Did you mean one of the candidates?"
      );
    case "miss_unknown":
      return (
        `"${result.input}" is not in the food catalog. ` +
        "Try a different name or check the spelling."
      );
    default:
      return `"${result.input}" could not be resolved.`;
  }
}

function errorResponse(message: string): HandlerOutcome {
  return {
    kind: "typed_error",
    message,
    data: { error: message },
  };
}

// ─── OpenAI Function-Calling Schema ────────────────────────────────────────

/** log_meal 的 OpenAI function-calling 工具定义。 */
export const LOG_MEAL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "log_meal",
    description:
      "Propose logging a meal to the user's food diary. Provide food name, " +
      "portion in grams, and meal type (breakfast/lunch/dinner/snack). " +
      "The tool resolves food entities through the local catalog resolver " +
      "(exact → alias → fuzzy cascade) and computes nutrition from catalog " +
      "per-100g values, then stores an immutable proposal. The user must " +
      "confirm before any data is written to the meal ledger. Returns a " +
      "confirmation prompt with a nutrition summary (kcal, protein, fat, " +
      "carbs) and resolved entity lineage (food id, match type, allergens).",
    parameters: {
      type: "object" as const,
      properties: {
        food_name: {
          type: "string",
          description:
            "Food name in English, e.g. 'chicken breast', 'rice', 'apple'.",
        },
        portion_g: {
          type: "number",
          description: "Portion size in grams, must be > 0. E.g. 200 for 200g.",
        },
        meal_type: {
          type: "string",
          enum: ["breakfast", "lunch", "dinner", "snack"],
          description: "Meal type. Defaults to 'snack' if omitted.",
        },
      },
      required: ["food_name", "portion_g"],
    },
  },
};

// ─── 工具工厂 ─────────────────────────────────────────────────────────────

/**
 * 创建 log_meal 工具处理器。
 *
 * 依赖全部可注入以便单测不触网；对应的 function-calling schema 导出为
 * LOG_MEAL_SCHEMA。
 *
 * Issue #36：处理器存储不可变提案而非直接写入膳食账本。
 * 模型输出路径无法触及 MealLogStore。
 *
 * Issue #44：食物通过 catalog resolver 解析，营养从 catalog per-100g
 * 值按份量缩放。resolver miss 时返回 typed clarification 而非猜测。
 */
export function createLogMealHandler(deps: LogMealDeps): ToolHandler {
  const { catalog, proposalStore, userId } = deps;

  return async (
    args: Readonly<Record<string, unknown>>,
  ): Promise<HandlerOutcome> => {
    const parsed = parseArgs(args);
    if (typeof parsed === "string") {
      return errorResponse(parsed);
    }

    const resolved = resolveFood(catalog, parsed.foodName);

    // ── Resolver miss → clarification ──────────────────────────────────
    if (isResolverMiss(resolved)) {
      return resolverMissResponse(resolved);
    }

    const foodRef = resolved.foodRef;
    const scaled = scaleNutrition(foodRef.per100g, parsed.portionG);

    // ProposalStore / unexpected throws propagate → dispatch maps to infra_error
    const proposal = await proposalStore.store({
      userId,
      foodId: foodRef.foodId,
      foodName: parsed.foodName,
      canonicalName: foodRef.canonicalName,
      portionG: parsed.portionG,
      mealType: parsed.mealType,
      kcal: scaled.kcal,
      proteinG: scaled.proteinG,
      fatG: scaled.fatG,
      carbsG: scaled.carbsG,
      nutritionSource: resolved.catalogSnapshotId,
      matchType: foodRef.matchType,
      // Record path: unreviewed tags degrade to [] in the ledger row.
      // The recommendation surface is protected by the output entity
      // check, which reads the catalog entry itself (issue #66).
      allergenTags: foodRef.allergenTags ?? [],
    });

    return proposalResponse(proposal);
  };
}
