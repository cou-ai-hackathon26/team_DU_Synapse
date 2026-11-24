-- Preserve case, review, and corrective-work history when an account is erased.
do $$
declare
  item record;
  fk record;
begin
  for item in
    select * from (values
      ('cases', 'created_by'),
      ('verification_runs', 'created_by'),
      ('review_events', 'actor'),
      ('jobs', 'actor'),
      ('cap_review_events', 'actor'),
      ('corrective_tasks', 'created_by'),
      ('corrective_events', 'actor')
    ) as columns_to_detach(table_name, column_name)
  loop
    for fk in
      select c.conname
      from pg_constraint c
      join pg_attribute a
        on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
      where c.conrelid=format('public.%I', item.table_name)::regclass
        and c.confrelid='auth.users'::regclass
        and c.contype='f'
        and a.attname=item.column_name
    loop
      execute format(
        'alter table public.%I drop constraint %I',
        item.table_name,
        fk.conname
      );
    end loop;

    execute format(
      'alter table public.%I alter column %I drop not null',
      item.table_name,
      item.column_name
    );
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete set null',
      item.table_name,
      item.table_name || '_' || item.column_name || '_account_fkey',
      item.column_name
    );
  end loop;
end $$;

create function public.sp_account_delete(actor_id uuid, uid uuid) returns text
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

  insert into account_audit(actor,account_id,action,reason)
    values(actor_id,uid,'delete','Administrator deleted deactivated account');

  delete from auth.users where id=uid;
  return p.id_card_path;
end $$;

revoke all on function public.sp_account_delete(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sp_account_delete(uuid,uuid) to service_role;
