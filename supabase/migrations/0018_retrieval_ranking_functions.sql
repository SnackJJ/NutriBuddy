-- 0018: Retrieval ranking primitives (V1.1 / RFC 0013 §4, issue #134).
--
-- Two functions, and deliberately no third one: each returns a *ranked list of
-- chunks* for one side of the hybrid search, and nothing here fuses them.
--
-- Fusion lives in TypeScript (`src/evidence/retrieval.ts`), which is a departure
-- from RFC 0013 §4's sketch of a CTE writing `1/(k + rank)`, and the reason is
-- that the reciprocal-rank rule then exists once instead of twice. The in-memory
-- retriever CI runs and the Postgres retriever production runs have to agree on
-- the order they return, and two implementations of one ranking rule is the way
-- that agreement silently stops being true.
--
-- What SQL has to do is rank: `ts_rank` and the `<=>` distance operator are the
-- only places those two orderings exist, and neither is expressible through
-- PostgREST's `order` parameter. Everything after that is arithmetic over two
-- short lists, which is cheaper to get right in the language that also owns the
-- tests.
--
-- Both functions are `stable` and invoker-rights, so the row level security on
-- `source_chunks` still decides what a signed-in caller can retrieve: a
-- superseded document's chunks stay invisible even through the retrieval path.

-- ── lexical side ──────────────────────────────────────────────────────────

create or replace function public.match_source_chunks_by_text(
  query_text text,
  match_count int default 20
)
returns table (
  chunk_id   text,
  section_id text,
  rank       int
)
language sql
stable
as $$
  select c.id,
         c.section_id,
         (row_number() over (
            order by ts_rank(c.tsv, websearch_to_tsquery('english', query_text)) desc, c.id
          ))::int
    from public.source_chunks c
   where query_text is not null
     and length(btrim(query_text)) > 0
     and c.tsv @@ websearch_to_tsquery('english', query_text)
   order by ts_rank(c.tsv, websearch_to_tsquery('english', query_text)) desc, c.id
   limit greatest(match_count, 0);
$$;

-- ── vector side ───────────────────────────────────────────────────────────

create or replace function public.match_source_chunks_by_embedding(
  query_embedding extensions.vector(384),
  match_count int default 20
)
returns table (
  chunk_id   text,
  section_id text,
  rank       int
)
language sql
stable
as $$
  select c.id,
         c.section_id,
         (row_number() over (order by c.embedding <=> query_embedding, c.id))::int
    from public.source_chunks c
   where query_embedding is not null
     and c.embedding is not null
   order by c.embedding <=> query_embedding, c.id
   limit greatest(match_count, 0);
$$;

-- ── read-only access for clients ──────────────────────────────────────────

-- A new function is executable by PUBLIC by default, which is how a helper
-- nobody meant to expose becomes an endpoint. Revoked first, then granted back
-- to the two roles that need it, so the grant is a decision rather than a
-- default (0013/0014 make the same argument for tables).
revoke all on function public.match_source_chunks_by_text(text, int) from public, anon;
revoke all on function public.match_source_chunks_by_embedding(extensions.vector, int) from public, anon;

grant execute on function public.match_source_chunks_by_text(text, int) to authenticated, service_role;
grant execute on function public.match_source_chunks_by_embedding(extensions.vector, int) to authenticated, service_role;
