-- A Google calendar per agent (docs/DEVIATIONS.md D48).
--
-- Milestones 1 (D46) and 2 (D47) assumed one closer: every meeting landed in one calendar, and the
-- owner ran it. The owner does not attend these meetings — agents close their own — so each agent now
-- books into a secondary calendar of their own on the same connected account. `calendar_connection`
-- stays the singleton it is: one Google account, one refresh token, N calendars it created.

-- ---------------------------------------------------------------------------------------------
-- 1. The agent's own calendar on the connected account
-- ---------------------------------------------------------------------------------------------
-- Null means "not provisioned yet": every agent created before this migration, and any agent whose
-- calendar could not be created when their account was. Booking is unavailable to them until it is.
-- Not a secret — a calendar id is useless without the account's access token — so no column-level
-- grant beyond profiles_select, under which an agent reads their own row and an admin reads all.
alter table public.profiles add column google_calendar_id text
  constraint profiles_google_calendar_id_length
    check (google_calendar_id is null or char_length(google_calendar_id) between 1 and 1024);

-- Written only by the server, next to the rest of the connection-row access (the OAuth callback and
-- src/server/services/calendar-booking.ts both use the service role). Service-role only for the same
-- reason as mark_calendar_broken: an agent's own session must never reach it. profiles_guard already
-- refuses this column to a non-admin, but the grant is the guard that does not depend on that.
create or replace function public.set_agent_calendar_id(p_user_id uuid, p_calendar_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar text := nullif(btrim(coalesce(p_calendar_id, '')), '');
begin
  if p_user_id is null or v_calendar is null or char_length(v_calendar) > 1024 then
    raise exception 'invalid_calendar' using errcode = '22023';
  end if;

  -- A deleted agent never owns work again (20260915001400_delete_agent.sql); profiles_guard would
  -- refuse the update anyway, but failing here says why.
  update public.profiles p
     set google_calendar_id = v_calendar
   where p.id = p_user_id
     and p.deleted_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.set_agent_calendar_id(uuid, text) from public, anon, authenticated;
grant execute on function public.set_agent_calendar_id(uuid, text) to service_role;

-- Called when the app cannot confirm the newly connected Google account is the one these calendars were
-- created on — a different account, or a connect after a disconnect. Their ids would then name calendars the
-- new token cannot reach, and every booking against them would fail while Settings said "Connected", which is
-- the failure this clears: with no calendar, Settings shows plainly who still needs one. Service-role only,
-- like set_agent_calendar_id.
create or replace function public.clear_agent_calendars()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with cleared as (
    update public.profiles p
       set google_calendar_id = null
     where p.google_calendar_id is not null
    returning p.id
  )
  select count(*)::integer into v_count from cleared;
  return v_count;
end;
$$;
revoke execute on function public.clear_agent_calendars() from public, anon, authenticated;
grant execute on function public.clear_agent_calendars() to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Two agents may now hold the same clock time
-- ---------------------------------------------------------------------------------------------
-- 20260915001900 made one live booking per start time across the whole company, which was right when
-- every meeting was the one closer's. Now the slot belongs to the agent who booked it, so the same
-- 30-minute start may be held once per agent and no more. begin_appointment still maps the
-- unique_violation this raises to `slot_taken`, unchanged.
drop index if exists public.appointments_live_start_key;
create unique index appointments_live_start_key on public.appointments (booked_by, starts_at)
  where status in ('pending', 'scheduled');

-- Times only, no lead and no agent, and now only the caller's own: an agent's picker must not be
-- blocked by another agent's meetings, and must not reveal them either. Stale pending rows (a booking
-- that died) still do not count.
create or replace function public.booked_intervals(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  return query
    select a.starts_at, a.ends_at
      from public.appointments a
     where a.booked_by = v_uid
       and a.starts_at < p_to
       and a.ends_at > p_from
       and (a.status = 'scheduled' or (a.status = 'pending' and a.created_at >= now() - interval '10 minutes'))
     order by a.starts_at;
end;
$$;

-- An agent runs their own meetings now, so an agent cancels their own. An admin still cancels any.
create or replace function public.cancel_appointment(p_id uuid)
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
  update public.appointments a
     set status = 'cancelled'
   where a.id = p_id
     and a.status = 'scheduled'
     and ((select public.is_admin()) or a.booked_by = v_uid)
  ;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;
