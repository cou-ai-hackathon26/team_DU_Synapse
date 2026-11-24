alter table public.cases add column inspection_on date;
alter table public.document_versions add column uploaded_by uuid references auth.users on delete set null;

-- Managers in a scheduled case can see the inspection and factory records.
-- Extracted pages and verification results retain their existing reviewer policies.
create policy manager_case_documents on public.documents for select to authenticated
using (case_id in (select c.id from public.cases c join public.case_members m on m.case_id=c.id
  where c.inspection_on is not null and m.user_id=(select auth.uid()) and m.role='manager'));

create policy manager_case_versions on public.document_versions for select to authenticated
using (case_id in (select c.id from public.cases c join public.case_members m on m.case_id=c.id
  where c.inspection_on is not null and m.user_id=(select auth.uid()) and m.role='manager')
  and (status in ('ready','partial') or uploaded_by=(select auth.uid())));

create function public.sp_document_member(cid uuid, actor_id uuid) returns text
language plpgsql set search_path=public as $$
declare member_role text;
begin
  select m.role into member_role from case_members m join cases c on c.id=m.case_id
    join account_profiles p on p.id=m.user_id
    where c.id=cid and m.user_id=actor_id and p.status='active'
    and (m.role='reviewer' or (m.role='manager' and c.inspection_on is not null));
  if not found then raise exception 'Document access required.' using errcode='PT403'; end if;
  return member_role;
end $$;
revoke all on function public.sp_document_member(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sp_document_member(uuid,uuid) to service_role;


create or replace function public.sp_create_case(actor_id uuid, assignee_id uuid, data jsonb) returns public.cases
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

  insert into cases(factory,title,programme,period_start,period_end,created_by,reviewer_id,inspection_on) values
    (data->>'factory',data->>'title',data->>'programme',(data->>'period_start')::date,
     (data->>'period_end')::date,actor_id,assignee_id,(data->>'inspection_on')::date) returning * into c;
  insert into case_members(case_id,user_id,role) values(c.id,assignee_id,'reviewer');
  return c;
end $$;



create or replace function public.sp_reserve(cid uuid, actor_id uuid, data jsonb) returns public.document_versions
language plpgsql set search_path=public as $$
declare c cases; member_role text; d uuid; v document_versions; n int; vid uuid:=(data->>'request_key')::uuid;
begin
  select * into c from cases where id=cid and not archived and not deleting for update;
  if not found then raise exception 'Case is archived or unavailable.' using errcode='PT403'; end if;
  member_role:=sp_document_member(cid,actor_id);
  if c.inspection_on is not null then
    if member_role='reviewer' then
      if data->>'role'<>'inspection' then
        raise exception 'Factory records must be submitted by the factory manager.' using errcode='PT403';
      end if;
      if (data->>'issued_on') is null
        or date_trunc('month',(data->>'issued_on')::date) <> date_trunc('month',c.inspection_on)
        or (data->>'period_start' is not null and date_trunc('month',(data->>'period_start')::date) <> date_trunc('month',c.inspection_on))
        or (data->>'period_end' is not null and date_trunc('month',(data->>'period_end')::date) <> date_trunc('month',c.inspection_on))
      then
        raise exception 'Inspection dates must be in the scheduled inspection month.' using errcode='PT422';
      end if;
    elsif data->>'role'='inspection' then
      raise exception 'Only the assigned reviewer can submit an inspection report.' using errcode='PT403';
    elsif not exists(
      select 1 from documents report join document_versions report_version on report_version.document_id=report.id
      where report.case_id=cid and report.role='inspection' and report_version.status in ('ready','partial')
    ) then
      raise exception 'Wait for the reviewer to publish the inspection report.' using errcode='PT409';
    end if;
  end if;
  select * into v from document_versions where id=vid and case_id=cid and (uploaded_by=actor_id or (uploaded_by is null and member_role='reviewer'));
  if found then return v; end if;
  if (select lower(trim(factory)) from cases where id=cid)<>lower(trim(data->>'confirmed_factory')) then
    raise exception 'Document factory must match the case'; end if;
  d:=(data->>'document_id')::uuid;
  if d is null then
    if (select count(*) from documents ds where ds.case_id=cid and not exists
      (select 1 from document_versions vs where vs.document_id=ds.id having bool_and(vs.status in ('duplicate','failed'))))>=10 then
      raise exception 'Case limit of ten documents reached'; end if;
    insert into documents(case_id,title,role) values(cid,data->>'title',data->>'role') returning id into d;
  elsif not exists(select 1 from documents where id=d and case_id=cid and role=data->>'role') then
    raise exception 'Revision must reference a document of the same role in this case';
  end if;
  select coalesce(max(revision),0)+1 into n from document_versions where document_id=d;
  insert into document_versions(id,case_id,document_id,revision,filename,object_key,issued_on,period_start,period_end,issuer,confirmed_factory,uploaded_by)
  values(vid,cid,d,n,data->>'filename',cid::text||'/'||vid::text||'.pdf',(data->>'issued_on')::date,
    (data->>'period_start')::date,(data->>'period_end')::date, case when c.inspection_on is null then data->>'issuer' when member_role='manager' then 'factory' else 'external' end, data->>'confirmed_factory',actor_id) returning * into v;
  return v;
end $$;


create or replace function public.sp_ingest(cid uuid, actor_id uuid, vid uuid) returns uuid
language plpgsql set search_path=public as $$
declare jid uuid; member_role text;
begin
  perform 1 from cases where id=cid and not archived and not deleting for update;
  if not found then raise exception 'Case is archived or unavailable.' using errcode='PT403'; end if;
  member_role:=sp_document_member(cid,actor_id);
  if not exists(select 1 from document_versions where id=vid and case_id=cid
    and (uploaded_by=actor_id or (uploaded_by is null and member_role='reviewer'))) then
    raise exception 'Only the uploader can finalize this PDF.' using errcode='PT403';
  end if;
  insert into jobs(case_id,actor,kind,version_id) values(cid,actor_id,'ingest',vid)
    on conflict(version_id) do nothing returning id into jid;
  if jid is null then select id into jid from jobs where version_id=vid; else
    update document_versions set status='queued' where id=vid; end if;
  return jid;
end $$;


create or replace function public.sp_claim() returns jsonb language plpgsql set search_path=public as $$
declare j jobs;
begin
  -- Serialize claims across overlapping web-service processes during a restart.
  if not pg_try_advisory_xact_lock(52008319) then return null; end if;
  if exists(select 1 from jobs where state='running' and lease_until>now()) then return null; end if;
  select q.* into j from jobs q join cases c on c.id=q.case_id join case_members m on m.case_id=q.case_id and m.user_id=q.actor
    where not c.deleting and (m.role='reviewer' or (m.role='manager' and q.kind='ingest' and c.inspection_on is not null)) and ((q.state='queued' and q.available_at<=now()) or (q.state='running' and q.lease_until<now()))
    order by (q.state='running') desc, q.created_at limit 1 for update of q skip locked;
  if not found then return null; end if;
  update jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,error=null
    where id=j.id returning * into j;
  if j.run_id is not null then update verification_runs set status='running' where id=j.run_id; end if;
  return to_jsonb(j);
end $$;


create or replace function public.sp_claim_job(jid uuid) returns jsonb
language plpgsql set search_path=public as $$
declare j jobs;
begin
  select q.* into j from jobs q join cases c on c.id=q.case_id
    join case_members m on m.case_id=q.case_id and m.user_id=q.actor
    where q.id=jid and not c.deleting and (m.role='reviewer' or (m.role='manager' and q.kind='ingest' and c.inspection_on is not null))
    and ((q.state='queued' and q.available_at<=now()) or (q.state='running' and q.lease_until<now()))
    for update of q skip locked;
  if not found then return null; end if;
  update jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',
    attempts=attempts+1,error=null where id=jid returning * into j;
  if j.run_id is not null then update verification_runs set status='running' where id=j.run_id; end if;
  return to_jsonb(j);
end $$;
