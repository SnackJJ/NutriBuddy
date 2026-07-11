// Supabase 餐食存储实现（issue #14 / PRD v2 §3.1「ToolRegistry」）。
//
// 将 log_meal 工具的 MealLogStore 端口接上 Supabase `meal_logs` 表。
// 沿用 harness/Supabase 既有约定：窄端口可注入，单测不触网。

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MealLogStore,
  MealLogEntry,
  MealLogInsert,
} from "../harness/logMeal";
import type { MealRecord } from "../catalog/queryCatalog";

/** Postgres 表行形状（snake_case，与 supabase/migrations/0002_meal_logs.sql 对应）。 */
interface MealLogDbRow {
  readonly id: number;
  readonly user_id: string;
  readonly food_name: string;
  readonly portion_g: number;
  readonly meal_type: string;
  readonly logged_at: string;
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly proposal_id: string;
  readonly food_id: string | null;
  readonly match_type: string | null;
  readonly allergen_tags: string[] | null;
  readonly created_at: string;
}

function rowToEntry(row: MealLogDbRow): MealLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    foodName: row.food_name,
    portionG: row.portion_g,
    mealType: row.meal_type,
    loggedAt: row.logged_at,
    kcal: row.kcal,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    carbsG: row.carbs_g,
    proposalId: row.proposal_id,
    foodId: row.food_id ?? undefined,
    matchType: row.match_type ?? undefined,
    allergenTags: row.allergen_tags ?? undefined,
  };
}

const TABLE = "meal_logs";

/** 由 Supabase 客户端构造的餐食存储实现。失败时 fail loud。 */
export function createSupabaseMealLogStore(
  client: SupabaseClient,
): MealLogStore {
  return {
    async insert(params: MealLogInsert): Promise<MealLogEntry> {
      const { data, error } = await client
        .from(TABLE)
        .insert({
          user_id: params.userId,
          food_name: params.foodName,
          portion_g: params.portionG,
          meal_type: params.mealType,
          kcal: params.kcal,
          protein_g: params.proteinG,
          fat_g: params.fatG,
          carbs_g: params.carbsG,
          proposal_id: params.proposalId,
          food_id: params.foodId,
          match_type: params.matchType,
          allergen_tags: [...params.allergenTags],
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to insert meal log: ${error.message}`);
      }

      return rowToEntry(data as MealLogDbRow);
    },
  };
}

/**
 * Load a user's meal ledger rows as query-runner MealRecords (issue #55).
 *
 * Interim path: feeds the in-memory query runner per request until the
 * SQL executor (#64) runs templates directly against Postgres.
 */
export async function listUserMealRecords(
  client: SupabaseClient,
  userId: string,
): Promise<MealRecord[]> {
  const { data, error } = await client
    .from(TABLE)
    .select("*")
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to list meal logs: ${error.message}`);
  }

  return ((data ?? []) as MealLogDbRow[]).map((row) => ({
    userId: row.user_id,
    foodName: row.food_name,
    portionG: row.portion_g,
    mealType: row.meal_type,
    loggedAt: row.logged_at,
    kcal: row.kcal,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    carbsG: row.carbs_g,
  }));
}
