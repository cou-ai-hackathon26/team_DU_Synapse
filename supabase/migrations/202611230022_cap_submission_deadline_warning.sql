alter table public.document_versions
  add column if not exists cap_deadline_warning text;
