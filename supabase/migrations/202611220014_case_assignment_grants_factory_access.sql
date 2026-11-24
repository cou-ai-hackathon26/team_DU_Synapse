create or replace function public.sp_create_case(actor_id uuid, assignee_id uuid, data jsonb) returns public.cases
language plpgsql set search_path=public as $$
declare c cases; fid uuid;
begin
  perform 1 from account_profiles where id=actor_id and role='admin' and status='active' for share;
  if not found then raise exception 'Administrator access required.' using errcode='PT403'; end if;

  perform 1 from account_profiles where id=assignee_id and role='reviewer' and status='active' for share;
  if not found then raise exception 'Choose an active reviewer.' using errcode='PT422'; end if;

  select id into fid from factories where name=data->>'factory' for share;
  if not found then raise exception 'Choose an existing factory.' using errcode='PT422'; end if;

  insert into reviewer_factories(reviewer_id,factory_id) values(assignee_id,fid)
    on conflict(reviewer_id,factory_id) do nothing;

  insert into cases(factory,title,programme,period_start,period_end,created_by,reviewer_id,inspection_on) values
    (data->>'factory',data->>'title',data->>'programme',(data->>'period_start')::date,
     (data->>'period_end')::date,actor_id,assignee_id,(data->>'inspection_on')::date) returning * into c;
  insert into case_members(case_id,user_id,role) values(c.id,assignee_id,'reviewer');
  return c;
end $$;
