alter table public.case_members drop constraint case_members_role_check;
alter table public.case_members add constraint case_members_role_check check (role in ('reviewer','viewer','manager'));

-- Managers see their assigned cases and corrective work. Audit packets remain role restricted.
do $$ declare t text;
begin
  foreach t in array array['documents','document_versions','pages','chunks','verification_runs','results','review_events','cap_review_events','jobs'] loop
    execute format('drop policy case_read on public.%I',t);
    execute format('create policy case_read on public.%I for select to authenticated using (case_id in
      (select m.case_id from public.case_members m where m.user_id=(select auth.uid()) and m.role in (''reviewer'',''viewer'')))',t);
  end loop;
end $$;

create table public.corrective_tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  title text not null check (length(title) between 1 and 160),
  detail text not null default '' check(length(detail)<=3000),
  assignee text not null check(length(assignee) between 1 and 120),
  due_on date not null,
  status text not null default 'assigned' check(status in('assigned','in_progress','submitted','needs_revision','reviewed')),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);
create table public.corrective_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  task_id uuid not null references public.corrective_tasks on delete cascade,
  actor uuid not null references auth.users,
  action text not null check (action in ('assigned','started','submitted','return','accept','imported')),
  note text not null default '' check(length(note)<=3000),
  created_at timestamptz not null default now()
);
create table public.corrective_evidence (
  id uuid primary key,
  case_id uuid not null references public.cases on delete cascade,
  task_id uuid not null references public.corrective_tasks on delete cascade,
  object_key text not null unique,
  filename text not null,
  created_at timestamptz not null default now(),
  imported_version uuid references public.document_versions on delete set null
);
create index on public.corrective_tasks(case_id);
create index on public.corrective_events(case_id,created_at);
create index on public.corrective_evidence(case_id,created_at);

do $$ declare t text;
begin
  foreach t in array array['corrective_tasks','corrective_events','corrective_evidence'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('create policy case_read on public.%I for select to authenticated using (case_id in
      (select m.case_id from public.case_members m where m.user_id=(select auth.uid()) and m.role in (''reviewer'',''manager'')))',t);
  end loop;
end $$;

create function public.sp_share_manager(cid uuid, actor_id uuid, manager_email text) returns void
language plpgsql security definer set search_path=public as $$
declare person uuid;
begin
  perform sp_write_access(cid,actor_id);
  select id into person from auth.users where lower(email)=lower(manager_email)
    and raw_app_meta_data->>'workspace_role'='factory_manager' and email_confirmed_at is not null;
  if person is null then raise exception 'No confirmed Factory Manager account uses this email' using errcode='PT404'; end if;
  insert into case_members(case_id,user_id,role) values(cid,person,'manager') on conflict do nothing;
  if not exists(select 1 from case_members where case_id=cid and user_id=person and role='manager') then
    raise exception 'This account already has another role in this case' using errcode='PT409';
  end if;
end $$;

create function public.sp_corrective_task(cid uuid, actor_id uuid, payload jsonb) returns uuid
language plpgsql set search_path=public as $$
declare tid uuid;
begin
  perform 1 from cases c join case_members m on m.case_id=c.id and m.user_id=actor_id
    where c.id=cid and m.role in ('manager','reviewer') and not c.archived and not c.deleting for update of c;
  if not found then raise exception 'Corrective work access required' using errcode='42501'; end if;
  insert into corrective_tasks(case_id,title,detail,assignee,due_on,created_by)
    values(cid,payload->>'title',payload->>'detail',payload->>'assignee',(payload->>'due_on')::date,actor_id)
    returning id into tid;
  insert into corrective_events(case_id,task_id,actor,action) values(cid,tid,actor_id,'assigned');
  return tid;
end $$;

create function public.sp_corrective_event(tid uuid, actor_id uuid, event_name text, note text,
  evidence_id uuid default null, original_filename text default null) returns void
language plpgsql set search_path=public as $$
declare task corrective_tasks; member_role text; next_state text;
begin
  select t.* into task from corrective_tasks t join cases c on c.id=t.case_id
    where t.id=tid and not c.archived and not c.deleting for update of c,t;
  if not found then raise exception 'This task is unavailable' using errcode='PT404'; end if;
  select role into member_role from case_members where case_id=task.case_id and user_id=actor_id;
  if member_role is null or member_role not in ('manager','reviewer') then
    raise exception 'Corrective work access required' using errcode='42501';
  end if;
  if event_name in ('started','submitted') and member_role='manager' and task.status in ('assigned','in_progress','needs_revision') then
    if event_name='submitted' then
      if evidence_id is null or original_filename is null then raise exception 'A PDF is required' using errcode='PT409'; end if;
      insert into corrective_evidence(id,case_id,task_id,object_key,filename)
        values(evidence_id,task.case_id,tid,task.case_id::text||'/corrective/'||evidence_id::text||'.pdf',original_filename);
    end if;
    next_state:=case event_name when 'submitted' then 'submitted' else 'in_progress' end;
  elsif event_name in ('return','accept') and member_role='reviewer' and task.status='submitted' then
    next_state:=case event_name when 'return' then 'needs_revision' else 'reviewed' end;
  else
    raise exception 'Your role cannot perform this transition from the current status' using errcode='PT409';
  end if;
  update corrective_tasks set status=next_state where id=tid;
  insert into corrective_events(case_id,task_id,actor,action,note) values(task.case_id,tid,actor_id,event_name,note);
end $$;

create function public.sp_corrective_import(eid uuid, actor_id uuid) returns uuid
language plpgsql set search_path=public as $$
declare evidence corrective_evidence; vid uuid; did uuid; case_factory text;
begin
  select * into strict evidence from corrective_evidence where id=eid;
  perform sp_write_access(evidence.case_id,actor_id);
  select * into strict evidence from corrective_evidence where id=eid for update;
  if evidence.imported_version is not null then
    return (select id from jobs where version_id=evidence.imported_version);
  end if;
  if (select count(*) from documents where case_id=evidence.case_id)>=10 then
    raise exception 'Case limit of ten documents reached' using errcode='PT409';
  end if;
  select factory into case_factory from cases where id=evidence.case_id;
  vid:=gen_random_uuid();
  insert into documents(case_id,title,role) values(evidence.case_id,left(evidence.filename,160),'other') returning id into did;
  insert into document_versions(id,case_id,document_id,revision,filename,object_key,confirmed_factory,issuer)
    values(vid,evidence.case_id,did,1,evidence.filename,evidence.object_key,case_factory,'factory');
  update corrective_evidence set imported_version=vid where id=eid;
  insert into corrective_events(case_id,task_id,actor,action)
    values(evidence.case_id,evidence.task_id,actor_id,'imported');
  return sp_ingest(evidence.case_id,actor_id,vid);
end $$;

revoke all on function public.sp_share_manager(uuid,uuid,text), public.sp_corrective_task(uuid,uuid,jsonb),
  public.sp_corrective_event(uuid,uuid,text,text,uuid,text), public.sp_corrective_import(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sp_share_manager(uuid,uuid,text), public.sp_corrective_task(uuid,uuid,jsonb),
  public.sp_corrective_event(uuid,uuid,text,text,uuid,text), public.sp_corrective_import(uuid,uuid) to service_role;
