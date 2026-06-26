-- user_profile：用户基础档案（issue #8 / PRD §2.3 MemoryStore、§3.1 个人数据）。
--
-- append-only 版本化：每次更新「关闭旧行（valid_to = now）+ 追加新行
-- （valid_to = null）」，旧值作为历史行保留。当前有效值 = valid_to IS NULL
-- 的唯一行，确定性查询取（不靠 LLM）。
--
-- 双时态：M1 实现 transaction-time 轴（valid_from/valid_to 版本区间）+ 记录时间
-- （created_at/updated_at）。valid-time（事实生效区间）留到 M2。

create table if not exists public.user_profile (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  -- 过敏原 / 用药为 array 字段
  allergies        text[] not null default '{}',
  medications      text[] not null default '{}',
  goal_type        text,
  protein_target_g numeric,
  kcal_target      numeric,
  fat_target_g     numeric,
  carbs_target_g   numeric,
  height_cm        numeric,
  weight_kg        numeric,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 系统时间版本区间；当前有效行 valid_to 为 null
  valid_from       timestamptz not null default now(),
  valid_to         timestamptz
);

-- 每个 user 至多一行「当前有效」(valid_to is null)：
-- 确定性当前查询（maybeSingle）的唯一性保证。
create unique index if not exists user_profile_current_uq
  on public.user_profile (user_id)
  where valid_to is null;

-- 当前 / 历史查询走 (user_id, valid_to)。
create index if not exists user_profile_user_idx
  on public.user_profile (user_id, valid_to);
