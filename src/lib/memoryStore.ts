// ② MemoryStore（profile 层）：用户基础档案的读写（issue #8 / PRD §2.3、§3.1）。
//
// 设计要点：
//   - append-only 版本化。每次 updateProfile 不就地改写，而是「关闭旧行
//     （valid_to = now）+ 追加新行（valid_to = null）」，旧值作为历史行保留。
//   - 当前有效值 = valid_to IS NULL 的唯一行，确定性查询取（不靠 LLM）。
//   - 过敏原 / 用药为 array 字段。
//   - 沿 harness 既有 DI 约定：IO（Supabase）抽成窄 ProfileGateway 端口，
//     合并 / 历史保留逻辑在 store 内可纯测；时钟可注入便于确定性断言。
//
// 双时态说明：M1 实现 transaction-time 轴（valid_from/valid_to 版本区间）
// + 记录时间（created_at/updated_at）。valid-time（事实生效区间）留到 M2。

import type { SupabaseClient } from "@supabase/supabase-js";

/** 用户档案的领域视图（camelCase）。当前有效值。 */
export interface UserProfile {
  readonly userId: string;
  readonly allergies: readonly string[];
  readonly medications: readonly string[];
  readonly goalType: string | null;
  readonly proteinTargetG: number | null;
  readonly kcalTarget: number | null;
  readonly fatTargetG: number | null;
  readonly carbsTargetG: number | null;
  readonly heightCm: number | null;
  readonly weightKg: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 可更新字段：userId / 时间戳由 store 管理，不接受外部 patch。 */
export type ProfilePatch = Partial<
  Omit<UserProfile, "userId" | "createdAt" | "updatedAt">
>;

/** 版本化行：在领域视图上加系统时间区间。当前有效行 validTo === null。 */
export interface ProfileRow extends UserProfile {
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** Postgres 表行形状（snake_case），与 supabase/migrations 对应。 */
export interface ProfileDbRow {
  readonly user_id: string;
  readonly allergies: string[];
  readonly medications: string[];
  readonly goal_type: string | null;
  readonly protein_target_g: number | null;
  readonly kcal_target: number | null;
  readonly fat_target_g: number | null;
  readonly carbs_target_g: number | null;
  readonly height_cm: number | null;
  readonly weight_kg: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
}

export function profileToRow(row: ProfileRow): ProfileDbRow {
  return {
    user_id: row.userId,
    allergies: [...row.allergies],
    medications: [...row.medications],
    goal_type: row.goalType,
    protein_target_g: row.proteinTargetG,
    kcal_target: row.kcalTarget,
    fat_target_g: row.fatTargetG,
    carbs_target_g: row.carbsTargetG,
    height_cm: row.heightCm,
    weight_kg: row.weightKg,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    valid_from: row.validFrom,
    valid_to: row.validTo,
  };
}

export function rowToProfile(db: ProfileDbRow): ProfileRow {
  return {
    userId: db.user_id,
    allergies: db.allergies ?? [],
    medications: db.medications ?? [],
    goalType: db.goal_type,
    proteinTargetG: db.protein_target_g,
    kcalTarget: db.kcal_target,
    fatTargetG: db.fat_target_g,
    carbsTargetG: db.carbs_target_g,
    heightCm: db.height_cm,
    weightKg: db.weight_kg,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    validFrom: db.valid_from,
    validTo: db.valid_to,
  };
}

/**
 * Store 依赖的窄 IO 端口：把 append-only 版本化拆成三步原子操作。
 * 真实实现见 createSupabaseProfileGateway；单测注入内存实现。
 */
export interface ProfileGateway {
  /** 当前有效行（valid_to IS NULL），无则 null。确定性查询。 */
  current(userId: string): Promise<ProfileRow | null>;
  /** 关闭旧版本：把当前行 valid_to 置为 validTo。 */
  close(userId: string, validTo: string): Promise<void>;
  /** 追加新版本行（valid_to = null）。 */
  append(row: ProfileRow): Promise<ProfileRow>;
}

export interface MemoryStoreOptions {
  readonly gateway: ProfileGateway;
  /** 注入时钟（测试用）；默认 ISO now。 */
  readonly now?: () => string;
}

export interface MemoryStore {
  getProfile(userId: string): Promise<UserProfile | null>;
  updateProfile(userId: string, patch: ProfilePatch): Promise<UserProfile>;
}

function emptyBaseline(userId: string, ts: string): ProfileRow {
  return {
    userId,
    allergies: [],
    medications: [],
    goalType: null,
    proteinTargetG: null,
    kcalTarget: null,
    fatTargetG: null,
    carbsTargetG: null,
    heightCm: null,
    weightKg: null,
    createdAt: ts,
    updatedAt: ts,
    validFrom: ts,
    validTo: null,
  };
}

/** 去掉版本字段，只暴露领域视图。 */
function toProfile(row: ProfileRow): UserProfile {
  const { validFrom: _vf, validTo: _vt, ...profile } = row;
  return profile;
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const { gateway } = options;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async getProfile(userId) {
      const row = await gateway.current(userId);
      return row ? toProfile(row) : null;
    },

    async updateProfile(userId, patch) {
      const ts = now();
      const existing = await gateway.current(userId);
      const base = existing ?? emptyBaseline(userId, ts);

      const next: ProfileRow = {
        ...base,
        ...patch,
        userId,
        createdAt: base.createdAt,
        updatedAt: ts,
        validFrom: ts,
        validTo: null,
      };

      // 先关闭旧版本，再追加新行：旧值作为历史行留存。
      if (existing) {
        await gateway.close(userId, ts);
      }
      const saved = await gateway.append(next);
      return toProfile(saved);
    },
  };
}

const TABLE = "user_profile";

/** Supabase 实现的 ProfileGateway：确定性 SQL，无语义检索。 */
export function createSupabaseProfileGateway(
  client: SupabaseClient,
): ProfileGateway {
  return {
    async current(userId) {
      const { data, error } = await client
        .from(TABLE)
        .select("*")
        .eq("user_id", userId)
        .is("valid_to", null)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToProfile(data as ProfileDbRow) : null;
    },

    async close(userId, validTo) {
      const { error } = await client
        .from(TABLE)
        .update({ valid_to: validTo })
        .eq("user_id", userId)
        .is("valid_to", null);
      if (error) throw error;
    },

    async append(row) {
      const { data, error } = await client
        .from(TABLE)
        .insert(profileToRow(row))
        .select()
        .single();
      if (error) throw error;
      return rowToProfile(data as ProfileDbRow);
    },
  };
}
