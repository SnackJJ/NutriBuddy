-- 0011: Turn trace persistence — turns / turn_events + append RPC (S1 / RFC 0008).
--
-- "Trajectory is not a debug log; it is a training-data asset" (CONTEXT.md).
-- The authoritative trace is the schema-versioned AnyTurnEvent stream; this
-- migration is where it lands. See docs/rfc/0008-trace-persistence-and-replay.md.
--
-- Mechanism:
--   * turns        — one row per turn: identity, versions, terminal state, and
--                    the cost / latency summary that S2 and S3 read directly.
--   * turn_events  — append-only row per event. `payload` is the COMPLETE
--                    AnyTurnEvent (schema / seq / timestamp included), so
--                    `select payload` is the replay row and the equivalence
--                    test needs no reassembly.
--   * append_turn_event(...) — one RPC, three branches. turn_start creates the
--                    turns row; turn_end inserts the event and finalizes the
--                    row (finished_at, stop_reason, steps, cost, latency) in the
--                    SAME statement, so no state exists where a turn_end event
--                    is persisted but the turn still looks "running".
--   * cost_usd aggregates model_call events in SQL (including regenerate
--     attempts); latency_ms is the turn_start -> turn_end timestamp delta. The
--     TypeScript side never keeps a second aggregate (RFC 0008 §3.4).
--
-- Write authority (RFC 0008 §3.3, migration 0007 precedent):
--   Trace rows are an audit surface, so the writing subject must not be able to
--   rewrite them. Migration 0005 granted authenticated insert/update on
--   user_profile and a browser client wrote constraints directly; 0007 closed
--   that door and made the service-role profile API the sole write path.
--   Same door here: client roles may READ their own rows (RLS policy below) and
--   get NO insert/update/delete grant at all.
--
--   note: user_id on turn_events is denormalized for a single-column RLS policy
--   and for prune; the cascade chain is auth.users -> turns -> turn_events.
--
-- RLS note: `(select auth.uid())` is wrapped so the planner caches it as an
-- initPlan instead of re-evaluating per row (Supabase RLS performance guidance).

-- ── tables ────────────────────────────────────────────────────────────────

create table public.turns (
  id              uuid primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- V1.0 keeps no session concept: this column stays null (RFC 0008 §12.1).
  session_id      text,
  input_kind      text not null,
  app_version     text,
  catalog_version text,
  source_version  text,
  schema_version  text not null,
  skill_id        text,
  skill_version   text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  stop_reason     text,
  steps           int,
  cost_usd        numeric(10,6),
  latency_ms      int,
  persist_error   text
);

create table public.turn_events (
  turn_id        uuid not null references public.turns(id) on delete cascade,
  user_id        uuid not null,
  seq            int  not null,
  schema_version text not null,
  type           text not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  primary key (turn_id, seq)
);

-- The primary key already provides the (turn_id, seq) index the replay path
-- needs; no second index on the same columns.
create index turns_user_time_idx on public.turns (user_id, started_at desc);

-- ── read-only access for clients ──────────────────────────────────────────

alter table public.turns enable row level security;
alter table public.turn_events enable row level security;

create policy "Users can read their own turns"
  on public.turns for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read their own turn events"
  on public.turn_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Policies and grants are two separate checks: opening RLS does not revoke the
-- default grant that Supabase puts on new tables. Revoke first, then grant back
-- exactly one privilege. service_role is deliberately untouched — it keeps the
-- full grant and bypasses RLS, which is what the turn path writes through.
revoke all on public.turns, public.turn_events from anon, authenticated;
grant select on public.turns, public.turn_events to authenticated;

-- service_role's write access is made explicit here instead of relying on the
-- default privileges Supabase attaches when a table is created: those defaults
-- are absent in a scratch database rebuilt from `drop schema ... cascade`, which
-- would make the RPC fail there and pass in production (a misleading test).
-- Both the RPC (security invoker) and the best-effort `persist_error` update run
-- as service_role.
grant select, insert, update, delete on public.turns, public.turn_events
  to service_role;

-- ── write path: one RPC, three branches ───────────────────────────────────

create or replace function public.append_turn_event(
  p_turn_id uuid,
  p_user_id uuid,
  p_event   jsonb,
  p_meta    jsonb default '{}'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_type   text := p_event->>'type';
  v_seq    int  := nullif(p_event->>'seq', '')::int;
  -- No silent fallbacks here: every AnyTurnEvent carries schema and timestamp
  -- (they are required in turn.ts), so a missing one is a bug and must surface
  -- as 22P02 — the same classification the store applies to malformed payloads
  -- (RFC 0008 §3.7). A fabricated 'unknown' schema would also poison replay and
  -- golden comparison, and `now()` would produce a plausible-but-wrong latency.
  v_schema text := nullif(p_event->>'schema', '');
  v_ts     timestamptz := nullif(p_event->>'timestamp', '')::timestamptz;
  v_owner  uuid;
  v_result jsonb;
begin
  if v_type is null or v_seq is null or v_schema is null or v_ts is null then
    raise exception 'append_turn_event: event lacks type/seq/schema/timestamp'
      using errcode = '22P02';
  end if;

  if v_type = 'turn_start' then
    -- seq 0 is the stream's first event by construction; anything else means the
    -- caller is assembling a turn wrongly.
    if v_seq <> 0 then
      raise exception 'append_turn_event: turn_start must have seq 0, got %', v_seq
        using errcode = '22P02';
    end if;

    if p_event->'input'->>'tag' is null then
      raise exception 'append_turn_event: turn_start lacks input.tag'
        using errcode = '22P02';
    end if;

    -- Metadata that is not part of the event travels in p_meta; without it
    -- app_version / source_version / skill_* could never be filled.
    insert into public.turns (
      id, user_id, session_id, input_kind, app_version, catalog_version,
      source_version, schema_version, skill_id, skill_version, started_at
    ) values (
      p_turn_id,
      p_user_id,
      null,
      p_event->'input'->>'tag',
      p_meta->>'appVersion',
      p_event->>'catalogVersion',
      p_meta->>'sourceVersion',
      v_schema,
      p_meta->>'skillId',
      p_meta->>'skillVersion',
      v_ts
    )
    on conflict (id) do nothing;
  end if;

  -- The turn row is the ONLY source of the owner, for every branch. On a
  -- turn_start retry the row already exists, so reading it back (rather than
  -- trusting p_user_id) is what makes "an event visible to A inside a turn that
  -- belongs to B" impossible at the DDL level instead of by caller convention.
  select t.user_id into v_owner from public.turns t where t.id = p_turn_id;

  if v_owner is null then
    raise exception 'append_turn_event: unknown turn %', p_turn_id
      using errcode = '23503';
  end if;

  if v_type = 'turn_start' and v_owner <> p_user_id then
    raise exception 'append_turn_event: turn % belongs to another user', p_turn_id
      using errcode = '23514';
  end if;

  insert into public.turn_events (turn_id, user_id, seq, schema_version, type, payload)
  values (p_turn_id, v_owner, v_seq, v_schema, v_type, p_event)
  on conflict (turn_id, seq) do nothing;

  -- A retry after a lost response re-sends the same bytes and lands here as a
  -- no-op. The same seq carrying DIFFERENT bytes is not a retry — it means the
  -- assembly layer reused a turn id or a seq — and silently keeping the first
  -- copy is the hardest version of that bug to diagnose.
  if not found and exists (
    select 1 from public.turn_events e
     where e.turn_id = p_turn_id and e.seq = v_seq and e.payload <> p_event
  ) then
    raise exception 'append_turn_event: seq % already stored with a different payload', v_seq
      using errcode = '23514';
  end if;

  if v_type = 'turn_end' then
    v_result := p_event->'result';

    update public.turns t
       set finished_at = v_ts,
           stop_reason = v_result->>'stopReason',
           steps       = nullif(v_result->>'steps', '')::int,
           cost_usd    = (
             select coalesce(sum((e.payload->>'costUsd')::numeric), 0)
               from public.turn_events e
              where e.turn_id = p_turn_id
                and e.type = 'model_call'
                and e.payload->>'costUsd' is not null
           ),
           latency_ms  = (
             select round(
                      extract(epoch from
                        (v_ts - min((e.payload->>'timestamp')::timestamptz)
                      )) * 1000
                    )::int
               from public.turn_events e
              where e.turn_id = p_turn_id
                and e.type = 'turn_start'
           )
     where t.id = p_turn_id;
  end if;
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default and PostgREST
-- exposes it, so leaving that in place would reopen the door this migration
-- just closed — a signed-in client could call the RPC instead of the tables.
-- The body runs with the caller's privileges (security invoker), so the
-- service role is what makes the writes legal.
revoke all on function public.append_turn_event(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.append_turn_event(uuid, uuid, jsonb, jsonb)
  to service_role;
