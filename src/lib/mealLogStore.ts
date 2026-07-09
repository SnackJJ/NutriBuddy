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
