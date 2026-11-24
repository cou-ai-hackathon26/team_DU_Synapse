create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  factory text not null check (length(factory) between 1 and 160),
  title text not null, programme text, period_start date, period_end date,
  created_by uuid not null references auth.users, created_at timestamptz not null default now(),
  archived boolean not null default false, deleting boolean not null default false,
  check (period_start is null or period_end is null or period_end >= period_start)
);
create table public.case_members (
  case_id uuid not null references public.cases on delete cascade, user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('reviewer','viewer')), primary key (case_id,user_id)
);
create index on public.case_members(user_id);
create table public.documents (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references public.cases on delete cascade,
  title text not null, role text not null check (role in ('inspection','sop','incident','drill','maintenance','other'))
);
create table public.document_versions (
  id uuid primary key, case_id uuid not null references public.cases on delete cascade,
  document_id uuid not null references public.documents on delete cascade, revision int not null,
  filename text not null, object_key text not null unique, issued_on date, period_start date, period_end date,
  issuer text not null default 'unknown', confirmed_factory text not null,
  status text not null default 'awaiting_upload' check (status in ('awaiting_upload','queued','ready','partial','failed','duplicate')),
  sha256 text, parser text, extraction_id uuid, page_count int not null default 0, readable_pages int not null default 0,
  error text, duplicate_of uuid, created_at timestamptz not null default now(),
  unique(document_id,revision), check (period_end is null or period_start is null or period_end >= period_start)
);
create index on public.document_versions(case_id,sha256);
create table public.pages (
  id uuid primary key, case_id uuid not null references public.cases on delete cascade,
  version_id uuid not null references public.document_versions on delete cascade, page_no int not null check(page_no>0),
  method text not null, quality text not null, text text not null, blocks jsonb not null, unique(version_id,page_no)
);
create table public.chunks (
  id uuid primary key, case_id uuid not null references public.cases on delete cascade,
  version_id uuid not null references public.document_versions on delete cascade,
  page_id uuid not null references public.pages on delete cascade, page_no int not null,
  start_at int not null, end_at int not null, text text not null,
  embedding extensions.vector(768), embedding_model text,
  keywords tsvector generated always as (to_tsvector('simple'::regconfig,text)) stored
);
create index on public.chunks using gin(keywords);
create index on public.chunks(version_id);
create table public.verification_runs (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references public.cases on delete cascade,
  created_by uuid not null references auth.users, created_at timestamptz not null default now(),
  request_key uuid not null, config jsonb not null, status text not null default 'queued',
  manifest jsonb not null, usage jsonb not null default '{}'::jsonb, finished_at timestamptz,
  unique(case_id,request_key)
);
create table public.results (
  id uuid primary key, case_id uuid not null references public.cases on delete cascade,
  run_id uuid not null references public.verification_runs on delete cascade, claim jsonb not null,
  outcome text not null check(outcome in ('contradicted','unsupported','unresolved','supported','needs_review','not_assessed')),
  reason text not null, evidence jsonb not null, coverage jsonb not null, checks jsonb not null,
  created_at timestamptz not null default now()
);
create index on public.results(run_id);
create table public.review_events (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references public.cases on delete cascade,
  result_id uuid not null references public.results on delete cascade, actor uuid not null references auth.users,
  action text not null check(action in ('accept','dismiss','request_evidence','comment')),
  comment text not null default '', created_at timestamptz not null default now()
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(), case_id uuid not null references public.cases on delete cascade,
  actor uuid not null references auth.users, kind text not null check(kind in ('ingest','verify')),
  version_id uuid unique references public.document_versions on delete cascade,
  run_id uuid unique references public.verification_runs on delete cascade,
  state text not null default 'queued', stage text not null default 'Waiting', completed int not null default 0,
  total int not null default 0, attempts int not null default 0, error text, available_at timestamptz not null default now(),
  created_at timestamptz not null default now(), lease uuid, lease_until timestamptz,
  check((kind='ingest' and version_id is not null and run_id is null) or (kind='verify' and run_id is not null and version_id is null))
);
create index on public.jobs(state,available_at,created_at);
-- Only the worker can read cached model responses. Case deletion removes these too.
create table public.analysis_cache (
  case_id uuid not null references public.cases on delete cascade, key text not null,
  value jsonb not null, primary key(case_id,key)
);

alter table public.case_members enable row level security;
create policy own_membership on public.case_members for select to authenticated using(user_id=(select auth.uid()));
alter table public.cases enable row level security;
create policy case_read on public.cases for select to authenticated using(exists
  (select 1 from public.case_members m where m.case_id=id and m.user_id=(select auth.uid())));
do $$
declare t text;
begin
  foreach t in array array['documents','document_versions','pages','chunks','verification_runs','results','review_events','jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy case_read on public.%1$I for select to authenticated using (case_id in (select m.case_id from public.case_members m where m.user_id=(select auth.uid())))',t);
  end loop;
  foreach t in array array['cases','case_members','documents','document_versions','pages','chunks','verification_runs','results','review_events','jobs','analysis_cache'] loop
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    if t <> 'analysis_cache' and t <> 'jobs' then execute format('grant select on public.%I to authenticated',t); end if;
  end loop;
end $$;
grant select(id,case_id,actor,kind,version_id,run_id,state,stage,completed,total,attempts,error,created_at,available_at) on public.jobs to authenticated;
alter table public.analysis_cache enable row level security;

-- Originals are streamed through signed, single-object grants. No browser role has bucket write policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('evidence','evidence',false,10485760,array['application/pdf']) on conflict(id) do nothing;
