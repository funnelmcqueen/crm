-- Closer calendar booking (docs/DEVIATIONS.md D46,
-- docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md).

-- ---------------------------------------------------------------------------------------------
-- 1. Business type
-- ---------------------------------------------------------------------------------------------
create type public.business_type as enum (
  'restaurant', 'cafe_bakery', 'hotel_motel', 'home_services', 'auto', 'retail', 'beauty', 'other'
);

-- Null means "guess from the business name" (src/lib/domain/business-type.ts).
alter table public.leads add column business_type public.business_type;

-- Agents may change only status and notes by direct update (leads_guard), so a correction from the
-- booking panel goes through this guarded function. Admin: any lead. Agent: leads assigned to them.
create or replace function public.set_lead_business_type(p_lead_id uuid, p_type public.business_type default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.leads l
     set business_type = p_type
   where l.id = p_lead_id
     and (public.is_admin() or l.assigned_to = v_uid);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Bulk action on All Leads (admin), same shape as bulk_set_lead_source (D41). Null clears.
create or replace function public.bulk_set_business_type(p_lead_ids uuid[], p_type public.business_type default null)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  with changed as (
    update public.leads l
       set business_type = p_type
     where l.id = any (v_ids)
       and l.business_type is distinct from p_type
    returning l.id
  )
  select count(*)::integer into v_count from changed;
  return v_count;
end;
$$;

revoke execute on function public.set_lead_business_type(uuid, public.business_type) from public, anon;
revoke execute on function public.bulk_set_business_type(uuid[], public.business_type) from public, anon;
grant execute on function public.set_lead_business_type(uuid, public.business_type) to authenticated, service_role;
grant execute on function public.bulk_set_business_type(uuid[], public.business_type) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Appointments
-- ---------------------------------------------------------------------------------------------
create type public.appointment_status as enum ('pending', 'scheduled', 'cancelled');

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  booked_by uuid not null references public.profiles (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.appointment_status not null default 'pending',
  google_event_id text constraint appointments_google_event_id_key unique,
  note text constraint appointments_note_length check (char_length(note) <= 500),
  client_request_id uuid not null constraint appointments_client_request_id_key unique,
  created_at timestamptz not null default now(),
  constraint appointments_thirty_minutes check (ends_at = starts_at + interval '30 minutes')
);

create index appointments_starts_at_idx on public.appointments (starts_at);
-- Every appointment is 30 minutes on a :00/:30 boundary, so this makes two live bookings of one slot
-- impossible, whatever the timing between two agents.
create unique index appointments_live_start_key on public.appointments (starts_at)
  where status in ('pending', 'scheduled');

alter table public.appointments enable row level security;
revoke all on public.appointments from anon, authenticated;
grant select on public.appointments to authenticated;

-- An agent reads the appointments they booked; an admin reads all. Writes go through the RPCs below.
create policy appointments_select on public.appointments
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_active_user()) and appointments.booked_by = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------------------------
-- 3. Calendar connection (singleton). Service role only; Plan 2 writes it.
-- ---------------------------------------------------------------------------------------------
create table public.calendar_connection (
  id boolean primary key default true constraint calendar_connection_singleton check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  bookable_calendar_id text,
  connected_by uuid not null references public.profiles (id) on delete restrict,
  connected_at timestamptz not null default now(),
  broken_at timestamptz
);

alter table public.calendar_connection enable row level security;
revoke all on public.calendar_connection from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Rate limit bucket for bookings (body of 20260915001300, plus book_appointment)
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_rate_limit(p_user_id uuid, p_bucket text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_window interval;
  v_count integer;
begin
  case p_bucket
    when 'voice_token' then
      v_max := 20;
      v_window := interval '10 minutes';
    when 'outbound_call' then
      v_max := 12;
      v_window := interval '1 minute';
    when 'export' then
      v_max := 30;
      v_window := interval '10 minutes';
    when 'book_appointment' then
      v_max := 20;
      v_window := interval '1 hour';
    else
      raise exception 'invalid bucket' using errcode = '22023';
  end case;
  if p_user_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || p_bucket, 0));

  delete from public.rate_limit_hits h
   where h.user_id = p_user_id
     and h.bucket = p_bucket
     and h.created_at <= now() - v_window;

  select count(*)::integer into v_count
    from public.rate_limit_hits h
   where h.user_id = p_user_id
     and h.bucket = p_bucket;

  if v_count >= v_max then
    return false;
  end if;

  insert into public.rate_limit_hits (user_id, bucket) values (p_user_id, p_bucket);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Booking RPCs
-- ---------------------------------------------------------------------------------------------
create or replace function public.begin_appointment(
  p_lead_id uuid,
  p_starts_at timestamptz,
  p_note text default null,
  p_client_request_id uuid default null
)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status public.lead_status;
  v_row public.appointments;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lead_id is null or p_starts_at is null or p_client_request_id is null then
    raise exception 'invalid appointment' using errcode = '22023';
  end if;

  -- A replay of the same attempt returns what it created, before anything else can fail or count.
  select * into v_row
    from public.appointments a
   where a.client_request_id = p_client_request_id
     and a.booked_by = v_uid;
  if found then
    return v_row;
  end if;

  if (extract(epoch from p_starts_at)::bigint % 1800) <> 0 or p_starts_at < now() then
    raise exception 'invalid slot' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  select l.status into v_status
    from public.leads l
   where l.id = p_lead_id
     and (public.is_admin() or l.assigned_to = v_uid);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_status = 'DO_NOT_CONTACT' then
    raise exception 'do_not_contact' using errcode = 'P0001';
  end if;

  if not public.apply_rate_limit(v_uid, 'book_appointment') then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- A pending row older than ten minutes belongs to a booking that died between steps.
  delete from public.appointments a
   where a.status = 'pending'
     and a.created_at < now() - interval '10 minutes';

  begin
    insert into public.appointments (lead_id, booked_by, starts_at, ends_at, note, client_request_id)
    values (p_lead_id, v_uid, p_starts_at, p_starts_at + interval '30 minutes', v_note, p_client_request_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  return v_row;
end;
$$;

create or replace function public.confirm_appointment(p_id uuid, p_google_event_id text)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event text := nullif(btrim(coalesce(p_google_event_id, '')), '');
  v_row public.appointments;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_event is null or char_length(v_event) > 1024 then
    raise exception 'invalid event id' using errcode = '22023';
  end if;

  update public.appointments a
     set status = 'scheduled', google_event_id = v_event
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'pending'
  returning * into v_row;
  if found then
    return v_row;
  end if;

  select * into v_row
    from public.appointments a
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'scheduled'
     and a.google_event_id = v_event;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.abandon_appointment(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.appointments a
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'pending';
end;
$$;

-- CRM only: the event stays in Google Calendar until the closer deletes it there.
create or replace function public.cancel_appointment(p_id uuid)
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
  update public.appointments a
     set status = 'cancelled'
   where a.id = p_id
     and a.status = 'scheduled';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Times only, no lead and no agent: another agent's fresh booking leaves the picker before the
-- calendar is re-read. Stale pending rows (a booking that died) do not count.
create or replace function public.booked_intervals(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  return query
    select a.starts_at, a.ends_at
      from public.appointments a
     where a.starts_at < p_to
       and a.ends_at > p_from
       and (a.status = 'scheduled' or (a.status = 'pending' and a.created_at >= now() - interval '10 minutes'))
     order by a.starts_at;
end;
$$;

create or replace function public.get_calendar_status()
returns table (connected boolean, google_email text, bookable_calendar_set boolean, broken boolean)
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
    select true, c.google_email, c.bookable_calendar_id is not null, c.broken_at is not null
      from public.calendar_connection c
    union all
    select false, null::text, false, false
     where not exists (select 1 from public.calendar_connection);
end;
$$;

revoke execute on function public.begin_appointment(uuid, timestamptz, text, uuid) from public, anon;
revoke execute on function public.confirm_appointment(uuid, text) from public, anon;
revoke execute on function public.abandon_appointment(uuid) from public, anon;
revoke execute on function public.cancel_appointment(uuid) from public, anon;
revoke execute on function public.booked_intervals(timestamptz, timestamptz) from public, anon;
revoke execute on function public.get_calendar_status() from public, anon;
grant execute on function public.begin_appointment(uuid, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function public.confirm_appointment(uuid, text) to authenticated, service_role;
grant execute on function public.abandon_appointment(uuid) to authenticated, service_role;
grant execute on function public.cancel_appointment(uuid) to authenticated, service_role;
grant execute on function public.booked_intervals(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.get_calendar_status() to authenticated, service_role;
