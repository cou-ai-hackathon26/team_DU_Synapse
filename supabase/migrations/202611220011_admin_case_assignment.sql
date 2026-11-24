alter table public.cases add column reviewer_id uuid references public.account_profiles on delete set null;
create index on public.cases(reviewer_id);

-- Preserve the assignee of legacy cases, including temporarily unassigned factories.
update public.cases c set reviewer_id=p.id
from public.account_profiles p where p.id=c.created_by and p.role='reviewer';

drop function public.sp_create_case(uuid,jsonb);
create function public.sp_create_case(actor_id uuid, assignee_id uuid, data jsonb) returns public.cases
language plpgsql set search_path=public as $$
declare c cases;
begin
  perform 1 from account_profiles where id=actor_id and role='admin' and status='active' for share;
  if not found then raise exception 'Administrator access required.' using errcode='PT403'; end if;

  perform 1 from account_profiles where id=assignee_id and role='reviewer' and status='active' for share;
  if not found then raise exception 'Choose an active reviewer.' using errcode='PT422'; end if;

  perform 1 from reviewer_factories rf join factories f on f.id=rf.factory_id
    where rf.reviewer_id=assignee_id and f.name=data->>'factory' for share of f;
  if not found then raise exception 'Choose a reviewer assigned to this factory.' using errcode='PT422'; end if;

  insert into cases(factory,title,programme,period_start,period_end,created_by,reviewer_id) values
    (data->>'factory',data->>'title',data->>'programme',(data->>'period_start')::date,
     (data->>'period_end')::date,actor_id,assignee_id) returning * into c;
  insert into case_members(case_id,user_id,role) values(c.id,assignee_id,'reviewer');
  return c;
end $$;

revoke all on function public.sp_create_case(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sp_create_case(uuid,uuid,jsonb) to service_role;

create or replace function public.sp_reviewer_assign(uid uuid, factories uuid[]) returns void
language plpgsql set search_path=public as $$
begin
  perform 1 from account_profiles where id=uid and role='reviewer' and status in ('pending','active') for update;
  if not found then raise exception 'Reviewer unavailable' using errcode='PT404'; end if;
  if exists(select 1 from unnest(factories) f(id) where not exists(select 1 from public.factories x where x.id=f.id)) then
    raise exception 'Choose existing factories' using errcode='PT422';
  end if;
  delete from reviewer_factories where reviewer_id=uid;
  insert into reviewer_factories select uid,unnest(factories);
  delete from case_members m using cases c where m.user_id=uid and m.role='reviewer' and m.case_id=c.id
    and not coalesce(c.factory_id=any(factories),false);
  insert into case_members(case_id,user_id,role) select id,uid,'reviewer' from cases
    where reviewer_id=uid and factory_id=any(factories) and not deleting on conflict do nothing;
end $$;
