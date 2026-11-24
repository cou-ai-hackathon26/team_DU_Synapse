-- Search selected evidence from prior inspections in the same follow-up series.
-- sp_search is only executable by the service role; sp_run validates the
-- reviewer and source-case membership before a manifest can be created.
create or replace function public.sp_search(
  cid uuid,
  vid_list uuid[],
  query_text text,
  query_embedding extensions.vector(768),
  model_name text
)
returns table(chunk_id uuid, rank_score float8)
language sql stable set search_path=public,extensions as $$
 with run_case as materialized (
   select id,inspection_kind,follow_up_root_id,inspection_on
   from public.cases where id=cid
 ), eligible as materialized (
   select ch.id,ch.embedding,ch.keywords,
          lower(translate(ch.text,'০১২৩৪৫৬৭৮৯‐‑–','0123456789---')) search_text
   from public.chunks ch
   join public.document_versions v on v.id=ch.version_id
   join public.cases source_case on source_case.id=v.case_id
   cross join run_case rc
   where ch.version_id=any(vid_list)
     and ch.embedding_model=model_name
     and (
       v.case_id=cid
       or (
         rc.inspection_kind='follow_up'
         and source_case.follow_up_root_id=rc.follow_up_root_id
         and source_case.inspection_on < rc.inspection_on
       )
     )
 ), dense as (
   select id,row_number() over(order by embedding <=> query_embedding,id) r
   from eligible order by r limit 30
 ), terms as (
   select to_tsquery('simple',string_agg(quote_literal(word),' | ')) q
   from (
     select distinct word
     from regexp_split_to_table(query_text,'[[:space:][:punct:]]+') word
     where length(word)>2 order by word limit 50
   ) w
 ), lexical as (
   select id,row_number() over(order by ts_rank_cd(keywords,q) desc,id) r
   from eligible,terms where keywords @@ q order by r limit 30
 ), ids as (
   select distinct m[1] ident
   from regexp_matches(query_text,'([a-z]{1,5}-[0-9]{1,6})','g') m
 ), entity as (
   select distinct e.id from eligible e join ids
     on e.search_text ~ ('(^|[^[:alnum:]])' || ids.ident || '([^[:alnum:]]|$)')
 ), candidates as (
   select id from dense union select id from lexical union select id from entity
 )
 select c.id,
        coalesce(1.0/(60+d.r),0)::float8
        +coalesce(1.0/(60+l.r),0)::float8
        +case when e.id is null then 0.0 else 0.025 end
 from candidates c
 left join dense d using(id)
 left join lexical l using(id)
 left join entity e using(id)
 order by 2 desc,1 limit 10;
$$;
