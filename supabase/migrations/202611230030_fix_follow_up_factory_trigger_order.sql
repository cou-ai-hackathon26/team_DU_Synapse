-- The date-order trigger can run before the factory_id-population trigger.
-- Compare the selected factory name, which is already present on NEW, instead.
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

  select c.inspection_on into previous_inspection_date
  from public.cases as c
  where c.id = new.follow_up_of
    and lower(trim(c.factory)) = lower(trim(new.factory));

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
