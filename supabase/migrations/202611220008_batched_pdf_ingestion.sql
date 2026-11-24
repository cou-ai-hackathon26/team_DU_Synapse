-- Keep file uploads subject to the project's Storage quota, with no evidence-bucket override.
update storage.buckets set file_size_limit=null where id='evidence';

create function public.sp_ingest_batch(jid uuid, ticket uuid, batch jsonb) returns void
language plpgsql set search_path=public as $$
declare
  j jobs;
  v document_versions;
  first_page int := (batch->>'offset')::int;
  total_pages int := (batch->>'total_pages')::int;
  batch_size int := jsonb_array_length(batch->'pages');
  file_hash text := batch->>'sha256';
  parser_id text := batch->>'parser';
  duplicate_id uuid;
begin
  select * into j from jobs where id=jid and kind='ingest' and state='running'
    and lease=ticket and lease_until>now() for update;
  if not found then raise exception 'Job lease expired' using errcode='PT409'; end if;

  select * into strict v from document_versions where id=j.version_id for update;
  if first_page<>j.completed or batch_size<1 or first_page+batch_size>total_pages
     or (first_page>0 and (total_pages<>j.total or v.sha256 is distinct from file_hash
         or v.parser is distinct from parser_id)) then
    raise exception 'PDF processing checkpoint differs from the stored original' using errcode='PT409';
  end if;
  if (select count(*) from jsonb_array_elements(batch->'pages') p
      where (p->>'page_no')::int between first_page+1 and first_page+batch_size)<>batch_size then
    raise exception 'Invalid page batch' using errcode='PT409';
  end if;

  -- Serialize duplicate checks only at publication, when another import can be complete.
  if first_page+batch_size=total_pages then
    perform 1 from cases where id=j.case_id for update;
    select id into duplicate_id from document_versions
      where case_id=j.case_id and sha256=file_hash and status in ('ready','partial') and id<>v.id
      order by created_at,id limit 1;
    if duplicate_id is not null then
      delete from pages where version_id=v.id;
      update document_versions set status='duplicate',duplicate_of=duplicate_id,sha256=file_hash where id=v.id;
      update jobs set state='done',stage='Duplicate document',completed=total_pages,total=total_pages,
        lease=null,lease_until=null where id=jid;
      return;
    end if;
  end if;

  insert into pages(id,case_id,version_id,page_no,method,quality,text,blocks)
  select p.id,j.case_id,v.id,p.page_no,p.method,p.quality,p.text,p.blocks
  from jsonb_to_recordset(batch->'pages') as p(id uuid,page_no int,method text,quality text,text text,blocks jsonb);

  insert into chunks(id,case_id,version_id,page_id,page_no,start_at,end_at,text)
  select c.id,j.case_id,v.id,c.page_id,c.page_no,c.start_at,c.end_at,c.text
  from jsonb_to_recordset(batch->'chunks') as c(id uuid,page_id uuid,page_no int,start_at int,end_at int,text text);

  if first_page+batch_size=total_pages then
    update document_versions set
      sha256=file_hash,parser=parser_id,extraction_id=gen_random_uuid(),
      page_count=total_pages,readable_pages=(select count(*) from pages where version_id=v.id and quality='readable'),
      status=case when exists(select 1 from pages where version_id=v.id and quality<>'readable') then 'partial' else 'ready' end
    where id=v.id;
    update jobs set state='done',stage='Document processed',completed=total_pages,total=total_pages,
      lease=null,lease_until=null where id=jid;
  else
    update document_versions set sha256=file_hash,parser=parser_id where id=v.id;
    update jobs set stage='Reading PDF pages',completed=first_page+batch_size,total=total_pages,
      lease_until=now()+interval '3 minutes' where id=jid;
  end if;
end $$;
revoke all on function public.sp_ingest_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sp_ingest_batch(uuid,uuid,jsonb) to service_role;
