-- Proposal TTL (RFC 0004 §6.3 hybrid stale).
-- Backend commit authority: proposals older than 30 minutes cannot commit.
-- Client may pre-label stale from createdAt; clock skew always defers to this path.

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
    return jsonb_build_object('status', 'not_committable');
  end if;

  -- TTL: 30 minutes from created_at
  if v_prop.created_at < (now() - interval '30 minutes') then
    update public.proposals
    set status = 'expired'
    where id = v_prop.id and status = 'proposed';
    return jsonb_build_object(
      'status', 'not_committable',
      'reason', 'expired'
    );
  end if;

  update public.proposals
  set status = 'committed'
  where id = v_prop.id and status = 'proposed';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
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
