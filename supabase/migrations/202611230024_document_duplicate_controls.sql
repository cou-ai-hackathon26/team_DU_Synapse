-- Persist OCR-based identity separately from the source PDF hash. Files that
-- differ in metadata or filename but contain the same readable text share it.
alter table public.document_versions
  add column if not exists content_fingerprint text,
  add column if not exists duplicate_warning text;

create unique index if not exists document_versions_case_content_fingerprint_unique
  on public.document_versions(case_id, content_fingerprint)
  where content_fingerprint is not null
    and status in ('awaiting_upload', 'queued', 'ready', 'partial');

create or replace function public.sp_register_document_fingerprint(
  cid uuid,
  actor_id uuid,
  vid uuid,
  fingerprint text,
  warning text,
  existing_duplicate uuid default null
) returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare prior uuid;
begin
  if fingerprint is null or fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid OCR fingerprint is required.' using errcode='PT422';
  end if;

  perform 1 from public.cases where id=cid and not archived and not deleting for update;
  if not found then raise exception 'Case is unavailable.' using errcode='PT403'; end if;

  if not exists (
    select 1 from public.document_versions
    where id=vid and case_id=cid and uploaded_by=actor_id
      and status='awaiting_upload'
  ) then
    raise exception 'This upload is unavailable or already finalized.' using errcode='PT409';
  end if;

  if existing_duplicate is not null then
    select id into prior from public.document_versions
      where id=existing_duplicate and case_id=cid and status in ('queued','ready','partial')
      for share;
  end if;

  if prior is null then
    select id into prior from public.document_versions
      where case_id=cid and content_fingerprint=fingerprint
        and status in ('awaiting_upload','queued','ready','partial') and id<>vid
      order by created_at limit 1 for share;
  end if;

  if prior is not null then
    update public.document_versions
      set status='duplicate', duplicate_of=prior,
          error='This PDF repeats readable document text already uploaded in this case.'
      where id=vid;
    return prior;
  end if;

  update public.document_versions
    set content_fingerprint=fingerprint, duplicate_warning=nullif(left(warning,500), '')
    where id=vid;
  return null;
end;
$$;

revoke all on function public.sp_register_document_fingerprint(uuid,uuid,uuid,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.sp_register_document_fingerprint(uuid,uuid,uuid,text,text,uuid)
  to service_role;
