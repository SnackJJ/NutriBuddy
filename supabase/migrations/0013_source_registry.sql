-- 0013: Evidence layer — source registry + corpus sections (S4 / RFC 0011 §3.1).
--
-- The registry is the citation layer's ground truth: one row per *document
-- version*, one row per section, and nothing here supplies numbers, entities or
-- writes (ADR 0004). The runtime only reads it; the corpus arrives through
-- `scripts/ingest-sources.mts` with the service role.
--
-- Two shape decisions worth stating, because they differ from RFC 0011 §3.1's
-- sketch (the RFC is updated in the same change):
--
--   * `id` is `<slug>@<doc_version>`, not the bare slug, and the stable document
--     identity lives in `slug`. The RFC requires that a changed document's old
--     version be marked `superseded` rather than deleted — an old trace may cite
--     it — and with the slug as primary key there is nowhere for the old version
--     to live. Version-scoped ids make "superseded, never deleted" a row update
--     instead of a second history table.
--   * a partial unique index allows at most one `active` version per `slug`:
--     "two active versions of one document" is a state no reader should have to
--     disambiguate, so the database refuses to represent it.
--
-- RLS and grants follow RFC 0006 §7 as the trace tables do: revoke the defaults,
-- grant back exactly the read a session needs (active documents only), and make
-- the service role's access explicit so a scratch database behaves like
-- production.

-- ── tables ────────────────────────────────────────────────────────────────

create table public.sources (
  id              text primary key,          -- <slug>@<doc_version>
  slug            text not null,             -- stable document identity, e.g. ods-vitamind
  title           text not null,
  publisher       text not null,
  url             text not null,
  -- Filled per source; the determination and its evidence live in
  -- sources/README.md and are recorded per row rather than assumed here.
  license         text,
  doc_version     text not null,
  effective_date  date,
  status          text not null default 'active'
                    check (status in ('active', 'superseded', 'archived')),
  -- Lower is more authoritative; 1 = a federal health agency's professional
  -- guidance, 2 = the same agency's consumer-facing version.
  authority_level int  not null check (authority_level >= 1),
  content_hash    text not null,
  ingested_at     timestamptz not null default now()
);

create index sources_slug_idx on public.sources (slug, ingested_at desc);

create unique index sources_one_active_per_slug
  on public.sources (slug)
  where status = 'active';

create table public.source_sections (
  id           text primary key,             -- <source_id>#<section-path slug>
  source_id    text not null
                 references public.sources(id) on delete cascade,
  section_path text not null,                -- "Vitamin D / Sources of Vitamin D / Food"
  heading      text,
  ordinal      int  not null,                -- document order, for stable windows
  text         text not null,
  anchor       text,                         -- original URL anchor, so a reader can verify
  content_hash text not null,
  -- Whether this section is in V1.0's pinned evidence set. Kept as a column
  -- because the context assembly reads exactly this subset on every turn, and a
  -- separate table would be a second place for the set to be defined.
  pinned       boolean not null default false
);

create index source_sections_source_idx on public.source_sections (source_id, ordinal);
create index source_sections_pinned_idx on public.source_sections (pinned) where pinned;

-- ── read-only access for clients ──────────────────────────────────────────

alter table public.sources enable row level security;
alter table public.source_sections enable row level security;

-- Only active documents are readable. The corpus is public data, but a
-- superseded version is not something an answer should be allowed to cite, so it
-- is invisible rather than merely discouraged.
create policy "Signed-in users can read active sources"
  on public.sources for select
  to authenticated
  using (status = 'active');

-- Sections inherit their document's status through the subquery; the Supabase
-- guidance's `(select ...)` form is not applicable here (this is a correlated
-- existence check, not a function call), so the plan relies on
-- source_sections_source_idx and sources' primary key.
create policy "Signed-in users can read sections of active sources"
  on public.source_sections for select
  to authenticated
  using (
    exists (
      select 1 from public.sources s
       where s.id = source_sections.source_id
         and s.status = 'active'
    )
  );

revoke all on public.sources, public.source_sections from anon, authenticated;
grant select on public.sources, public.source_sections to authenticated;

-- Explicit rather than inherited from create-time default privileges: those are
-- absent in a scratch database rebuilt with `drop schema ... cascade`, which would
-- make the ingest script pass locally and fail in production (0011/0014 make the
-- same argument).
grant select, insert, update, delete
  on public.sources, public.source_sections
  to service_role;
