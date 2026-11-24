alter table public.documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users on delete set null;

drop index if exists public.documents_one_cap_record_per_case;
create unique index documents_one_cap_record_per_case
  on public.documents(case_id)
  where role = 'cap' and deleted_at is null;

create or replace function public.sp_prevent_cap_reupload()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.documents d
    where d.id = new.document_id and d.role = 'cap' and d.deleted_at is null
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

create or replace function public.sp_reserve(cid uuid, actor_id uuid, data jsonb)
returns public.document_versions
language plpgsql
set search_path = public
as $$
declare
  c cases;
  member_role text;
  d uuid;
  v document_versions;
  n int;
  vid uuid := (data->>'request_key')::uuid;
begin
  select * into c from cases where id = cid and not archived and not deleting for update;
  if not found then
    raise exception 'Case is archived or unavailable.' using errcode = 'PT403';
  end if;
  member_role := sp_document_member(cid, actor_id);
  if c.inspection_on is not null then
    if member_role = 'reviewer' then
      if data->>'role' <> 'inspection' then
        raise exception 'Factory records must be submitted by the factory manager.' using errcode = 'PT403';
      end if;
      if (data->>'issued_on') is null
        or date_trunc('month', (data->>'issued_on')::date) <> date_trunc('month', c.inspection_on)
        or (data->>'period_start' is not null and date_trunc('month', (data->>'period_start')::date) <> date_trunc('month', c.inspection_on))
        or (data->>'period_end' is not null and date_trunc('month', (data->>'period_end')::date) <> date_trunc('month', c.inspection_on))
      then
        raise exception 'Inspection dates must be in the scheduled inspection month.' using errcode = 'PT422';
      end if;
    elsif data->>'role' = 'inspection' then
      raise exception 'Only the assigned reviewer can submit an inspection report.' using errcode = 'PT403';
    elsif not exists (
      select 1 from documents report
      join document_versions report_version on report_version.document_id = report.id
      where report.case_id = cid and report.role = 'inspection'
        and report.deleted_at is null and report_version.status in ('ready', 'partial')
    ) then
      raise exception 'Wait for the reviewer to publish the inspection report.' using errcode = 'PT409';
    end if;
  end if;

  select * into v from document_versions
  where id = vid and case_id = cid
    and (uploaded_by = actor_id or (uploaded_by is null and member_role = 'reviewer'));
  if found then return v; end if;
  if (select lower(trim(factory)) from cases where id = cid) <> lower(trim(data->>'confirmed_factory')) then
    raise exception 'Document factory must match the case';
  end if;

  d := (data->>'document_id')::uuid;
  if d is null then
    if (select count(*) from documents ds where ds.case_id = cid and ds.deleted_at is null
      and not exists (select 1 from document_versions vs where vs.document_id = ds.id
        having bool_and(vs.status in ('duplicate', 'failed')))) >= 10 then
      raise exception 'Case limit of ten documents reached';
    end if;
    insert into documents(case_id, title, role)
    values(cid, data->>'title', data->>'role') returning id into d;
  elsif not exists (
    select 1 from documents where id = d and case_id = cid
      and role = data->>'role' and deleted_at is null
  ) then
    raise exception 'Revision must reference an active document of the same role in this case';
  end if;

  select coalesce(max(revision), 0) + 1 into n from document_versions where document_id = d;
  insert into document_versions(
    id, case_id, document_id, revision, filename, object_key, issued_on,
    period_start, period_end, issuer, confirmed_factory, uploaded_by
  ) values (
    vid, cid, d, n, data->>'filename', cid::text || '/' || vid::text || '.pdf',
    (data->>'issued_on')::date, (data->>'period_start')::date, (data->>'period_end')::date,
    case when c.inspection_on is null then data->>'issuer'
         when member_role = 'manager' then 'factory' else 'external' end,
    data->>'confirmed_factory', actor_id
  ) returning * into v;
  return v;
end;
$$;
