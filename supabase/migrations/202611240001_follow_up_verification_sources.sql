-- Allow a follow-up verification to compare its report with ready documents
-- from earlier inspections in the same assigned inspection series.
create or replace function public.sp_run(
  cid uuid,
  actor_id uuid,
  vids uuid[],
  request_id uuid,
  configuration jsonb
) returns jsonb
language plpgsql
set search_path=public
as $$
declare
  rid uuid;
  jid uuid;
  manifest jsonb;
  cnt int;
  run_case cases;
begin
  perform public.sp_write_access(cid, actor_id);
  select * into run_case from public.cases where id=cid;

  select id into rid
    from public.verification_runs
    where case_id=cid and request_key=request_id;
  if found then
    select id into jid from public.jobs where run_id=rid;
    return jsonb_build_object('run_id', rid, 'job_id', jid);
  end if;

  select count(*), jsonb_agg(jsonb_build_object(
    'id', v.id,
    'document_id', v.document_id,
    'title', d.title,
    'role', d.role,
    'revision', v.revision,
    'issued_on', v.issued_on,
    'period_start', v.period_start,
    'period_end', v.period_end,
    'issuer', v.issuer,
    'confirmed_factory', v.confirmed_factory,
    'page_count', v.page_count,
    'readable_pages', v.readable_pages,
    'sha256', v.sha256,
    'extraction_id', v.extraction_id,
    'parser', v.parser
  ) order by v.created_at)
  into cnt, manifest
  from public.document_versions v
  join public.documents d on d.id=v.document_id
  join public.cases source_case on source_case.id=v.case_id
  where v.id=any(vids)
    and v.status in ('ready','partial')
    and (
      v.case_id=cid
      or (
        run_case.inspection_kind='follow_up'
        and source_case.follow_up_root_id=run_case.follow_up_root_id
        and source_case.inspection_on < run_case.inspection_on
        and exists (
          select 1 from public.case_members m
          where m.case_id=source_case.id
            and m.user_id=actor_id
            and m.role='reviewer'
        )
      )
    );

  if cnt<>cardinality(vids) or cnt<2 then
    raise exception 'Choose at least two processed document versions';
  end if;
  if (
    select count(distinct e->>'document_id')
    from jsonb_array_elements(manifest) e
  )<>cnt then
    raise exception 'Choose one revision per document';
  end if;
  if not exists(
    select 1 from jsonb_array_elements(manifest) e
    where e->>'role'='inspection'
  ) then
    raise exception 'Select an inspection report';
  end if;

  insert into public.verification_runs(case_id,created_by,request_key,config,manifest)
    values(cid,actor_id,request_id,configuration,manifest)
    returning id into rid;
  insert into public.jobs(case_id,actor,kind,run_id)
    values(cid,actor_id,'verify',rid)
    returning id into jid;
  return jsonb_build_object('run_id',rid,'job_id',jid);
end $$;
