create or replace function public.sp_enforce_follow_up_date_order()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  previous_inspection_date date;
begin
  if new.inspection_kind <> 'follow_up' then
    return new;
  end if;

  select inspection_on into previous_inspection_date
  from public.cases
  where id = new.follow_up_of
    and factory_id = new.factory_id;

  if previous_inspection_date is null then
    raise exception 'A follow-up must point to an earlier scheduled inspection for the same factory.'
      using errcode = '23514';
  end if;

  if new.inspection_on is null or new.inspection_on <= previous_inspection_date then
    raise exception 'The follow-up inspection date must be after the previous inspection date.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists cases_follow_up_date_order on public.cases;
create trigger cases_follow_up_date_order
before insert or update of inspection_kind, follow_up_of, factory_id, inspection_on
on public.cases
for each row execute function public.sp_enforce_follow_up_date_order();
