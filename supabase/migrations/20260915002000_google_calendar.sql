-- Google Calendar connection (docs/DEVIATIONS.md D47,
-- docs/superpowers/specs/2026-09-18-google-calendar-connection-design.md).

-- ---------------------------------------------------------------------------------------------
-- 1. Bookable hours, set in the CRM and read in settings.default_timezone
-- ---------------------------------------------------------------------------------------------
create table public.bookable_hours (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null constraint bookable_hours_weekday_range check (weekday between 0 and 6),
  starts_minute integer not null
    constraint bookable_hours_starts_range check (starts_minute between 0 and 1410)
    constraint bookable_hours_starts_granularity check (starts_minute % 30 = 0),
  ends_minute integer not null
    constraint bookable_hours_ends_range check (ends_minute between 30 and 1440)
    constraint bookable_hours_ends_granularity check (ends_minute % 30 = 0),
  constraint bookable_hours_order check (starts_minute < ends_minute)
);

alter table public.bookable_hours enable row level security;

-- Every active user may read them: the booking panel needs the windows. Writes go through the RPC.
create policy bookable_hours_select on public.bookable_hours
  for select to authenticated
  using (public.is_active_user());

grant select on public.bookable_hours to authenticated;

insert into public.bookable_hours (weekday, starts_minute, ends_minute)
select d, s.starts_minute, s.ends_minute
  from generate_series(1, 5) as d,
       (values (600, 720), (840, 1020)) as s(starts_minute, ends_minute);

-- Replaces the whole week atomically. p_rows: [{"weekday":1,"starts_minute":600,"ends_minute":720}, ...]
-- PGlite note: the original design used `create temporary table ... on commit drop` to stage and
-- validate the rows before replacing the week. PGlite's single-session backend does not reliably support
-- temporary tables created and dropped inside a function call (the `on commit drop` lifecycle), so this
-- validates directly against two independent reads of p_rows via jsonb_array_elements(...) with
-- ordinality (the ordinal position stands in for the temp table's ctid, distinguishing two rows with
-- identical values from the same row compared to itself) instead of materializing a temp table. The
-- validation semantics and error codes are unchanged.
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

  delete from public.bookable_hours;
  insert into public.bookable_hours (weekday, starts_minute, ends_minute)
  select (elem ->> 'weekday')::smallint, (elem ->> 'starts_minute')::integer, (elem ->> 'ends_minute')::integer
    from jsonb_array_elements(p_rows) as elem;
end;
$$;
revoke execute on function public.set_bookable_hours(jsonb) from public, anon;
grant execute on function public.set_bookable_hours(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The connection: the app's own calendar replaces milestone 1's bookable calendar
-- ---------------------------------------------------------------------------------------------
alter table public.calendar_connection rename column bookable_calendar_id to app_calendar_id;

create or replace function public.connect_calendar(p_email text, p_ciphertext text, p_app_calendar_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_email), '') = '' or coalesce(btrim(p_ciphertext), '') = '' then
    raise exception 'invalid_connection' using errcode = 'P0001';
  end if;

  insert into public.calendar_connection (id, google_email, refresh_token_ciphertext, app_calendar_id, connected_by, connected_at, broken_at)
  values (true, btrim(p_email), p_ciphertext, nullif(btrim(p_app_calendar_id), ''), auth.uid(), now(), null)
  on conflict (id) do update
     set google_email = excluded.google_email,
         refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         app_calendar_id = excluded.app_calendar_id,
         connected_by = excluded.connected_by,
         connected_at = excluded.connected_at,
         broken_at = null;
end;
$$;
revoke execute on function public.connect_calendar(text, text, text) from public, anon;
grant execute on function public.connect_calendar(text, text, text) to authenticated, service_role;

create or replace function public.disconnect_calendar()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.calendar_connection;
end;
$$;
revoke execute on function public.disconnect_calendar() from public, anon;
grant execute on function public.disconnect_calendar() to authenticated, service_role;

-- Called by the server when Google refuses the refresh token. Any active user's booking attempt can
-- discover it, so this is not admin-only; it only ever sets a flag.
create or replace function public.mark_calendar_broken()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.calendar_connection set broken_at = now() where broken_at is null;
end;
$$;
revoke execute on function public.mark_calendar_broken() from public, anon;
grant execute on function public.mark_calendar_broken() to authenticated, service_role;

-- Replaces milestone 1's version: reports the hours and the app calendar, never the token.
drop function if exists public.get_calendar_status();
create or replace function public.get_calendar_status()
returns table (connected boolean, google_email text, hours_set boolean, broken boolean, app_calendar_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select true, c.google_email, exists (select 1 from public.bookable_hours), c.broken_at is not null, c.app_calendar_id
      from public.calendar_connection c
    union all
    select false, null::text, exists (select 1 from public.bookable_hours), false, null::text
     where not exists (select 1 from public.calendar_connection);
end;
$$;
revoke execute on function public.get_calendar_status() from public, anon;
grant execute on function public.get_calendar_status() to authenticated, service_role;
