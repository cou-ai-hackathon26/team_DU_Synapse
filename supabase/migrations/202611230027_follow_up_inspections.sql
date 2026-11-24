alter table public.cases
  add column inspection_kind text not null default 'initial',
  add column follow_up_of uuid references public.cases(id) on delete restrict,
  add column follow_up_root_id uuid references public.cases(id) on delete restrict,
  add column follow_up_number integer not null default 0;

update public.cases
set follow_up_root_id = id
where inspection_on is not null;

alter table public.cases
  add constraint cases_inspection_kind_check
    check (inspection_kind in ('initial', 'follow_up')),
  add constraint cases_follow_up_number_check
    check (follow_up_number >= 0),
  add constraint cases_follow_up_shape_check
    check (
      (inspection_kind = 'initial' and follow_up_of is null and follow_up_number = 0
        and (follow_up_root_id is null or follow_up_root_id = id))
      or
      (inspection_kind = 'follow_up' and follow_up_of is not null
        and follow_up_root_id is not null and follow_up_number > 0)
    );

create unique index cases_follow_up_sequence_unique
  on public.cases(follow_up_root_id, follow_up_number)
  where follow_up_root_id is not null;
create index cases_follow_up_parent_idx on public.cases(follow_up_of);

create or replace function public.sp_create_case(actor_id uuid, assignee_id uuid, data jsonb)
returns public.cases
language plpgsql
set search_path = public
as $$
declare
  c cases;
  parent cases;
  fid uuid;
  root_id uuid;
  follow_up_no integer := 0;
  inspection_date date := (data->>'inspection_on')::date;
  inspection_kind text := coalesce(nullif(data->>'inspection_kind', ''), 'initial');
  case_title text := data->>'title';
begin
  perform 1 from account_profiles
    where id=actor_id and role='admin' and status='active' for share;
  if not found then
    raise exception 'Administrator access required.' using errcode='PT403';
  end if;

  perform 1 from account_profiles
    where id=assignee_id and role='reviewer' and status='active' for share;
  if not found then
    raise exception 'Choose an active reviewer.' using errcode='PT422';
  end if;
  if inspection_date is null then
    raise exception 'Choose an inspection date.' using errcode='PT422';
  end if;
  if inspection_kind not in ('initial', 'follow_up') then
    raise exception 'Choose an inspection type.' using errcode='PT422';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(assignee_id::text||':'||inspection_date::text,0)
  );
  if exists(
    select 1 from cases
    where reviewer_id=assignee_id and inspection_on=inspection_date
      and not archived and not deleting
  ) then
    raise exception 'This reviewer already has an inspection assigned on this date.' using errcode='PT409';
  end if;

  select id into fid from factories where name=data->>'factory' for share;
  if not found then
    raise exception 'Choose an existing factory.' using errcode='PT422';
  end if;

  if inspection_kind = 'follow_up' then
    if nullif(data->>'follow_up_of', '') is null then
      raise exception 'Choose the earlier inspection this follow-up continues.' using errcode='PT422';
    end if;
    select * into parent from cases
      where id=(data->>'follow_up_of')::uuid
        and factory_id=fid and inspection_on is not null and not deleting
      for share;
    if not found then
      raise exception 'Choose an earlier inspection for this same factory.' using errcode='PT422';
    end if;
    root_id := coalesce(parent.follow_up_root_id, parent.id);
    perform 1 from cases
      where id=root_id and factory_id=fid
        and inspection_kind='initial' and follow_up_of is null
      for update;
    if not found then
      raise exception 'The original inspection for this series is unavailable.' using errcode='PT409';
    end if;
    if exists(select 1 from cases where follow_up_of=parent.id and not deleting) then
      raise exception 'Choose the most recent inspection in this follow-up series.' using errcode='PT409';
    end if;
    if not exists(
      select 1
      from public.documents d
      join public.document_versions v on v.document_id=d.id and v.case_id=d.case_id
      where d.case_id=parent.id and d.role='inspection'
        and d.deleted_at is null and v.status in ('ready','partial')
    ) then
      raise exception 'The earlier inspection report must be published before scheduling a follow-up.' using errcode='PT409';
    end if;

    select coalesce(max(follow_up_number), 0) + 1 into follow_up_no
      from cases where follow_up_root_id=root_id;
    case_title := case when follow_up_no = 1
      then 'Follow-up Inspection'
      else 'Follow-up Inspection '||follow_up_no::text
    end;
  elsif nullif(data->>'follow_up_of', '') is not null then
    raise exception 'Initial inspections cannot be linked to an earlier inspection.' using errcode='PT422';
  end if;

  insert into reviewer_factories(reviewer_id,factory_id)
    values(assignee_id,fid) on conflict(reviewer_id,factory_id) do nothing;

  insert into cases(
    factory,title,programme,period_start,period_end,created_by,reviewer_id,
    inspection_on,manager_notified_at,inspection_kind,follow_up_of,
    follow_up_root_id,follow_up_number
  ) values (
    data->>'factory',case_title,data->>'programme',
    (data->>'period_start')::date,(data->>'period_end')::date,
    actor_id,assignee_id,inspection_date,
    case when exists(
      select 1 from account_profiles
      where factory_id=fid and role='factory_manager' and status='active'
    ) then now() else null end,
    inspection_kind,
    case when inspection_kind='follow_up' then parent.id else null end,
    case when inspection_kind='follow_up' then root_id else null end,
    follow_up_no
  ) returning * into c;

  insert into case_members(case_id,user_id,role)
    values(c.id,assignee_id,'reviewer')
    on conflict(case_id,user_id) do update set role='reviewer';

  if inspection_kind='follow_up' then
    -- The assigned officer can open every earlier inspection in this series
    -- and review its existing files without moving or duplicating them.
    insert into case_members(case_id,user_id,role)
      select id,assignee_id,'reviewer'
      from cases
      where follow_up_root_id=root_id and id<>c.id
      on conflict(case_id,user_id) do update set role='reviewer';
  else
    update cases set follow_up_root_id=id
      where id=c.id and inspection_on is not null and follow_up_root_id is null
      returning * into c;
  end if;
  return c;
end $$;
