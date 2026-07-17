-- Atomic commit + void RPCs (RFC 0001 Phase 1).
--
-- Business rejection is a normal jsonb return ({status:'not_committable'}).
-- raise is only for unauthenticated and true infrastructure / invariant
-- violations. Adapter does not parse exception messages for business outcomes.
--
-- meal_log_id serialized as JSON number; safe while id < 2^53 (identity column).

create or replace function public.commit_proposal_and_insert_meal(
  p_proposal_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prop public.proposals%rowtype;
  v_meal_id bigint;
  v_updated int;
begin
  -- raise ONLY for auth/infra/invariant. Business rejection is a normal return.
  if v_uid is null then
    raise exception 'unauthenticated';
  end if;

  select * into v_prop
  from public.proposals
  where id = p_proposal_id
    and user_id = v_uid
    and status = 'proposed'
  for update;

  if not found then
    -- missing / cross-tenant (RLS-invisible) / already committed or voided.
    -- Deliberately indistinguishable (§1.1). No writes have occurred.
    return jsonb_build_object('status', 'not_committable');
  end if;

  update public.proposals
  set status = 'committed'
  where id = v_prop.id and status = 'proposed';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    -- Impossible after FOR UPDATE held a proposed row in this transaction:
    -- lock/invariant bug, not a business rejection. Must not look like not_committable.
    raise exception 'invariant: locked proposal changed status';
  end if;

  insert into public.meal_logs (
    user_id,
    food_name,
    portion_g,
    meal_type,
    kcal,
    protein_g,
    fat_g,
    carbs_g,
    proposal_id,
    food_id,
    match_type,
    allergen_tags
  ) values (
    v_prop.user_id,
    v_prop.food_name,
    v_prop.portion_g,
    v_prop.meal_type,
    v_prop.kcal,
    v_prop.protein_g,
    v_prop.fat_g,
    v_prop.carbs_g,
    v_prop.id,
    v_prop.food_id,
    v_prop.match_type,
    v_prop.allergen_tags
  )
  returning id into v_meal_id;

  return jsonb_build_object(
    'status', 'committed',
    'proposal_id', v_prop.id,
    'meal_log_id', v_meal_id
  );
end;
$$;

revoke all on function public.commit_proposal_and_insert_meal(text) from public;
grant execute on function public.commit_proposal_and_insert_meal(text) to authenticated;

create or replace function public.void_proposal(
  p_proposal_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then
    raise exception 'unauthenticated';
  end if;

  -- Single UPDATE takes a row lock. row_count=0 is legitimate not_committable
  -- (missing / cross-tenant / already voided or committed, including races).
  update public.proposals
  set status = 'voided'
  where id = p_proposal_id
    and user_id = v_uid
    and status = 'proposed';

  get diagnostics v_count = row_count;

  if v_count = 0 then
    return jsonb_build_object('status', 'not_committable');
  end if;

  return jsonb_build_object(
    'status', 'voided',
    'proposal_id', p_proposal_id
  );
end;
$$;

revoke all on function public.void_proposal(text) from public;
grant execute on function public.void_proposal(text) to authenticated;
