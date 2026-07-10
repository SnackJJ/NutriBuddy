-- Meal ledger entity lineage (issue #59 / issue #44 AC3 / ADD §Memory).
--
-- ADD §Memory: "Meal ledger — append-only rows carrying food id, grams,
-- match type, source proposal id, timestamps." Rows copy the resolved
-- entity from the committed proposal: food id, match type, allergen tags.
-- Legacy rows predate the resolver path and keep nulls; new inserts always
-- provide the entity columns.

alter table public.meal_logs
  add column if not exists food_id text,
  add column if not exists match_type text,
  add column if not exists allergen_tags text[] not null default '{}';
