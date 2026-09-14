-- 0015: The drug-nutrient interaction rules become a table the repository builds.
--
-- Until now the pre/post-gate's hard-constraint data source existed only as a
-- table someone had created by hand somewhere: no migration created it, no seed
-- populated it, and `scripts/verify-migrations.sh` passed on an empty database
-- that did not contain it (issue #125). The route's store fails loud when the
-- table is missing, so in a replayed or freshly deployed database every request
-- carrying a medication would have failed before the gate could run — which is
-- the *louder* of the two failure modes, and still the wrong one for a safety
-- input.
--
-- The rules below are the set the repository already assumes: the eval fixture
-- (`src/eval/evalInteractions.ts`), the gate and safety-context tests, and the
-- proposal-safety checks. A test asserts this file and that fixture agree, so the
-- two cannot drift into measuring different products.
--
-- Shape notes:
--   * `drug_name` is stored normalised (lowercase, trimmed) because
--     `getInteractions` matches on that form; the store lowercases the profile's
--     entries, not the table's.
--   * `severity` is constrained to the three values the TS union allows, because
--     `high` is the level that blocks and a typo would silently demote a hard
--     rule to an advisory.
--   * `source` is NOT NULL: a rule nobody can attribute is a rule nobody can
--     audit, and this table is the authority for refusing an answer.
--
-- Access is read-only for clients (RFC 0006 §7): the corpus of rules is public
-- reference data, the runtime reads it through the session client, and writes
-- belong to migrations.

-- ── table ─────────────────────────────────────────────────────────────────

create table public.drug_nutrient_interactions (
  id            bigint generated always as identity primary key,
  drug_name     text not null,
  nutrient      text not null,
  food_examples text[] not null default '{}',
  severity      text not null check (severity in ('high', 'moderate', 'low')),
  source        text not null,
  /** Rule-set version, stamped so a trace names the rules it was judged against. */
  version       text not null default '2026-09',
  created_at    timestamptz not null default now(),
  -- One rule per (drug, nutrient): a duplicate would double the evidence lines in
  -- the pinned region and make the gate's reasons read twice.
  unique (drug_name, nutrient)
);

create index drug_nutrient_interactions_drug_idx
  on public.drug_nutrient_interactions (drug_name);

-- ── seed ──────────────────────────────────────────────────────────────────
--
-- Idempotent by `on conflict do update`: the rules are reference data, and
-- re-running the migration (or applying a corrected version of it) must converge
-- on the same table rather than fail on a duplicate key.

insert into public.drug_nutrient_interactions
  (drug_name, nutrient, food_examples, severity, source, version)
values
  ('warfarin', 'vitamin K', array['kale', 'spinach', 'broccoli'], 'high', 'NIH ODS', '2026-09'),
  ('warfarin', 'cranberry', array['cranberry juice'], 'moderate', 'MedlinePlus', '2026-09'),
  ('simvastatin', 'grapefruit', array['grapefruit', 'grapefruit juice'], 'high', 'FDA', '2026-09'),
  ('phenelzine', 'tyramine', array['aged cheese', 'soy sauce'], 'high', 'MedlinePlus', '2026-09'),
  ('maoie', 'tyramine', array['ham'], 'high', 'MedlinePlus', '2026-09'),
  ('spironolactone', 'potassium', array['banana', 'potato', 'salt substitutes'], 'high', 'MedlinePlus', '2026-09'),
  ('levothyroxine', 'calcium', array['milk', 'cheese', 'calcium supplements'], 'moderate', 'NIH ODS', '2026-09'),
  ('metformin', 'alcohol', array['beer', 'wine'], 'moderate', 'NIH ODS', '2026-09')
on conflict (drug_name, nutrient) do update
  set food_examples = excluded.food_examples,
      severity      = excluded.severity,
      source        = excluded.source,
      version       = excluded.version;

-- ── access ────────────────────────────────────────────────────────────────

alter table public.drug_nutrient_interactions enable row level security;

create policy "Signed-in users can read the interaction rules"
  on public.drug_nutrient_interactions for select
  to authenticated
  using (true);

revoke all on public.drug_nutrient_interactions from anon, authenticated;
grant select on public.drug_nutrient_interactions to authenticated;

grant select, insert, update, delete
  on public.drug_nutrient_interactions
  to service_role;
