-- Keep the explicit weekday filter required by production safe-update checks.
-- Preserve the admin guard, validation and transactional replacement of the week.
create or replace function public.set_bookable_hours(p_rows jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  with t as (
    select (elem ->> 'weekday')::smallint as weekday,
           (elem ->> 'starts_minute')::integer as starts_minute,
           (elem ->> 'ends_minute')::integer as ends_minute
      from jsonb_array_elements(p_rows) with ordinality as arr(elem, idx)
  )
  select count(*) into v_count
    from t
   where t.weekday is null or t.weekday < 0 or t.weekday > 6
      or t.starts_minute is null or t.ends_minute is null
      or t.starts_minute < 0 or t.ends_minute > 1440
      or t.starts_minute >= t.ends_minute
      or t.starts_minute % 30 <> 0 or t.ends_minute % 30 <> 0;
  if v_count > 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  with t as (
    select (elem ->> 'weekday')::smallint as weekday,
           (elem ->> 'starts_minute')::integer as starts_minute,
           (elem ->> 'ends_minute')::integer as ends_minute,
           idx
      from jsonb_array_elements(p_rows) with ordinality as arr(elem, idx)
  )
  select count(*) into v_count
    from t a
    join t b
      on a.weekday = b.weekday
     and a.idx <> b.idx
     and a.starts_minute < b.ends_minute
     and b.starts_minute < a.ends_minute;
  if v_count > 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  delete from public.bookable_hours where weekday between 0 and 6;
  insert into public.bookable_hours (weekday, starts_minute, ends_minute)
  select (elem ->> 'weekday')::smallint, (elem ->> 'starts_minute')::integer, (elem ->> 'ends_minute')::integer
    from jsonb_array_elements(p_rows) as elem;
end;
$$;
revoke execute on function public.set_bookable_hours(jsonb) from public, anon;
grant execute on function public.set_bookable_hours(jsonb) to authenticated, service_role;
