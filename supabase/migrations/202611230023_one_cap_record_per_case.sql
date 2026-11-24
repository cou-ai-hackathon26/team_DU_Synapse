-- A CAP may only be submitted once per case.
create unique index if not exists documents_one_cap_record_per_case
  on public.documents(case_id)
  where role = 'cap';

create or replace function public.sp_prevent_cap_reupload()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.role = 'cap'
  ) and exists (
    select 1 from public.document_versions v
    where v.document_id = new.document_id
  ) then
    raise exception 'This case already has a CAP. A second CAP cannot be uploaded.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

drop trigger if exists document_versions_prevent_cap_reupload on public.document_versions;

create trigger document_versions_prevent_cap_reupload
before insert on public.document_versions
for each row execute function public.sp_prevent_cap_reupload();
