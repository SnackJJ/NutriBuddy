-- Row-level security policies for user-scoped tables (issue #48 / ADD §Multi-User).
--
-- Defense in depth: application-level scoping (executor binds userId from the
-- authenticated session, never from model-fillable input) is the primary
-- isolation mechanism. RLS on each user-scoped table is a second layer that
-- makes cross-tenant reads return nothing by construction, even if the
-- application layer has a bug.
--
-- Each table uses a simple policy: the rows visible to a given authenticated
-- role are those where user_id matches the session's auth.uid().

-- ── proposals ─────────────────────────────────────────────────────────────

alter table public.proposals enable row level security;

create policy "Users can read their own proposals"
  on public.proposals
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own proposals"
  on public.proposals
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own proposals"
  on public.proposals
  for update
  using (auth.uid() = user_id);

-- ── meal_logs ─────────────────────────────────────────────────────────────

alter table public.meal_logs enable row level security;

create policy "Users can read their own meal logs"
  on public.meal_logs
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own meal logs"
  on public.meal_logs
  for insert
  with check (auth.uid() = user_id);

-- ── user_profile ──────────────────────────────────────────────────────────

alter table public.user_profile enable row level security;

create policy "Users can read their own profile"
  on public.user_profile
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own profile"
  on public.user_profile
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on public.user_profile
  for update
  using (auth.uid() = user_id);
