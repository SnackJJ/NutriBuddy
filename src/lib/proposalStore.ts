// Supabase 提案存储实现（issue #48 / PRD v2 §3.1 / ADD §Multi-User）。
//
// 将 ProposalStore 端口接上 Supabase `proposals` 表。
// 沿用 harness/Supabase 既有约定：窄端口可注入，单测不触网。

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProposalStore,
  Proposal,
  ProposalInput,
  ProposalStatus,
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

function rowToProposal(row: ProposalDbRow): Proposal {
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
    allergen_tags: [...params.allergenTags],
    created_at: now,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────

const TABLE = "proposals";
const PROPOSED_STATUS = "proposed";
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
 * Stores immutable proposals in the `proposals` table. Status transitions
 * update only the status column; all nutrition data is frozen at creation.
 *
 * Uses the service-role client (bypasses RLS) because application-level
 * scoping via userId already enforces tenant isolation. RLS on the table
 * is defense-in-depth (see migration 0005).
 */
export function createSupabaseProposalStore(
  options: SupabaseProposalStoreOptions,
): ProposalStore {
  const { client } = options;
  const now = options.now ?? (() => new Date().toISOString());

  async function transitionStatus(
    id: string,
    status: Extract<ProposalStatus, "committed" | "voided">,
    action: "commit" | "decline",
  ): Promise<Proposal> {
    const { data, error } = await client
      .from(TABLE)
      .update({ status })
      .eq("id", id)
      .eq("status", PROPOSED_STATUS)
      .select()
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to ${action} proposal ${id}: ${error.message}`);
    }

    if (!data) {
      throw new Error(`Proposal ${id} not found or not in "proposed" status`);
    }

    return rowToProposal(data as ProposalDbRow);
  }

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

      return rowToProposal(data as ProposalDbRow);
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

    async commit(id: string): Promise<Proposal> {
      return transitionStatus(id, "committed", "commit");
    },

    async decline(id: string): Promise<Proposal> {
      return transitionStatus(id, "voided", "decline");
    },
  };
}
