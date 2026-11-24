create or replace function public.sp_claim() returns jsonb language plpgsql set search_path=public as $$
declare j jobs;
begin
  -- Serialize claims across overlapping web-service processes during a restart.
  if not pg_try_advisory_xact_lock(52008319) then return null; end if;
  if exists(select 1 from jobs where state='running' and lease_until>now()) then return null; end if;
  select q.* into j from jobs q join cases c on c.id=q.case_id join case_members m on m.case_id=q.case_id and m.user_id=q.actor
    where not c.deleting and m.role='reviewer' and ((q.state='queued' and q.available_at<=now()) or (q.state='running' and q.lease_until<now()))
    order by (q.state='running') desc, q.created_at limit 1 for update of q skip locked;
  if not found then return null; end if;
  update jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,error=null
    where id=j.id returning * into j;
  if j.run_id is not null then update verification_runs set status='running' where id=j.run_id; end if;
  return to_jsonb(j);
end $$;

create or replace function public.sp_search(cid uuid, vid_list uuid[], query_text text, query_embedding extensions.vector(768), model_name text)
returns table(chunk_id uuid,rank_score float8)
language sql stable set search_path=public,extensions as $$
 with eligible as materialized (
   select id,embedding,keywords,lower(translate(text,'০১২৩৪৫৬৭৮৯‐‑–','0123456789---')) search_text
   from chunks where case_id=cid and version_id=any(vid_list) and embedding_model=model_name
 ),
 dense as (select id,row_number() over(order by embedding <=> query_embedding,id) r from eligible order by r limit 30),
 terms as (select to_tsquery('simple',string_agg(quote_literal(word),' | ')) q
   from (select distinct word from regexp_split_to_table(query_text,'[[:space:][:punct:]]+') word
         where length(word)>2 order by word limit 50) w),
 lexical as (select id,row_number() over(order by ts_rank_cd(keywords,q) desc,id) r from eligible,terms where keywords @@ q order by r limit 30),
 ids as (select distinct m[1] ident from regexp_matches(query_text,'([a-z]{1,5}-[0-9]{1,6})','g') m),
 entity as (select distinct e.id from eligible e join ids on e.search_text ~ ('(^|[^[:alnum:]])' || ids.ident || '([^[:alnum:]]|$)')),
 candidates as (select id from dense union select id from lexical union select id from entity)
 select c.id,coalesce(1.0/(60+d.r),0)::float8+coalesce(1.0/(60+l.r),0)::float8+case when e.id is null then 0.0 else 0.025 end
 from candidates c left join dense d using(id) left join lexical l using(id) left join entity e using(id)
 order by 2 desc,1 limit 10;
$$;
