alter table public.cases add column manager_notified_at timestamptz;

-- Preserve dashboard notices for inspections that were already scheduled.
update public.cases
set manager_notified_at = created_at
where inspection_on is not null and manager_notified_at is null;
