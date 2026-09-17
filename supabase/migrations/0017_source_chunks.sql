-- 0017: Retrieval index — chunk rows, lexical and vector columns (V1.1 / RFC 0013 §4, issue #133).
--
-- V1.0 deliberately built no full-text and no vector column ("V1.0 建了也没人查",
-- RFC 0011 §3). This migration adds both, and the chunk rows they index.
--
-- Shape decisions worth stating, because a reader will wonder about each:
--
--   * A chunk is a **retrieval** unit and never a citable one: `section_id` is
--     the citable identity and stays the only thing a citation may point at
--     (docs/adr/0005). Nothing here is referenced by `turn_events` or by the
--     citation gate.
--   * `heading_text` (the section path) and `text` (the body) are separate
--     columns rather than one pre-joined string, because the lexical side wants
--     the heading weighted above the body — `setweight` needs the two texts
--     apart, and a generated `tsvector` cannot be rebuilt later without them.
--     The same path prefix is what makes a section that opens with "This is a
--     fact sheet intended for health professionals…" retrievable at all.
--   * `tsv` is a generated column, so the lexical index cannot drift from the
--     text it indexes; the two-argument `to_tsvector` is the immutable form a
--     generated column requires.
--   * `embedding` is `extensions.vector(384)` — gte-small, self-hosted in
--     Supabase so no new vendor receives a user's question (docs/adr/0006). It
--     is nullable because the corpus side may be ingested before an embedding
--     pass has run; the vector index simply does not cover those rows.
--   * A bibliography never becomes a row here at all: exclusion happens at
--     ingest (RFC 0013 §3), so "the index has no bibliography" is a fact about
--     the data rather than a filter every query must remember.
--
-- RLS and grants follow 0013/0014 exactly: revoke the defaults, grant back the
-- read a signed-in session needs (sections of active documents), and make the
-- service role explicit so a scratch database behaves like production.

create extension if not exists vector with schema extensions;

create table public.source_chunks (
  id           text primary key,             -- <section_id>#c<ordinal>
  section_id   text not null
                 references public.source_sections(id) on delete cascade,
  -- Denormalised from the section: retrieval filters and re-checks a chunk's
  -- document without a join, and the cascade keeps the two in step.
  source_id    text not null
                 references public.sources(id) on delete cascade,
  ordinal      int  not null check (ordinal >= 1),   -- 1-based within the section
  heading_text text not null,                -- section path, e.g. "Vitamin D / Sources"
  text         text not null,                -- chunk body
  char_count   int  not null,
  content_hash text not null,
  embedding    extensions.vector(384),
  tsv          tsvector generated always as (
                 setweight(to_tsvector('english', heading_text), 'A') ||
                 setweight(to_tsvector('english', text), 'B')
               ) stored
);

create index source_chunks_section_idx on public.source_chunks (section_id, ordinal);
create index source_chunks_source_idx on public.source_chunks (source_id);
create index source_chunks_tsv_idx on public.source_chunks using gin (tsv);
-- Cosine distance: the corpus side normalises its vectors (ADR 0006), and
-- cosine is the metric that stays meaningful if a later model does not.
create index source_chunks_embedding_idx
  on public.source_chunks using hnsw (embedding extensions.vector_cosine_ops);

-- ── read-only access for clients ──────────────────────────────────────────

alter table public.source_chunks enable row level security;

-- Chunks inherit their document's status through the section they belong to,
-- the same way sections inherit it from `sources` in 0013: a superseded version
-- must not be retrievable, only uncitable.
create policy "Signed-in users can read chunks of active sources"
  on public.source_chunks for select
  to authenticated
  using (
    exists (
      select 1 from public.sources s
       where s.id = source_chunks.source_id
         and s.status = 'active'
    )
  );

revoke all on public.source_chunks from anon, authenticated;
grant select on public.source_chunks to authenticated;

grant select, insert, update, delete on public.source_chunks to service_role;
