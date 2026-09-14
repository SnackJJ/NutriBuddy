#!/usr/bin/env bash
#
# D2: prove the migrations replay from an empty database (RFC 0007 §2 D2,
# RFC 0008 §4, issue #123).
#
# Why the Supabase local stack and not plain Postgres: 0005's policies call
# auth.uid() and 0011's foreign key references auth.users, so a vanilla Postgres
# would fail at 0005 and tell us nothing about the real environment.
#
# Why a reset rather than idempotency guards: 0005's `create policy` and 0011's
# `create table` are only replayable on an *empty* database. `supabase db reset`
# recreates the database and re-applies `supabase/migrations/*.sql` in filename
# order, stopping at the first failure — which is the property under test.
#
# Deliberately NOT used: `drop schema public cascade`. It would take Supabase's
# default privileges on the schema with it, turning the `revoke` statements in
# 0005/0011 into no-ops and letting the grant assertions below pass vacuously —
# in an environment that no longer resembles production.
#
# Prerequisites: Docker, the pinned Supabase CLI (fetched by npx), and `psql`
# on PATH. `--local` is passed to the reset so an exported SUPABASE_DB_URL or a
# linked project cannot redirect it at a hosted database.
#
# Usage: bash scripts/verify-migrations.sh
#   SUPABASE_CLI  override the CLI command (default: a pinned npx invocation)

set -euo pipefail

cd "$(dirname "$0")/.."

SUPABASE_CLI="${SUPABASE_CLI:-npx --yes supabase@2.117.0}"

command -v psql >/dev/null 2>&1 || {
  echo "missing prerequisite: psql (postgresql-client)" >&2
  exit 2
}

# A scratch replay is local by definition. SCRATCH_DB is the name issue #123
# gives the target; SUPABASE_DB_URL is the one the CLI actually reads. Any other
# value is refused rather than silently ignored, so a stray export cannot turn
# this into a production reset.
for var in SCRATCH_DB SUPABASE_DB_URL; do
  value="${!var:-}"
  if [ -n "$value" ]; then
    case "$value" in
      *127.0.0.1*|*localhost*) ;;
      *)
        echo "refusing to run: \$$var does not point at the local stack" >&2
        echo "  \$$var=$value" >&2
        exit 2
        ;;
    esac
  fi
done

if [ ! -f supabase/config.toml ]; then
  echo "missing supabase/config.toml — run: supabase init" >&2
  exit 2
fi

# A stack that is already running is reset in place; otherwise it is started
# first (which also applies the migrations to a fresh database).
if ! $SUPABASE_CLI status >/dev/null 2>&1; then
  echo "==> starting the local stack"
  $SUPABASE_CLI start
else
  echo "==> local stack already running"
fi

echo "==> replaying supabase/migrations/*.sql on an empty database"
$SUPABASE_CLI db reset --local --no-seed

DB_URL="$($SUPABASE_CLI status -o env 2>/dev/null | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
if [ -z "$DB_URL" ]; then
  echo "could not read DB_URL from \`supabase status\`" >&2
  exit 1
fi

# Reset recreates the schema while PostgREST keeps its own cache, so anything
# that talks to the local API right afterwards — a smoke run, the app — sees
# PGRST202 "could not find the function" for objects that plainly exist. Tell
# PostgREST to reload; harmless when it is not running.
psql "$DB_URL" -q -c "notify pgrst, 'reload schema';" >/dev/null

# Reset exiting 0 would also be true if it applied nothing, and the CLI only
# warns about a file it skips for not matching `^[0-9]+_.*\.sql$`. So the end
# state is asserted against the files on disk, not just against "no error".
FILES=(supabase/migrations/*.sql)
EXPECTED_COUNT="${#FILES[@]}"
VERSIONS="$(printf '%s\n' "${FILES[@]}" | sed -E 's#.*/([0-9]+)_.*#\1#' | sort)"
VERSION_LIST="$(printf "'%s'," $VERSIONS | sed 's/,$//')"

# The stack's major version is part of the claim "local replay ≈ production"
# (config.toml says so itself), so it is asserted rather than assumed.
CONFIG_MAJOR_VERSION="$(sed -n 's/^major_version = \([0-9][0-9]*\)$/\1/p' supabase/config.toml | head -1)"
if [ -z "$CONFIG_MAJOR_VERSION" ]; then
  echo "could not read major_version from supabase/config.toml" >&2
  exit 1
fi

echo "==> asserting the migrated schema (${EXPECTED_COUNT} migrations)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -qtA <<SQL
do \$\$
declare
  applied  int;
  missing  text;
  unowned  text;
begin
  select count(*) into applied from supabase_migrations.schema_migrations;
  if applied <> ${EXPECTED_COUNT} then
    raise exception 'reset recorded % applied migrations, % files are on disk',
      applied, ${EXPECTED_COUNT};
  end if;

  select string_agg(v, ', ') into missing
    from unnest(array[${VERSION_LIST}]) as v
   where not exists (
     select 1 from supabase_migrations.schema_migrations m where m.version = v
   );
  if missing is not null then
    raise exception 'migrations on disk but never applied: %', missing;
  end if;

  select string_agg(name, ', ') into missing
    from (values ('user_profile'), ('meal_logs'), ('proposals'),
                 ('turns'), ('turn_events')) as expected(name)
   where not exists (
     select 1 from pg_tables
      where schemaname = 'public' and tablename = expected.name
   );
  if missing is not null then
    raise exception 'migrations did not create: %', missing;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'append_turn_event'
  ) then
    raise exception 'migration 0011 did not create append_turn_event';
  end if;

  -- 0008's premise: the SELECT-only executor actually owns the templates.
  select string_agg(p.proname, ', ') into unowned
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'query\_%'
     and p.proowner <> (select oid from pg_roles where rolname = 'nutribuddy_query_ro');
  if unowned is not null then
    raise exception '0008: not owned by nutribuddy_query_ro: %', unowned;
  end if;
  if has_schema_privilege('nutribuddy_query_ro', 'public', 'create') then
    raise exception '0008: nutribuddy_query_ro still holds CREATE on public';
  end if;

  -- 0011's premise: the trace surface is unreachable for a user-facing role.
  -- has_*_privilege, not information_schema: the latter only shows grants the
  -- querying role can see, so it can pass vacuously. update/delete matter as
  -- much as insert — they would let the subject of the audit rewrite it.
  if has_table_privilege('authenticated', 'public.turn_events',
                         'insert, update, delete, truncate, references, trigger')
     or has_table_privilege('authenticated', 'public.turns',
                            'insert, update, delete, truncate, references, trigger')
     or has_table_privilege('anon', 'public.turn_events',
                            'select, insert, update, delete')
     or has_function_privilege(
          'authenticated',
          'public.append_turn_event(uuid, uuid, jsonb, jsonb)',
          'execute'
        )
  then
    raise exception '0011: the trace surface is reachable by a user-facing role';
  end if;

  -- 0014's premise: the three tables that predate RFC 0006 §7 carry exactly the
  -- privileges the confirm path needs and none of the default grants. Both
  -- directions are asserted: a missing grant breaks confirm
  -- (npm run smoke:confirm is the live form of this), and a leftover default
  -- grant is the state this migration exists to end.
  if not has_table_privilege('authenticated', 'public.proposals',
                             'select, insert, update')
     or not has_table_privilege('authenticated', 'public.meal_logs',
                                'select, insert')
     or not has_table_privilege('authenticated', 'public.user_profile',
                                'select')
  then
    raise exception '0014: a grant the confirm path needs is missing';
  end if;

  -- has_table_privilege returns true only when *every* listed privilege is
  -- held, so the negatives are one call per privilege — a comma list here would
  -- pass while a single dangerous grant survived.
  if has_table_privilege('authenticated', 'public.proposals', 'delete')
     or has_table_privilege('authenticated', 'public.proposals', 'truncate')
     or has_table_privilege('authenticated', 'public.proposals', 'references')
     or has_table_privilege('authenticated', 'public.proposals', 'trigger')
     or has_table_privilege('authenticated', 'public.meal_logs', 'update')
     or has_table_privilege('authenticated', 'public.meal_logs', 'delete')
     or has_table_privilege('authenticated', 'public.meal_logs', 'truncate')
     or has_table_privilege('authenticated', 'public.meal_logs', 'references')
     or has_table_privilege('authenticated', 'public.meal_logs', 'trigger')
     or has_table_privilege('authenticated', 'public.user_profile', 'insert')
     or has_table_privilege('authenticated', 'public.user_profile', 'update')
     or has_table_privilege('authenticated', 'public.user_profile', 'delete')
     or has_table_privilege('authenticated', 'public.user_profile', 'truncate')
     or has_table_privilege('authenticated', 'public.user_profile', 'references')
     or has_table_privilege('authenticated', 'public.user_profile', 'trigger')
     or has_table_privilege('anon', 'public.proposals', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.meal_logs', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.user_profile', 'select, insert, update, delete')
  then
    raise exception '0014: a default grant survives on a legacy table';
  end if;

  -- The policy set is part of the claim: ALTER POLICY must rewrite the
  -- expressions without dropping a policy, so a count is asserted alongside the
  -- form (3 + 2 + 1 = 6, after 0007 dropped user_profile's write policies).
  select count(*) into applied from pg_policies
   where schemaname = 'public'
     and tablename in ('proposals', 'meal_logs', 'user_profile');
  if applied <> 6 then
    raise exception '0014: expected 6 policies on the legacy tables, found %',
      applied;
  end if;

  select string_agg(p.tablename || '.' || p.policyname, ', ') into missing
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename in ('proposals', 'meal_logs', 'user_profile')
     and coalesce(p.qual, p.with_check) !~* 'select\s+auth\.uid\(\)';
  if missing is not null then
    raise exception '0014: policy still calls auth.uid() per row: %', missing;
  end if;

  -- 0014 adds no index, which is only safe while the policy column is already
  -- covered. Asserting the property rather than the absence of a change is what
  -- makes that durable.
  select string_agg(t.tablename, ', ') into missing
    from (values ('proposals'), ('meal_logs'), ('user_profile'))
      as t(tablename)
   where not exists (
     select 1
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
      where n.nspname = 'public'
        and c.relname = t.tablename
        and a.attname = 'user_id'
   );
  if missing is not null then
    raise exception '0014: no index leads with the policy column on: %', missing;
  end if;

  -- 0013's premise: the evidence layer is public read-only data with no client
  -- write path, and only active documents are visible.
  if not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename in ('sources', 'source_sections')
     group by schemaname having count(*) = 2
  ) then
    raise exception '0013 did not create sources / source_sections';
  end if;

  if has_table_privilege('anon', 'public.sources', 'select, insert, update, delete')
     or has_table_privilege('anon', 'public.source_sections', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.sources', 'insert')
     or has_table_privilege('authenticated', 'public.sources', 'update')
     or has_table_privilege('authenticated', 'public.sources', 'delete')
     or has_table_privilege('authenticated', 'public.source_sections', 'insert')
     or has_table_privilege('authenticated', 'public.source_sections', 'update')
     or has_table_privilege('authenticated', 'public.source_sections', 'delete')
  then
    raise exception '0013: the evidence corpus is writable by a user-facing role';
  end if;

  if not has_table_privilege('authenticated', 'public.sources', 'select')
     or not has_table_privilege('authenticated', 'public.source_sections', 'select')
  then
    raise exception '0013: signed-in readers cannot read the evidence corpus';
  end if;

  -- "At most one active version per document" is the invariant that makes a
  -- superseded version unambiguous. Asserted because a schema without it still
  -- replays cleanly and only shows up as a wrong citation later.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'sources'
       and indexname = 'sources_one_active_per_slug'
  ) then
    raise exception '0013: the one-active-version-per-source index is missing';
  end if;

  -- The local stack's own version is the premise of everything above, and it is
  -- the one part of "local replay ≈ production" that config.toml states.
  if current_setting('server_version_num')::int / 10000
     <> ${CONFIG_MAJOR_VERSION}
  then
    raise exception 'local Postgres is %, but supabase/config.toml pins major version %',
      current_setting('server_version'), ${CONFIG_MAJOR_VERSION};
  end if;
end \$\$;
SQL

echo "==> ok: ${EXPECTED_COUNT} migrations replay from empty on Postgres $(psql "$DB_URL" -tAc 'show server_version')"
