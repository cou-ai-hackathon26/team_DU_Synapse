create table public.reviewer_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  case_id uuid not null references public.cases on delete cascade,
  document_id uuid not null references public.documents on delete cascade,
  version_id uuid not null references public.document_versions on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, version_id)
);

create index reviewer_notifications_user_created_idx
  on public.reviewer_notifications(user_id, created_at desc);
create index reviewer_notifications_unread_idx
  on public.reviewer_notifications(user_id, created_at desc)
  where read_at is null;

alter table public.reviewer_notifications enable row level security;
create policy reviewer_notifications_read_own
  on public.reviewer_notifications for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.reviewer_notifications from public, anon, authenticated;
grant select on public.reviewer_notifications to authenticated;
grant all on public.reviewer_notifications to service_role;

-- Existing factory uploads should also alert the case's assigned reviewer when
-- this migration is first deployed, rather than only notifying on future uploads.
insert into public.reviewer_notifications (
  user_id, case_id, document_id, version_id, title, body, created_at
)
select
  c.reviewer_id,
  v.case_id,
  v.document_id,
  v.id,
  'Factory evidence uploaded',
  d.title || ' was uploaded for ' || c.factory || '.',
  v.created_at
from public.document_versions v
join public.documents d on d.id = v.document_id and d.case_id = v.case_id
join public.cases c on c.id = v.case_id
where v.issuer = 'factory'
  and v.status in ('queued', 'ready', 'partial')
  and c.reviewer_id is not null
  and d.deleted_at is null
on conflict (user_id, version_id) do nothing;
