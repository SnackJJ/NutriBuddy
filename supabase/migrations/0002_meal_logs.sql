-- meal_logs：用户饮食记录（issue #14 / PRD v2 §3.1 ToolRegistry「log_meal」）。
--
-- 记录用户每一餐的食物名称、份量、餐别、时间戳，以及从 USDA 查询到的
-- 营养数据（kcal / 蛋白质 / 脂肪 / 碳水）。营养数据在写入时即固化，不追溯
-- 更新（USDA API 返回值可能随时间变化）。
--
-- 查询模式：按用户 + 日期范围查今日/历史饮食，供 CodeAct SQL 模板使用。

create table if not exists public.meal_logs (
  id            bigint primary key generated always as identity,
  user_id       uuid not null,
  food_name     text not null,
  portion_g     numeric not null check (portion_g > 0),
  meal_type     text not null default 'snack',
  logged_at     timestamptz not null default now(),
  kcal          numeric not null,
  protein_g     numeric not null,
  fat_g         numeric not null,
  carbs_g       numeric not null,
  created_at    timestamptz not null default now()
);

-- 按用户 + 记录时间倒序查询（如"今天的午餐"）。
create index if not exists meal_logs_user_logged_idx
  on public.meal_logs (user_id, logged_at desc);
