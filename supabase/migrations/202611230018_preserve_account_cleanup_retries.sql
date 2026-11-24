create or replace function public.sp_account_decide(
  actor_id uuid,
  uid uuid,
  choice text,
  factory uuid,
  note text
) returns text
language plpgsql security definer set search_path=public as $$
declare p account_profiles; next_status text;
begin
  perform 1 from account_profiles
    where id=actor_id and role='admin' and status='active' for share;
  if not found then
    raise exception 'Administrator access required' using errcode='PT403';
  end if;

  select * into p from account_profiles where id=uid for update;
  if found and p.id_card_path is not null and (
      (choice='approve' and p.status='active' and p.factory_id=factory)
      or (choice='reject' and p.status='rejected')
      or (choice='deactivate' and p.status='deactivated')
  ) then
    return p.id_card_path;
  end if;
  if not found or p.role not in ('reviewer','factory_manager') then
    raise exception 'Account unavailable' using errcode='PT404';
  end if;

  if choice='approve' and p.role='factory_manager' and p.status='pending_approval' then
    perform 1 from factories f where f.id=sp_account_decide.factory for update;
    if not found then
      raise exception 'Choose an existing factory' using errcode='PT422';
    end if;
    next_status:='active';
  elsif choice='reject' and p.role='factory_manager' and p.status='pending_approval'
      and coalesce(length(trim(note)),0)>0 then
    next_status:='rejected';
  elsif choice='deactivate' and p.status in ('active','pending') then
    next_status:='deactivated';
  elsif choice='reactivate' and p.status='deactivated'
      and (p.role='reviewer' or p.factory_id is not null) then
    next_status:='active';
  else
    raise exception 'This account cannot make that transition' using errcode='PT409';
  end if;

  update account_profiles set status=next_status,
    factory_id=case when choice='approve' then factory else p.factory_id end,
    reject_reason=case when choice='reject' then note else p.reject_reason end
    where id=uid;
  update auth.users
    set banned_until=case when next_status='active' then null else '9999-12-31 UTC'::timestamptz end,
        updated_at=now()
    where id=uid;
  if next_status<>'active' then
    delete from auth.sessions where user_id=uid;
  end if;
  if choice='deactivate' then
    delete from reviewer_invites where reviewer_id=uid;
  end if;
  if choice='approve' then
    insert into case_members(case_id,user_id,role)
    select c.id,uid,'manager' from cases c
      where c.factory_id=sp_account_decide.factory and not c.deleting
      on conflict do nothing;
  end if;
  insert into account_audit(actor,account_id,action,reason)
    values(actor_id,uid,choice,note);
  return p.id_card_path;
end $$;
