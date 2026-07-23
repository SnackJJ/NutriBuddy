// Supabase 提案存储实现（issue #48 / PRD v2 §3.1 / ADD §Multi-User / RFC 0001 Phase 1）。
//
// 将 ProposalStore 端口接上 Supabase `proposals` 表与 atomic RPCs。
// 沿用 harness/Supabase 既有约定：窄端口可注入，单测不触网。

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProposalStore,
  Proposal,
  ProposalInput,
  ProposalStatus,
  CommitResult,
  VoidResult,
} from "../harness/logMeal";

// ── DB row mapping ──────────────────────────────────────────────────────

/** Postgres 表行形状（snake_case，与 supabase/migrations/0004_proposals.sql 对应）。 */
interface ProposalDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly food_id: string;
  readonly food_name: string;
  readonly canonical_name: string;
  readonly portion_g: number;
  readonly meal_type: string;
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly nutrition_source: string;
  readonly match_type: string;
  readonly allergen_tags: string[];
  readonly status: string;
  readonly created_at: string;
}

function rowToProposal(
  row: ProposalDbRow,
  allergenCoverage: Proposal["allergenCoverage"] = "reviewed",
): Proposal {
  return {
    id: row.id,
    userId: row.user_id,
    foodId: row.food_id,
    foodName: row.food_name,
    canonicalName: row.canonical_name,
    portionG: row.portion_g,
    mealType: row.meal_type,
    kcal: row.kcal,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    carbsG: row.carbs_g,
    nutritionSource: row.nutrition_source,
    matchType: row.match_type as Proposal["matchType"],
    allergenTags: row.allergen_tags ?? [],
    // Not persisted yet (no migration): callers pass through from ProposalInput
    // on store(); get()/legacy rows default to reviewed.
    allergenCoverage,
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
  };
}

function inputToRow(
  params: ProposalInput,
  id: string,
  now: string,
): Omit<ProposalDbRow, "status"> {
  return {
    id,
    user_id: params.userId,
    food_id: params.foodId,
    food_name: params.foodName,
    canonical_name: params.canonicalName,
    portion_g: params.portionG,
    meal_type: params.mealType,
    kcal: params.kcal,
    protein_g: params.proteinG,
    fat_g: params.fatG,
    carbs_g: params.carbsG,
    nutrition_source: params.nutritionSource,
    match_type: params.matchType,
    // Keep NOT NULL text[] contract; coverage lives on the tool/terminal payload.
    allergen_tags: [...params.allergenTags],
    created_at: now,
  };
}

// ── RPC jsonb mapping (known keys only) ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCause(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function mapCommitResult(data: unknown): CommitResult {
  if (!isRecord(data)) {
    return { kind: "error", cause: "unexpected commit RPC payload" };
  }

  const status = data.status;
  if (status === "not_committable") {
    return { kind: "not_committable" };
  }

  if (status === "committed") {
    const proposalId = data.proposal_id;
    const mealLogId = data.meal_log_id;
    if (typeof proposalId !== "string" || typeof mealLogId !== "number") {
      return {
        kind: "error",
        cause: "committed payload missing proposal_id or meal_log_id",
      };
    }
    return { kind: "committed", proposalId, mealLogId };
  }

  return {
    kind: "error",
    cause: `unexpected commit status: ${String(status)}`,
  };
}

function mapVoidResult(data: unknown): VoidResult {
  if (!isRecord(data)) {
    return { kind: "error", cause: "unexpected void RPC payload" };
  }

  const status = data.status;
  if (status === "not_committable") {
    return { kind: "not_committable" };
  }

  if (status === "voided") {
    const proposalId = data.proposal_id;
    if (typeof proposalId !== "string") {
      return {
        kind: "error",
        cause: "voided payload missing proposal_id",
      };
    }
    return { kind: "voided", proposalId };
  }

  return {
    kind: "error",
    cause: `unexpected void status: ${String(status)}`,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────

const TABLE = "proposals";
const ID_PREFIX = "proposal";

function generateProposalId(): string {
  // proposal-* id shape, collision-free across processes and clock-independent
  // (ADD §Testing Seam: nothing below the seam reads the clock outside its port).
  return `${ID_PREFIX}-${randomUUID()}`;
}

export interface SupabaseProposalStoreOptions {
  readonly client: SupabaseClient;
  /** Injectable clock for deterministic tests. Defaults to ISO now. */
  readonly now?: () => string;
}

/**
 * Supabase-backed ProposalStore.
 *
 * store/get hit the `proposals` table. Commit/void go through SECURITY INVOKER
 * RPCs that bind identity via auth.uid() (RFC 0001 Phase 1). Business
 * rejections return {kind:"not_committable"}; any thrown exception collapses
 * to {kind:"error", cause}.
 *
 * Runs on whatever client the caller injects. The turn path injects a
 * session-scoped client (issue #62 / ADD §Multi-User).
 */
export function createSupabaseProposalStore(
  options: SupabaseProposalStoreOptions,
): ProposalStore {
  const { client } = options;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async store(params: ProposalInput): Promise<Proposal> {
      const id = generateProposalId();
      const ts = now();
      const row = { ...inputToRow(params, id, ts), status: "proposed" };

      const { data, error } = await client
        .from(TABLE)
        .insert(row)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to store proposal: ${error.message}`);
      }

      // Pass coverage through from input — not a DB column yet (no migration).
      return rowToProposal(
        data as ProposalDbRow,
        params.allergenCoverage ?? "reviewed",
      );
    },

    async get(id: string): Promise<Proposal | undefined> {
      const { data, error } = await client
        .from(TABLE)
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error) {
        throw new Error(`Failed to get proposal: ${error.message}`);
      }

      return data ? rowToProposal(data as ProposalDbRow) : undefined;
    },

    async commitProposalAndInsertMeal(
      proposalId: string,
    ): Promise<CommitResult> {
      try {
        const { data, error } = await client.rpc(
          "commit_proposal_and_insert_meal",
          { p_proposal_id: proposalId },
        );

        if (error) {
          return { kind: "error", cause: error.message };
        }

        return mapCommitResult(data);
      } catch (err: unknown) {
        return { kind: "error", cause: errorCause(err) };
      }
    },

    async voidProposal(proposalId: string): Promise<VoidResult> {
      try {
        const { data, error } = await client.rpc("void_proposal", {
          p_proposal_id: proposalId,
        });

        if (error) {
          return { kind: "error", cause: error.message };
        }

        return mapVoidResult(data);
      } catch (err: unknown) {
        return { kind: "error", cause: errorCause(err) };
      }
    },
  };
}
