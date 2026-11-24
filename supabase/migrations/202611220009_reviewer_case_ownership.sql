-- Factory assignments allow reviewers to open their own cases. Manager access
-- still follows the factory. Remove earlier non-owner reviewer grants.
delete from public.case_members m using public.cases c
where m.case_id=c.id and m.role='reviewer' and m.user_id<>c.created_by;

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
  where created_by=uid and factory_id=any(factories) and not deleting on conflict do nothing;
end $$;

create or replace function public.sp_attach_managers() returns trigger language plpgsql set search_path=public as $$
begin
 insert into case_members(case_id,user_id,role)
 select new.id,id,'manager' from account_profiles where role='factory_manager' and status='active' and factory_id=new.factory_id on conflict do nothing;
 return new;
end $$;
