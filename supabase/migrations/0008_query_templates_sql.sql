-- 0008: Reviewed SQL for the query template catalog (issue #64 / ADD §Tools).
--
-- "Execution runs under a SELECT-only role on whitelisted views with
--  statement timeout, row cap, and single-statement rule."
--
-- Mechanism:
--   * nutribuddy_query_ro — a NOLOGIN role with SELECT on meal_logs only.
--   * One SECURITY DEFINER SQL function per meal template, OWNED BY the
--     read-only role: the function body executes with that role's
--     privileges, so writes are impossible even if a body were corrupted.
--   * The user id binds inside SQL via auth.uid() (from the caller's JWT)
--     — it is not a parameter, so neither the model nor the runner can
--     reference another user's rows. meal_logs RLS still applies on top
--     (the ro role does not own the table).
--   * statement_timeout is set per function; each body is one statement.
--   * Row cap: LIMIT 26 = MAX_OBSERVATION_ROWS (25, src/catalog/
--     queryCatalog.ts) + 1 — the runner detects the extra row, sets
--     truncated, and drops it. Single-row templates return one row.
--   * food_lookup is not here: it reads the in-process food catalog,
--     not Postgres.
--
-- Dates group by the UTC calendar day to match the in-memory runner
-- (dateKey = ISO timestamp's first 10 chars).

-- ── read-only executor role ────────────────────────────────────────────────

create role nutribuddy_query_ro nologin;
grant usage on schema public to nutribuddy_query_ro;
grant select on public.meal_logs to nutribuddy_query_ro;

-- ── meal_summary ───────────────────────────────────────────────────────────

create or replace function public.query_meal_summary(date_from date, date_to date)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'meal_type', meal_type,
    'meal_count', count(*),
    'total_kcal', round(sum(kcal)::numeric, 1),
    'total_protein_g', round(sum(protein_g)::numeric, 1),
    'total_fat_g', round(sum(fat_g)::numeric, 1),
    'total_carbs_g', round(sum(carbs_g)::numeric, 1)
  )
  from public.meal_logs
  where user_id = auth.uid()
    and (logged_at at time zone 'utc')::date between date_from and date_to
  group by meal_type
  order by meal_type
  limit 26;
$$;

-- ── daily_totals ───────────────────────────────────────────────────────────

create or replace function public.query_daily_totals(date_from date, date_to date)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'date', to_char((logged_at at time zone 'utc')::date, 'YYYY-MM-DD'),
    'total_kcal', round(sum(kcal)::numeric, 1),
    'total_protein_g', round(sum(protein_g)::numeric, 1),
    'total_fat_g', round(sum(fat_g)::numeric, 1),
    'total_carbs_g', round(sum(carbs_g)::numeric, 1),
    'meal_count', count(*)
  )
  from public.meal_logs
  where user_id = auth.uid()
    and (logged_at at time zone 'utc')::date between date_from and date_to
  group by (logged_at at time zone 'utc')::date
  order by (logged_at at time zone 'utc')::date
  limit 26;
$$;

-- ── weekly_totals (ISO weeks: date_trunc('week') is Monday-based) ──────────

create or replace function public.query_weekly_totals(date_from date, date_to date)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'week_start', to_char(date_trunc('week', (logged_at at time zone 'utc')::date)::date, 'YYYY-MM-DD'),
    'total_kcal', round(sum(kcal)::numeric, 1),
    'total_protein_g', round(sum(protein_g)::numeric, 1),
    'total_fat_g', round(sum(fat_g)::numeric, 1),
    'total_carbs_g', round(sum(carbs_g)::numeric, 1),
    'meal_count', count(*),
    'day_count', count(distinct (logged_at at time zone 'utc')::date)
  )
  from public.meal_logs
  where user_id = auth.uid()
    and (logged_at at time zone 'utc')::date between date_from and date_to
  group by date_trunc('week', (logged_at at time zone 'utc')::date)
  order by date_trunc('week', (logged_at at time zone 'utc')::date)
  limit 26;
$$;

-- ── daily_average (single row; total days is the denominator) ──────────────

create or replace function public.query_daily_average(date_from date, date_to date)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'avg_kcal', round((coalesce(sum(kcal), 0) / (date_to - date_from + 1))::numeric, 1),
    'avg_protein_g', round((coalesce(sum(protein_g), 0) / (date_to - date_from + 1))::numeric, 1),
    'avg_fat_g', round((coalesce(sum(fat_g), 0) / (date_to - date_from + 1))::numeric, 1),
    'avg_carbs_g', round((coalesce(sum(carbs_g), 0) / (date_to - date_from + 1))::numeric, 1),
    'days_with_meals', count(distinct (logged_at at time zone 'utc')::date),
    'total_days', (date_to - date_from + 1)
  )
  from public.meal_logs
  where user_id = auth.uid()
    and (logged_at at time zone 'utc')::date between date_from and date_to;
$$;

-- ── range_comparison (single row; diff computed server-side on raw avgs) ───

create or replace function public.query_range_comparison(
  range1_from date, range1_to date, range2_from date, range2_to date
)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  with r1 as (
    select
      coalesce(sum(kcal), 0) / (range1_to - range1_from + 1) as kcal,
      coalesce(sum(protein_g), 0) / (range1_to - range1_from + 1) as protein_g,
      coalesce(sum(fat_g), 0) / (range1_to - range1_from + 1) as fat_g,
      coalesce(sum(carbs_g), 0) / (range1_to - range1_from + 1) as carbs_g
    from public.meal_logs
    where user_id = auth.uid()
      and (logged_at at time zone 'utc')::date between range1_from and range1_to
  ),
  r2 as (
    select
      coalesce(sum(kcal), 0) / (range2_to - range2_from + 1) as kcal,
      coalesce(sum(protein_g), 0) / (range2_to - range2_from + 1) as protein_g,
      coalesce(sum(fat_g), 0) / (range2_to - range2_from + 1) as fat_g,
      coalesce(sum(carbs_g), 0) / (range2_to - range2_from + 1) as carbs_g
    from public.meal_logs
    where user_id = auth.uid()
      and (logged_at at time zone 'utc')::date between range2_from and range2_to
  )
  select jsonb_build_object(
    'range1_avg_kcal', round(r1.kcal::numeric, 1),
    'range1_avg_protein_g', round(r1.protein_g::numeric, 1),
    'range1_avg_fat_g', round(r1.fat_g::numeric, 1),
    'range1_avg_carbs_g', round(r1.carbs_g::numeric, 1),
    'range2_avg_kcal', round(r2.kcal::numeric, 1),
    'range2_avg_protein_g', round(r2.protein_g::numeric, 1),
    'range2_avg_fat_g', round(r2.fat_g::numeric, 1),
    'range2_avg_carbs_g', round(r2.carbs_g::numeric, 1),
    'diff_kcal', round((r2.kcal - r1.kcal)::numeric, 1),
    'diff_protein_g', round((r2.protein_g - r1.protein_g)::numeric, 1),
    'diff_fat_g', round((r2.fat_g - r1.fat_g)::numeric, 1),
    'diff_carbs_g', round((r2.carbs_g - r1.carbs_g)::numeric, 1),
    'range1_days', (range1_to - range1_from + 1),
    'range2_days', (range2_to - range2_from + 1)
  )
  from r1, r2;
$$;

-- ── top_k_by_nutrient (enum whitelisted in SQL; k hard-capped at 20) ───────

create or replace function public.query_top_k_by_nutrient(
  date_from date, date_to date, nutrient text, k integer
)
returns setof jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'rank', row_number() over (
      order by sum(
        case nutrient
          when 'kcal' then kcal
          when 'protein' then protein_g
          when 'fat' then fat_g
          when 'carbs' then carbs_g
        end
      ) desc
    ),
    'food_name', food_name,
    'total_kcal', round(sum(kcal)::numeric, 1),
    'total_protein_g', round(sum(protein_g)::numeric, 1),
    'total_fat_g', round(sum(fat_g)::numeric, 1),
    'total_carbs_g', round(sum(carbs_g)::numeric, 1),
    'total_portion_g', round(sum(portion_g)::numeric, 1),
    'meal_count', count(*)
  )
  from public.meal_logs
  where user_id = auth.uid()
    and nutrient in ('kcal', 'protein', 'fat', 'carbs')
    and (logged_at at time zone 'utc')::date between date_from and date_to
  group by food_name
  order by sum(
    case nutrient
      when 'kcal' then kcal
      when 'protein' then protein_g
      when 'fat' then fat_g
      when 'carbs' then carbs_g
    end
  ) desc
  limit greatest(least(k, 20), 0);
$$;

-- ── ownership + execution grants ───────────────────────────────────────────

alter function public.query_meal_summary(date, date) owner to nutribuddy_query_ro;
alter function public.query_daily_totals(date, date) owner to nutribuddy_query_ro;
alter function public.query_weekly_totals(date, date) owner to nutribuddy_query_ro;
alter function public.query_daily_average(date, date) owner to nutribuddy_query_ro;
alter function public.query_range_comparison(date, date, date, date) owner to nutribuddy_query_ro;
alter function public.query_top_k_by_nutrient(date, date, text, integer) owner to nutribuddy_query_ro;

revoke all on function public.query_meal_summary(date, date) from public, anon;
revoke all on function public.query_daily_totals(date, date) from public, anon;
revoke all on function public.query_weekly_totals(date, date) from public, anon;
revoke all on function public.query_daily_average(date, date) from public, anon;
revoke all on function public.query_range_comparison(date, date, date, date) from public, anon;
revoke all on function public.query_top_k_by_nutrient(date, date, text, integer) from public, anon;

grant execute on function public.query_meal_summary(date, date) to authenticated;
grant execute on function public.query_daily_totals(date, date) to authenticated;
grant execute on function public.query_weekly_totals(date, date) to authenticated;
grant execute on function public.query_daily_average(date, date) to authenticated;
grant execute on function public.query_range_comparison(date, date, date, date) to authenticated;
grant execute on function public.query_top_k_by_nutrient(date, date, text, integer) to authenticated;
