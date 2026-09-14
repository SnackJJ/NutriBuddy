-- 0016: Deleting an account actually deletes the account's data.
--
-- The three tables that predate the trace work (`user_profile` from 0001,
-- `meal_logs` from 0002, `proposals` from 0004) never had a foreign key to
-- `auth.users`. Their `user_id` columns are plain `uuid not null`, so
-- `auth.admin.deleteUser` removed the login and left every row behind —
-- including `user_profile.medications`, which is the most sensitive thing the
-- product stores. A "delete my account" that leaves the health data in place is
-- worse than no button at all, because it is believed.
--
-- The fix is the constraint the schema should have had from the start:
-- `on delete cascade`, so the database enforces the relationship rather than a
-- deletion routine remembering to.
--
-- Orphans first: a user created and deleted before this migration would have left
-- rows that the new constraint would reject. They are reported before they are
-- removed, because a migration that silently deletes rows is a migration nobody
-- can audit afterwards — `raise notice` puts the count in the replay log.
--
-- `meal_logs.proposal_id` stays a plain text pointer: it is a lineage label, not
-- a relationship the database should enforce (a meal can outlive the proposal
-- record's own lifecycle rules, and 0003 depends on that).
--
-- Note on numbering: issue #121 called this "0015". 0015 became the interaction
-- rules (issue #125) while this was in flight, so the deletion cascade is 0016.

do $$
declare
  orphan_proposals    int;
  orphan_meal_logs    int;
  orphan_user_profile int;
begin
  select count(*) into orphan_proposals
    from public.proposals p
   where not exists (select 1 from auth.users u where u.id = p.user_id);

  select count(*) into orphan_meal_logs
    from public.meal_logs m
   where not exists (select 1 from auth.users u where u.id = m.user_id);

  select count(*) into orphan_user_profile
    from public.user_profile x
   where not exists (select 1 from auth.users u where u.id = x.user_id);

  if orphan_proposals + orphan_meal_logs + orphan_user_profile > 0 then
    raise notice '0016: removing orphan rows before adding the cascade — proposals=%, meal_logs=%, user_profile=%',
      orphan_proposals, orphan_meal_logs, orphan_user_profile;

    delete from public.proposals p
     where not exists (select 1 from auth.users u where u.id = p.user_id);
    delete from public.meal_logs m
     where not exists (select 1 from auth.users u where u.id = m.user_id);
    delete from public.user_profile x
     where not exists (select 1 from auth.users u where u.id = x.user_id);
  end if;
end $$;

alter table public.proposals
  add constraint proposals_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.meal_logs
  add constraint meal_logs_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.user_profile
  add constraint user_profile_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
