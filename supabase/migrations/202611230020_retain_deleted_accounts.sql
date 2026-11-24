alter table public.account_profiles
  drop constraint account_profiles_status_check;
alter table public.account_profiles
  add constraint account_profiles_status_check
  check (status in ('pending','pending_approval','active','rejected','deactivated','deleted'));

create or replace function public.sp_account_delete(actor_id uuid, uid uuid) returns text
language plpgsql security definer set search_path=public as $$
declare p account_profiles;
begin
  perform 1 from account_profiles
    where id=actor_id and role='admin' and status='active' for share;
  if not found then
    raise exception 'Administrator access required' using errcode='PT403';
  end if;

  select * into p from account_profiles where id=uid for update;
  if not found or p.role not in ('reviewer','factory_manager') then
    raise exception 'Account unavailable' using errcode='PT404';
  end if;
  if p.status<>'deactivated' then
    raise exception 'Only deactivated accounts can be deleted' using errcode='PT409';
  end if;

  update verification_runs set status='failed', finished_at=now()
    where id in (
      select run_id from jobs where actor=uid and run_id is not null
        and state in ('queued','running')
    );
  update jobs set state='failed', stage='Account deleted',
      error='The assigned account was deleted.', lease=null, lease_until=null
    where actor=uid and state in ('queued','running');

  delete from auth.sessions where user_id=uid;
  update auth.users set banned_until='9999-12-31 UTC'::timestamptz, updated_at=now()
    where id=uid;
  update account_profiles set status='deleted' where id=uid;
  delete from reviewer_invites where reviewer_id=uid;
  delete from reviewer_factories where reviewer_id=uid;

  insert into account_audit(actor,account_id,action,reason)
    values(actor_id,uid,'delete','Administrator marked deactivated account as deleted');
  return p.id_card_path;
end $$;

revoke all on function public.sp_account_delete(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sp_account_delete(uuid,uuid) to service_role;
