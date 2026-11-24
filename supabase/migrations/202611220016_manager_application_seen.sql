alter table public.account_profiles
  add column manager_application_seen_at timestamptz;

-- Existing applications are already in the admin workspace; only future
-- submissions should raise a new-application dot.
update public.account_profiles
set manager_application_seen_at = created_at
where role = 'factory_manager'
  and manager_application_seen_at is null;
