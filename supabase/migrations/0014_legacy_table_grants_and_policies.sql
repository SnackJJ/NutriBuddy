-- 0014: Close the default grants on the three tables that predate the practice,
--       and write their policies in the cached form (S1 / #120 / RFC 0006 §7).
--
-- What was wrong: RFC 0006 §7's production practice — revoke the default grant,
-- grant back exactly what the runtime needs, write policies as
-- `(select auth.uid())` — was applied to the new tables only. `proposals`,
-- `meal_logs` and `user_profile` (migration 0005) still carried Supabase's
-- default grant to `anon` and `authenticated`: insert, update, delete, truncate,
-- references, trigger on all three. RLS decided *which rows*, so no tenant
-- boundary was open, but the privilege layer said "these operations are yours"
-- about tables where most of them must not be.
--
-- The grant list below is exact, and it is exact because the confirm path is
-- what breaks if it is not (issue #120). All three callers of these tables:
--   * `src/lib/proposalStore.ts` — a session-scoped client does
--     `insert into proposals ... returning *` and `select ... from proposals`,
--     so it needs INSERT + SELECT on proposals;
--   * `commit_proposal_and_insert_meal` and `void_proposal` are **security
--     invoker** (0009/0010): they run with the caller's privileges, so the
--     session user needs SELECT + UPDATE on proposals (SELECT because
--     `select ... for update` takes the row lock) and INSERT on meal_logs;
--   * `user_profile` writes go through the validated profile API with the
--     service role — 0007 dropped its write policies on purpose, so its
--     `authenticated` grant is SELECT and nothing else.
--
-- `npm run smoke:confirm` is the only test in the repository that runs against
-- real grants (the unit tests inject a fake client), which is why it is the
-- acceptance for this file.

-- ── grants: revoke the defaults, grant back the list above ────────────────

revoke all on public.proposals, public.meal_logs, public.user_profile
  from anon, authenticated;

grant select, insert, update on public.proposals to authenticated;
grant select, insert on public.meal_logs to authenticated;
grant select on public.user_profile to authenticated;

-- service_role keeps full access, made explicit rather than inherited from the
-- default privileges Supabase attaches at create time: those are absent in a
-- scratch database rebuilt with `drop schema ... cascade`, which would make the
-- smoke pass locally and the same call fail in production (0011 makes the same
-- argument for the trace tables).
grant select, insert, update, delete
  on public.proposals, public.meal_logs, public.user_profile
  to service_role;

-- No index is added here: the policy column of each table is already the
-- leading column of an existing index — proposals_user_created_idx (user_id,
-- created_at desc), meal_logs_user_logged_idx (user_id, logged_at desc),
-- user_profile_current_uq / user_profile_user_idx (user_id, ...). A second index
-- on the same leading column would only cost writes. scripts/verify-migrations.sh
-- asserts that coverage, so it cannot quietly stop being true.

-- ── policies: same expressions, cached form ───────────────────────────────
--
-- `auth.uid()` unwrapped is evaluated once per row; wrapped in a subquery it is
-- an initPlan evaluated once per statement (Supabase's RLS performance
-- guidance), which is what 0011's policies already do. `alter policy` rather
-- than drop + create: the expressions are the only thing changing, and a
-- drop that fails halfway would leave the table with no policy at all.

alter policy "Users can read their own proposals" on public.proposals
  using ((select auth.uid()) = user_id);

alter policy "Users can insert their own proposals" on public.proposals
  with check ((select auth.uid()) = user_id);

-- An UPDATE policy with no WITH CHECK falls back to USING, so leaving it out
-- preserves the current semantics exactly (0005 wrote USING only).
alter policy "Users can update their own proposals" on public.proposals
  using ((select auth.uid()) = user_id);

alter policy "Users can read their own meal logs" on public.meal_logs
  using ((select auth.uid()) = user_id);

alter policy "Users can insert their own meal logs" on public.meal_logs
  with check ((select auth.uid()) = user_id);

-- user_profile has a SELECT policy only; 0007 dropped the insert and update
-- policies and pointed writes at the validated profile API.
alter policy "Users can read their own profile" on public.user_profile
  using ((select auth.uid()) = user_id);
