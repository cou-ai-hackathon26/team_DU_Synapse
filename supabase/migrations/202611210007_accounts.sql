create extension if not exists pgcrypto with schema extensions;
create table public.factories (
  id uuid primary key default gen_random_uuid(), name text unique not null, address text not null
);
insert into public.factories(name,address) values
 ('Shaluk Threadworks Ltd.','Plot 12, Shaluk Industrial Lane, Gazipur'),
 ('Meghdubi Knitcraft Ltd.','Plot 24, Meghdubi Works Road, Gazipur'),
 ('Doyel Loomwear Ltd.','Plot 8, Doyel Industrial Lane, Savar'),
 ('Karnaphuli Stitchworks Ltd.','Plot 16, Riverside Works Lane, Chattogram'),
 ('Bunon Creek Apparels Ltd.','Plot 31, Bunon Industrial Road, Narayanganj'),
 ('Rupsha Weavecraft Ltd.','Plot 14, Rupsha Works Lane, Khulna'),
 ('Titas Needleworks Ltd.','Plot 21, Titas Industrial Lane, Cumilla'),
 ('Kadam Cottonworks Ltd.','Plot 9, Kadam Works Road, Mymensingh')
on conflict(name) do nothing;

create table public.account_profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null unique, full_name text not null,
  role text not null check(role in ('admin','reviewer','factory_manager','viewer')),
  status text not null check(status in ('pending','pending_approval','active','rejected','deactivated')),
  organization text, role_type text, phone text, job_title text,
  requested_factory_id uuid references public.factories,
  factory_id uuid references public.factories,
  id_card_path text, id_card_type text, id_card_deleted_at timestamptz,
  id_card_number text, membership_number text, consent_at timestamptz,
  reject_reason text, created_at timestamptz not null default now(),
  check(role <> 'factory_manager' or status <> 'active' or factory_id is not null)
);
create table public.reviewer_factories (
  reviewer_id uuid references public.account_profiles on delete cascade,
  factory_id uuid references public.factories on delete cascade,
  primary key(reviewer_id,factory_id)
);
create table public.reviewer_invites (
  reviewer_id uuid primary key references public.account_profiles on delete cascade,
  token_hash text unique not null, expires_at timestamptz not null, used_at timestamptz
);
create table public.account_audit (
  id bigint generated always as identity primary key, actor uuid not null,
  account_id uuid not null, action text not null, reason text,
  created_at timestamptz not null default now()
);
create table public.account_rate_limits (
  scope text not null, key_hash text not null, window_start timestamptz not null,
  attempts int not null, primary key(scope,key_hash,window_start)
);
do $$ declare t text;
begin
  foreach t in array array['factories','account_profiles','reviewer_factories','reviewer_invites','account_audit','account_rate_limits'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
alter table public.cases add column factory_id uuid references public.factories;
insert into public.factories(name,address)
 select distinct factory,'Address not recorded' from public.cases
on conflict(name) do nothing;
update public.cases c set factory_id=f.id from public.factories f where f.name=c.factory;
-- Preserve existing accounts and audit history. Each legacy manager gets one binding.
insert into public.account_profiles(id,email,full_name,role,status,factory_id,created_at)
select u.id,lower(u.email),split_part(u.email,'@',1),
 case when u.raw_app_meta_data->>'workspace_role'='factory_manager' then 'factory_manager'
      when exists(select 1 from case_members m where m.user_id=u.id and m.role='viewer')
       and not exists(select 1 from case_members m where m.user_id=u.id and m.role='reviewer') then 'viewer'
      else 'reviewer' end,
 'active',
 case when u.raw_app_meta_data->>'workspace_role'='factory_manager' then coalesce(
   (select c.factory_id from case_members m join cases c on c.id=m.case_id
    where m.user_id=u.id and m.role='manager' and c.factory_id is not null order by c.created_at limit 1),
   (select id from factories where name='Shaluk Threadworks Ltd.')) end,
 u.created_at
from auth.users u where u.email is not null;
insert into public.reviewer_factories
 select distinct m.user_id,c.factory_id from case_members m join cases c on c.id=m.case_id
 join account_profiles p on p.id=m.user_id where p.role='reviewer' and m.role='reviewer';

-- Auth Admin creates the identity without a password. This transaction enables
-- credentials and sets the profile together, so an incomplete account cannot log in.
create function public.sp_register_profile(uid uuid, p jsonb, secret text) returns void
language plpgsql security definer set search_path=public,extensions as $$
declare login_email text;
begin
  select lower(email) into strict login_email from auth.users where id=uid for update;
  insert into account_profiles(id,email,full_name,role,status,organization,role_type,phone,job_title,
    requested_factory_id,factory_id,id_card_path,id_card_type,id_card_number,membership_number,consent_at)
  values(uid,login_email,p->>'full_name',p->>'role',p->>'status',p->>'organization',p->>'role_type',
    p->>'phone',p->>'job_title',(p->>'requested_factory_id')::uuid,(p->>'factory_id')::uuid,
    p->>'id_card_path',p->>'id_card_type',p->>'id_card_number',p->>'membership_number',
    (p->>'consent_at')::timestamptz);
  update auth.users
  set encrypted_password=case when secret is not null then extensions.crypt(secret,extensions.gen_salt('bf',10)) else null end,
      banned_until=case when p->>'status'='active' then null else '9999-12-31 UTC'::timestamptz end, updated_at=now()
  where id=uid;
end $$;
revoke all on function public.sp_register_profile(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.sp_register_profile(uuid,jsonb,text) to service_role;

create function public.sp_account_access(cid uuid) returns boolean
language sql stable security definer set search_path=public as $$
 select exists(select 1 from account_profiles p where p.id=(select auth.uid()) and p.status='active'
  and (p.role <> 'factory_manager' or exists(select 1 from cases c where c.id=cid and c.factory_id=p.factory_id)));
$$;
do $$ declare t text;
begin
  foreach t in array array['cases','case_members','documents','document_versions','pages','chunks','verification_runs','results','review_events','cap_review_events','jobs','corrective_tasks','corrective_events','corrective_evidence'] loop
    execute format('create policy active_account on public.%I as restrictive for select to authenticated using (sp_account_access(%I))',t,case when t='cases' then 'id' else 'case_id' end);
  end loop;
end $$;

create function public.sp_account_rate(scope_name text, hashed_key text, limit_count int) returns boolean
language plpgsql set search_path=public as $$
declare n int;
begin
  delete from account_rate_limits where window_start < now()-interval '1 hour';
  insert into account_rate_limits values(scope_name,hashed_key,date_bin(interval '15 minutes',now(),'2026-01-01'::timestamptz),1)
  on conflict(scope,key_hash,window_start) do update set attempts=account_rate_limits.attempts+1
  returning attempts into n;
  return n<=limit_count;
end $$;

create function public.sp_invite_issue(uid uuid, digest text) returns void
language plpgsql set search_path=public as $$
begin
  perform 1 from account_profiles where id=uid and role='reviewer' and status='pending' for update;
  if not found then raise exception 'Only pending reviewers can receive an invite' using errcode='PT409'; end if;
  insert into reviewer_invites values(uid,digest,now()+interval '48 hours',null)
  on conflict(reviewer_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at,used_at=null;
end $$;

create function public.sp_invite_accept(digest text, new_password text) returns void
language plpgsql security definer set search_path=public,extensions as $$
declare uid uuid;
begin
  select reviewer_id into uid from reviewer_invites where token_hash=digest;
  perform 1 from account_profiles where id=uid and role='reviewer' and status='pending' for update;
  if not found then raise exception 'Invite invalid or expired. Ask the admin for a new link.' using errcode='PT400'; end if;
  update reviewer_invites set used_at=now() where reviewer_id=uid and token_hash=digest and used_at is null and expires_at>now();
  if not found then raise exception 'Invite invalid or expired. Ask the admin for a new link.' using errcode='PT400'; end if;
  update auth.users set encrypted_password=extensions.crypt(new_password,extensions.gen_salt('bf',10)),banned_until=null,updated_at=now() where id=uid;
  update account_profiles set status='active' where id=uid;
end $$;

create function public.sp_inactive_login(login_email text, secret text) returns jsonb
language sql stable security definer set search_path=public,extensions as $$
 select jsonb_build_object('status',p.status,'reason',p.reject_reason)
 from account_profiles p join auth.users u on u.id=p.id
 where p.email=login_email and p.status<>'active' and nullif(u.encrypted_password,'') is not null
 and extensions.crypt(secret,u.encrypted_password)=u.encrypted_password;
$$;

create function public.sp_account_decide(actor_id uuid, uid uuid, choice text, factory uuid, note text) returns text
language plpgsql security definer set search_path=public as $$
declare p account_profiles; next_status text;
begin
  perform 1 from account_profiles where id=actor_id and role='admin' and status='active' for share;
  if not found then raise exception 'Administrator access required' using errcode='PT403'; end if;
  select * into p from account_profiles where id=uid for update;
  if found and p.id_card_path is not null and ((choice='approve' and p.status='active' and p.factory_id=factory) or (choice='reject' and p.status='rejected') or (choice='deactivate' and p.status='deactivated')) then return p.id_card_path; end if;
  if not found or p.role not in ('reviewer','factory_manager') then raise exception 'Account unavailable' using errcode='PT404'; end if;
  if choice='approve' and p.role='factory_manager' and p.status='pending_approval' then
    perform 1 from factories f where f.id=sp_account_decide.factory for update;
    if not found then raise exception 'Choose an existing factory' using errcode='PT422'; end if;
    next_status:='active';
  elsif choice='reject' and p.role='factory_manager' and p.status='pending_approval' and coalesce(length(trim(note)),0)>0 then
    next_status:='rejected';
  elsif choice='deactivate' and p.status in ('active','pending') then
    next_status:='deactivated';
  else raise exception 'This account cannot make that transition' using errcode='PT409';
  end if;
  update account_profiles set status=next_status,
    factory_id=case when choice='approve' then factory else p.factory_id end,
    reject_reason=case when choice='reject' then note else p.reject_reason end
    where id=uid;
  update auth.users set banned_until=case when next_status='active' then null else '9999-12-31 UTC'::timestamptz end where id=uid;
  if next_status<>'active' then delete from auth.sessions where user_id=uid; end if;
  if choice='deactivate' then delete from reviewer_invites where reviewer_id=uid; end if;
  if choice='approve' then
    insert into case_members(case_id,user_id,role)
    select c.id,uid,'manager' from cases c where c.factory_id=sp_account_decide.factory and not c.deleting on conflict do nothing;
  end if;
  insert into account_audit(actor,account_id,action,reason) values(actor_id,uid,choice,note);
  return p.id_card_path;
end $$;

create function public.sp_case_factory() returns trigger language plpgsql set search_path=public as $$
begin
 select id into new.factory_id from factories where name=new.factory for share;
 return new;
end $$;
create trigger sp_case_factory before insert on public.cases for each row execute function public.sp_case_factory();
create function public.sp_attach_managers() returns trigger language plpgsql set search_path=public as $$
begin
 insert into case_members(case_id,user_id,role)
 select new.id,id,'manager' from account_profiles where role='factory_manager' and status='active' and factory_id=new.factory_id on conflict do nothing;
 return new;
end $$;
create trigger sp_attach_managers after insert on public.cases for each row execute function public.sp_attach_managers();
insert into case_members(case_id,user_id,role)
select c.id,p.id,'manager' from cases c join account_profiles p on p.factory_id=c.factory_id
where p.role='factory_manager' and p.status='active' on conflict do nothing;

create or replace function public.sp_share_manager(cid uuid, actor_id uuid, manager_email text) returns void
language plpgsql security definer set search_path=public as $$
declare person uuid;
begin
 perform sp_write_access(cid,actor_id);
 select p.id into person from account_profiles p join cases c on c.factory_id=p.factory_id
 where c.id=cid and p.email=lower(manager_email) and p.role='factory_manager' and p.status='active';
 if person is null then raise exception 'No active manager for this factory uses that email' using errcode='PT404'; end if;
 insert into case_members(case_id,user_id,role) values(cid,person,'manager') on conflict do nothing;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('manager-id-cards','manager-id-cards',false,5242880,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do nothing;

revoke all on function public.sp_account_rate(text,text,int),public.sp_invite_issue(uuid,text),
 public.sp_invite_accept(text,text), public.sp_inactive_login(text,text),public.sp_account_decide(uuid,uuid,text,uuid,text)
 from public,anon,authenticated;
grant execute on function public.sp_account_rate(text,text,int),public.sp_invite_issue(uuid,text),
 public.sp_invite_accept(text,text), public.sp_inactive_login(text,text),public.sp_account_decide(uuid,uuid,text,uuid,text) to service_role;

create table public.card_claims(path text primary key, claimed_at timestamptz not null default now());
alter table public.card_claims enable row level security;
revoke all on public.card_claims from public,anon,authenticated;
grant all on public.card_claims to service_role;
create function public.sp_card_claim(card_path text) returns boolean
language plpgsql set search_path=public as $$
begin
 insert into card_claims(path) values(card_path) on conflict do nothing;
 return found;
end $$;

create function public.sp_reviewer_assign(uid uuid, factories uuid[]) returns void
language plpgsql set search_path=public as $$
begin
 perform 1 from account_profiles where id=uid and role='reviewer' for update;
 if not found then raise exception 'Reviewer unavailable' using errcode='PT404'; end if;
 if exists(select 1 from unnest(factories) f(id) where not exists(select 1 from public.factories x where x.id=f.id)) then
  raise exception 'Choose existing factories' using errcode='PT422';
 end if;
 delete from reviewer_factories where reviewer_id=uid;
 insert into reviewer_factories select uid,unnest(factories);
 delete from case_members m using cases c where m.user_id=uid and m.role='reviewer' and m.case_id=c.id
  and not coalesce(c.factory_id=any(factories),false);
 insert into case_members(case_id,user_id,role) select id,uid,'reviewer' from cases
  where factory_id=any(factories) and not deleting on conflict do nothing;
end $$;

create or replace function public.sp_attach_managers() returns trigger language plpgsql set search_path=public as $$
begin
 insert into case_members(case_id,user_id,role)
 select new.id,id,'manager' from account_profiles where role='factory_manager' and status='active' and factory_id=new.factory_id on conflict do nothing;
 insert into case_members(case_id,user_id,role)
 select new.id,reviewer_id,'reviewer' from reviewer_factories where factory_id=new.factory_id on conflict do nothing;
 return new;
end $$;

create or replace function public.sp_create_case(actor_id uuid, data jsonb) returns public.cases
language plpgsql set search_path=public as $$
declare c cases;
begin
  insert into cases(factory,title,programme,period_start,period_end,created_by) values
    (data->>'factory',data->>'title',data->>'programme',(data->>'period_start')::date,(data->>'period_end')::date,actor_id) returning * into c;
  insert into case_members values(c.id,actor_id,'reviewer') on conflict do nothing;
  return c;
end $$;

create function public.sp_factory_overview() returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(to_jsonb(summary) order by name),'[]'::jsonb) from (
  select f.id,f.name,f.address,
  (select count(*) from account_profiles p where p.factory_id=f.id and p.role='factory_manager' and p.status='active') as managers,
  (select count(*) from reviewer_factories rf join account_profiles p on p.id=rf.reviewer_id where rf.factory_id=f.id and p.status='active') as reviewers,
  (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'archived',c.archived,
   'findings',(select coalesce(jsonb_object_agg(x.outcome,x.n),'{}') from
     (select outcome,count(*) n from results where run_id=(select id from verification_runs where case_id=c.id and status in ('complete','partial') order by created_at desc,id desc limit 1) group by outcome) x),
   'open_tasks',(select count(*) from corrective_tasks where case_id=c.id and status<>'reviewed')
  ) order by c.created_at desc),'[]') from cases c where c.factory_id=f.id and not c.deleting) as cases
  from factories f
 ) summary;
$$;
revoke all on function public.sp_card_claim(text),public.sp_reviewer_assign(uuid,uuid[]),public.sp_factory_overview() from public,anon,authenticated;
grant execute on function public.sp_card_claim(text),public.sp_reviewer_assign(uuid,uuid[]),public.sp_factory_overview() to service_role;

alter table public.corrective_events drop constraint corrective_events_action_check;
alter table public.corrective_events add constraint corrective_events_action_check check(action in ('assigned','started','submitted','return','accept','imported','comment'));
create or replace function public.sp_corrective_task(cid uuid, actor_id uuid, payload jsonb) returns uuid
language plpgsql set search_path=public as $$
declare tid uuid;
begin
  perform 1 from cases c join case_members m on m.case_id=c.id and m.user_id=actor_id
    where c.id=cid and m.role='reviewer' and not c.archived and not c.deleting for update of c;
  if not found then raise exception 'Corrective work access required' using errcode='42501'; end if;
  insert into corrective_tasks(case_id,title,detail,assignee,due_on,created_by)
    values(cid,payload->>'title',payload->>'detail',payload->>'assignee',(payload->>'due_on')::date,actor_id)
    returning id into tid;
  insert into corrective_events(case_id,task_id,actor,action) values(cid,tid,actor_id,'assigned');
  return tid;
end $$;

create or replace function public.sp_corrective_event(tid uuid, actor_id uuid, event_name text, note text,
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
  if event_name='comment' and member_role='manager' and length(trim(note))>0 then
    next_state:=task.status;
  elsif event_name in ('started','submitted') and member_role='manager' and task.status in ('assigned','in_progress','needs_revision') then
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
