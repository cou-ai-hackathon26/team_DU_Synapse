alter table public.documents drop constraint documents_role_check;
alter table public.documents add constraint documents_role_check
  check (role in ('inspection','sop','incident','drill','maintenance','cap','other'));

alter table public.verification_runs add column cap_analysis jsonb;

create table public.cap_review_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  run_id uuid not null references public.verification_runs on delete cascade,
  finding_id uuid not null references public.results on delete cascade,
  action_id uuid not null,
  actor uuid not null references auth.users,
  decision text not null check (decision in ('confirm','dismiss')),
  comment text not null default '' check (length(comment) <= 3000),
  created_at timestamptz not null default now()
);
create index on public.cap_review_events(run_id,created_at);
alter table public.cap_review_events enable row level security;
revoke all on public.cap_review_events from public, anon, authenticated;
grant select on public.cap_review_events to authenticated;
grant all on public.cap_review_events to service_role;
create policy case_read on public.cap_review_events for select to authenticated using (
  case_id in (select m.case_id from public.case_members m where m.user_id=(select auth.uid()))
);

create function public.sp_cap_publish(jid uuid, ticket uuid, analysis jsonb) returns void
language plpgsql set search_path=public as $$
declare rid uuid;
begin
  perform sp_step(jid,ticket,'progress','{"stage":"Saving CAP matches"}');
  select run_id into strict rid from jobs where id=jid and kind='verify';
  update verification_runs set cap_analysis=analysis where id=rid;
end $$;

create function public.sp_cap_review(rid uuid, actor_id uuid, finding uuid, cap_action uuid, choice text, note text)
returns uuid language plpgsql set search_path=public as $$
declare v verification_runs; eid uuid;
begin
  select * into strict v from verification_runs where id=rid;
  perform sp_write_access(v.case_id,actor_id);
  if v.status not in ('complete','partial') or v.cap_analysis is null then
    raise exception 'A completed CAP snapshot is required' using errcode='PT409';
  end if;
  if not exists (select 1 from results where id=finding and run_id=rid and claim->>'kind'='finding')
      or not exists (select 1 from jsonb_array_elements(v.cap_analysis->'actions') e where e->>'id'=cap_action::text) then
    raise exception 'Both sources must belong to this run' using errcode='PT409';
  end if;
  insert into cap_review_events(case_id,run_id,finding_id,action_id,actor,decision,comment)
    values(v.case_id,rid,finding,cap_action,actor_id,choice,note) returning id into eid;
  return eid;
end $$;

revoke all on function public.sp_cap_publish(uuid,uuid,jsonb), public.sp_cap_review(uuid,uuid,uuid,uuid,text,text)
from public, anon, authenticated;
grant execute on function public.sp_cap_publish(uuid,uuid,jsonb), public.sp_cap_review(uuid,uuid,uuid,uuid,text,text) to service_role;
