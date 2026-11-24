create function public.sp_create_case(actor_id uuid, data jsonb) returns public.cases
language plpgsql set search_path=public as $$
declare c cases;
begin
  insert into cases(factory,title,programme,period_start,period_end,created_by) values
    (data->>'factory',data->>'title',data->>'programme',(data->>'period_start')::date,(data->>'period_end')::date,actor_id) returning * into c;
  insert into case_members values(c.id,actor_id,'reviewer');
  return c;
end $$;
create function public.sp_write_access(cid uuid, actor_id uuid) returns void
language plpgsql set search_path=public as $$
begin
  perform 1 from cases c join case_members m on c.id=m.case_id
    where c.id=cid and m.user_id=actor_id and m.role='reviewer' and not c.archived and not c.deleting for update of c;
  if not found then raise exception 'Review access required or case is archived' using errcode='42501'; end if;
end $$;
create function public.sp_reserve(cid uuid, actor_id uuid, data jsonb) returns public.document_versions
language plpgsql set search_path=public as $$
declare d uuid; v document_versions; n int; vid uuid:=(data->>'request_key')::uuid;
begin
  perform sp_write_access(cid,actor_id);
  select * into v from document_versions where id=vid and case_id=cid;
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
  insert into document_versions(id,case_id,document_id,revision,filename,object_key,issued_on,period_start,period_end,issuer,confirmed_factory)
  values(vid,cid,d,n,data->>'filename',cid::text||'/'||vid::text||'.pdf',(data->>'issued_on')::date,
    (data->>'period_start')::date,(data->>'period_end')::date, data->>'issuer', data->>'confirmed_factory') returning * into v;
  return v;
end $$;
create function public.sp_ingest(cid uuid, actor_id uuid, vid uuid) returns uuid
language plpgsql set search_path=public as $$
declare jid uuid;
begin
  perform sp_write_access(cid,actor_id);
  if not exists(select 1 from document_versions where id=vid and case_id=cid) then raise exception 'Unknown version'; end if;
  insert into jobs(case_id,actor,kind,version_id) values(cid,actor_id,'ingest',vid)
    on conflict(version_id) do nothing returning id into jid;
  if jid is null then select id into jid from jobs where version_id=vid; else
    update document_versions set status='queued' where id=vid; end if;
  return jid;
end $$;
create function public.sp_run(cid uuid, actor_id uuid, vids uuid[], request_id uuid, configuration jsonb) returns jsonb
language plpgsql set search_path=public as $$
declare rid uuid; jid uuid; manifest jsonb; cnt int;
begin
  perform sp_write_access(cid,actor_id);
  select id into rid from verification_runs where case_id=cid and request_key=request_id;
  if found then select id into jid from jobs where run_id=rid; return jsonb_build_object('run_id',rid,'job_id',jid); end if;
  select count(*), jsonb_agg(jsonb_build_object('id',v.id,'document_id',v.document_id,'title',d.title,'role',d.role,
    'revision',v.revision,'issued_on',v.issued_on,'period_start',v.period_start,'period_end',v.period_end,'issuer',v.issuer,
    'confirmed_factory',v.confirmed_factory,'page_count',v.page_count,'readable_pages',v.readable_pages,
    'sha256',v.sha256,'extraction_id',v.extraction_id,'parser',v.parser) order by v.created_at)
    into cnt, manifest from document_versions v join documents d on d.id=v.document_id
    where v.case_id=cid and v.id=any(vids) and v.status in('ready','partial');
  if cnt<>cardinality(vids) or cnt<2 then raise exception 'Choose at least two processed document versions'; end if;
  if (select count(distinct e->>'document_id') from jsonb_array_elements(manifest) e)<>cnt then
    raise exception 'Choose one revision per document'; end if;
  if not exists(select 1 from jsonb_array_elements(manifest) e where e->>'role'='inspection') then raise exception 'Select an inspection report'; end if;
  insert into verification_runs(case_id,created_by,request_key,config,manifest) values(cid,actor_id,request_id,configuration,manifest) returning id into rid;
  insert into jobs(case_id,actor,kind,run_id) values(cid,actor_id,'verify',rid) returning id into jid;
  return jsonb_build_object('run_id',rid,'job_id',jid);
end $$;

create function public.sp_claim() returns jsonb language plpgsql set search_path=public as $$
declare j jobs;
begin
  select q.* into j from jobs q join cases c on c.id=q.case_id join case_members m on m.case_id=q.case_id and m.user_id=q.actor
    where not c.deleting and m.role='reviewer' and ((q.state='queued' and q.available_at<=now()) or (q.state='running' and q.lease_until<now()))
    order by q.created_at limit 1 for update of q skip locked;
  if not found then return null; end if;
  update jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,error=null
    where id=j.id returning * into j;
  if j.run_id is not null then update verification_runs set status='running' where id=j.run_id; end if;
  return to_jsonb(j);
end $$;
create function public.sp_step(jid uuid, ticket uuid, op text, payload jsonb) returns void
language plpgsql set search_path=public,extensions as $$
declare j jobs; v document_versions; e jsonb; other_id uuid; finish text; h text;
begin
  select * into j from jobs where id=jid and state='running' and lease=ticket and lease_until>now() for update;
  if not found then raise exception 'Job lease expired' using errcode='PT409'; end if;
  update jobs set lease_until=now()+interval '3 minutes' where id=jid;
  case op
  when 'progress' then
    update jobs set stage=coalesce(payload->>'stage',stage),completed=coalesce((payload->>'completed')::int,completed),
      total=coalesce((payload->>'total')::int,total) where id=jid;
  when 'cache' then
    insert into analysis_cache values(j.case_id,payload->>'key',payload->'value') on conflict do nothing;
  when 'usage' then
    update verification_runs set usage=jsonb_build_object('requests',coalesce((usage->>'requests')::int,0)+1,
      'input_tokens',coalesce((usage->>'input_tokens')::int,0)+coalesce((payload->>'input_tokens')::int,0),
      'output_tokens',coalesce((usage->>'output_tokens')::int,0)+coalesce((payload->>'output_tokens')::int,0),
      'model_versions',coalesce(usage->'model_versions','{}'::jsonb)||coalesce(payload->'model_versions','{}'::jsonb)) where id=j.run_id;
  when 'ingested' then
    perform 1 from cases where id=j.case_id for update;
    select * into strict v from document_versions where id=j.version_id;
    h:=payload->>'sha256';
    select id into other_id from document_versions where case_id=j.case_id and sha256=h and status in('ready','partial') and id<>v.id limit 1;
    if other_id is not null then
      update document_versions set status='duplicate',duplicate_of=other_id,sha256=h where id=v.id;
    else
      if (select coalesce(sum(page_count),0) from document_versions where case_id=j.case_id)+jsonb_array_length(payload->'pages')>100 then
        raise exception 'Case limit of 100 retained PDF pages reached'; end if;
      for e in select * from jsonb_array_elements(payload->'pages') loop
        insert into pages values((e->>'id')::uuid,j.case_id,v.id,(e->>'page_no')::int,e->>'method',e->>'quality',e->>'text',e->'blocks');
      end loop;
      for e in select * from jsonb_array_elements(payload->'chunks') loop
        insert into chunks(id,case_id,version_id,page_id,page_no,start_at,end_at,text) values
          ((e->>'id')::uuid,j.case_id,v.id,(e->>'page_id')::uuid,(e->>'page_no')::int,(e->>'start_at')::int,(e->>'end_at')::int,e->>'text');
      end loop;
      update document_versions set sha256=h,parser=payload->>'parser',extraction_id=gen_random_uuid(),page_count=jsonb_array_length(payload->'pages'),
        readable_pages=(payload->>'readable_pages')::int,status=case when (payload->>'readable_pages')::int=jsonb_array_length(payload->'pages') then 'ready' else 'partial' end where id=v.id;
    end if;
    update jobs set state='done',stage='Document processed',lease=null,lease_until=null where id=jid;
  when 'embeddings' then
    for e in select * from jsonb_array_elements(payload->'rows') loop
      update chunks set embedding=(e->>'vector')::vector,embedding_model=payload->>'model'
        where id=(e->>'id')::uuid and case_id=j.case_id;
    end loop;
  when 'result' then
    insert into results(id,case_id,run_id,claim,outcome,reason,evidence,coverage,checks) values
      ((payload->>'id')::uuid,j.case_id,j.run_id,payload->'claim',payload->>'outcome',payload->>'reason',
       payload->'evidence',payload->'coverage',payload->'checks') on conflict(id) do nothing;
  when 'finished' then
    finish:=case when coalesce((payload->>'partial')::boolean,false) then 'partial' else 'complete' end;
    update verification_runs set status=finish,finished_at=now(),usage=usage||coalesce(payload->'summary','{}'::jsonb) where id=j.run_id;
    update jobs set state='done',stage='Review available',lease=null,lease_until=null where id=jid;
  when 'error' then
    finish:=payload->>'state';
    if finish not in ('queued','paused','failed') then raise exception 'Invalid job state'; end if;
    update jobs set state=finish,error=payload->>'message',stage=case when finish='queued' then 'Retry scheduled' else 'Processing interrupted' end,
      available_at=now()+make_interval(secs=>coalesce((payload->>'delay')::int,0)),lease=null,lease_until=null where id=jid;
    update verification_runs set status=finish where id=j.run_id;
    if finish='failed' then update document_versions set status='failed',error=payload->>'message' where id=j.version_id; end if;
  else raise exception 'Unknown processing operation';
  end case;
end $$;
create function public.sp_retry(cid uuid,actor_id uuid,jid uuid) returns uuid
language plpgsql set search_path=public as $$
declare j jobs;
begin
  perform sp_write_access(cid,actor_id);
  update jobs set state='queued',available_at=now(),error=null,stage='Waiting to retry',attempts=0
    where id=jid and case_id=cid and state in ('failed','paused') returning * into j;
  if not found then raise exception 'Job is not available for retry'; end if;
  update verification_runs set status='queued' where id=j.run_id;
  update document_versions set status='queued',error=null where id=j.version_id;
  return jid;
end $$;
create function public.sp_review(cid uuid,actor_id uuid,rid uuid,data jsonb) returns uuid
language plpgsql set search_path=public as $$
declare eid uuid;
begin
  perform sp_write_access(cid,actor_id);
  if not exists(select 1 from results r join verification_runs v on r.run_id=v.id where r.id=rid and r.case_id=cid and v.status in ('complete','partial')) then
    raise exception 'Review requires a completed analysis snapshot'; end if;
  insert into review_events(case_id,result_id,actor,action,comment) values(cid,rid,actor_id,data->>'action',coalesce(data->>'comment','')) returning id into eid;
  return eid;
end $$;

-- Exact cosine ranking and lexical hits are fused within the supplied case and versions.
create function public.sp_search(cid uuid, vid_list uuid[], query_text text, query_embedding extensions.vector(768), model_name text)
returns table(chunk_id uuid,rank_score float8)
language sql stable set search_path=public,extensions as $$
 with eligible as materialized (select id,embedding,keywords,text from chunks where case_id=cid and version_id=any(vid_list) and embedding_model=model_name),
 dense as (select id,row_number() over(order by embedding <=> query_embedding,id) r from eligible order by r limit 30),
 terms as (select plainto_tsquery('simple', query_text) q),
 lexical as (select id,row_number() over(order by ts_rank_cd(keywords,q) desc,id) r from eligible,terms where keywords @@ q order by r limit 30),
 ids as (select distinct upper(m[1]) ident from regexp_matches(query_text,'([[:alpha:]]{1,5}[-‐‑][[:alnum:]]+)','g') m),
 entity as (select distinct e.id from eligible e, ids where strpos(upper(e.text),ids.ident)>0)
 select d.id, (1.0/(60+d.r)+coalesce(1.0/(60+l.r),0)+case when e.id is null then 0 else 0.02 end)::float8
 from dense d left join lexical l using(id) left join entity e using(id)
 union all
 select l.id,(1.0/(60+l.r)+case when e.id is null then 0 else 0.02 end)::float8
 from lexical l left join dense d using(id) left join entity e using(id) where d.id is null order by 2 desc,1 limit 10;
$$;
do $$ declare fn regprocedure; begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,3)='sp_' loop
    execute format('revoke all on function %s from public, anon, authenticated',fn);
    execute format('grant execute on function %s to service_role',fn);
  end loop;
end $$;
