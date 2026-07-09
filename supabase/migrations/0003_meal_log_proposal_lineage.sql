-- Meal ledger lineage for proposal-confirmed writes (issue #37 / ADD Phase 3).
--
-- Existing rows predate proposals, so they receive a deterministic legacy
-- marker before the column is made required for future inserts.

alter table public.meal_logs
  add column if not exists proposal_id text;

update public.meal_logs
set proposal_id = 'legacy:' || id::text
where proposal_id is null;

alter table public.meal_logs
  alter column proposal_id set not null;
