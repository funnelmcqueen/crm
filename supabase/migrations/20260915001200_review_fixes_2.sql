-- Stages 6-10 review fixes (round 2). The shared stat definitions are unchanged; these functions are
-- made to agree with them and with each other.
--
--   * admin_team_totals       reports clients split by assignment and raw talk seconds, so the admin
--                             dashboard tile can floor talk time exactly like its per-agent rows do.
--   * admin_report_agents     also lists ADMIN profiles that currently hold CLIENT leads, so the report
--                             "Clients" total equals the dashboard's assigned-clients number.
--   * follow_up_tab_counts    reports the total voicemail count the Voicemails tab actually lists,
--                             alongside the unheard count used for the alert styling.
--   * admin_phone_number_rows reports whether the assignee is still an active user, so a number parked
--                             on a disabled agent is visible on the Phone Numbers page.

-- ---------------------------------------------------------------------------------------------
-- admin_team_totals: clients split by assignment, plus talk seconds
-- ---------------------------------------------------------------------------------------------
-- clients_total stays the whole-pipeline count. clients_assigned is the sum of the per-agent "Clients"
-- numbers (leads currently assigned with status CLIENT), which is what reports total, and
-- clients_unassigned is the remainder, so no client lead is hidden on either surface.
create or replace function public.admin_team_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_leads jsonb;
  v_today jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'leads_total', count(*),
           'leads_unassigned', count(*) filter (where l.assigned_to is null),
           'clients_total', count(*) filter (where l.status = 'CLIENT'),
           'clients_assigned', count(*) filter (where l.status = 'CLIENT' and l.assigned_to is not null),
           'clients_unassigned', count(*) filter (where l.status = 'CLIENT' and l.assigned_to is null),
           'leads_on_disabled_agents', count(*) filter (where p.id is not null and not p.active),
           'disabled_agents_with_leads', count(distinct p.id) filter (where p.id is not null and not p.active)
         )
    into v_leads
    from public.leads l
    left join public.profiles p on p.id = l.assigned_to;

  select jsonb_build_object(
           'calls_today', coalesce(sum(r.dials_today), 0)::bigint,
           'connected_today', coalesce(sum(r.connected_today), 0)::bigint,
           'interested_today', coalesce(sum(r.interested_today), 0)::bigint,
           'appointments_today', coalesce(sum(r.appointments_today), 0)::bigint,
           'talk_seconds_today', coalesce(sum(r.talk_seconds_today), 0)::bigint,
           'talk_minutes_today', round(coalesce(sum(r.talk_seconds_today), 0) / 60.0)::bigint
         )
    into v_today
    from public.admin_agent_rows() r;

  return v_leads || v_today;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_report_agents: also list admins that currently hold client leads
-- ---------------------------------------------------------------------------------------------
-- Unchanged except for the row set: every AGENT profile, plus ADMIN profiles that either made calls in
-- the range or currently hold CLIENT leads. Without the second case an admin-owned client lead counted
-- on the dashboard had no row here, so the two "Clients" numbers disagreed.
create or replace function public.admin_report_agents(p_from timestamptz, p_to timestamptz)
returns table (
  user_id uuid,
  name text,
  active boolean,
  dials bigint,
  connected bigint,
  connect_rate numeric,
  talk_seconds bigint,
  avg_call_seconds numeric,
  interested bigint,
  appointments bigint,
  clients bigint
)
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
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  -- 366 local days, plus one hour of slack for a DST change inside the range.
  if extract(epoch from (p_to - p_from)) > 366 * 86400 + 3600 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  return query
  with stats as (
    select c.user_id as uid,
           count(*) filter (where c.direction = 'OUTBOUND'
                              and (c.outcome is not null or c.provider_call_sid is not null)) as n_dials,
           count(*) filter (where c.outcome is not null
                              and c.outcome not in ('NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER')) as n_connected,
           coalesce(sum(coalesce(c.duration_seconds, 0)), 0)::bigint as n_talk,
           count(*) filter (where c.duration_seconds > 0) as n_timed,
           count(*) filter (where c.outcome = 'INTERESTED') as n_interested,
           count(*) filter (where c.outcome = 'APPOINTMENT') as n_appointments
      from public.calls c
     where c.user_id is not null
       and c.created_at >= p_from
       and c.created_at < p_to
     group by c.user_id
  ),
  client_counts as (
    select l.assigned_to as uid, count(*) as n_clients
      from public.leads l
     where l.status = 'CLIENT' and l.assigned_to is not null
     group by l.assigned_to
  )
  select p.id,
         coalesce(nullif(btrim(p.name), ''), p.email),
         p.active,
         coalesce(s.n_dials, 0),
         coalesce(s.n_connected, 0),
         case when coalesce(s.n_dials, 0) = 0 then 0::numeric
              else round(s.n_connected::numeric / s.n_dials, 4) end,
         coalesce(s.n_talk, 0),
         case when coalesce(s.n_timed, 0) = 0 then 0::numeric
              else round(s.n_talk::numeric / s.n_timed, 2) end,
         coalesce(s.n_interested, 0),
         coalesce(s.n_appointments, 0),
         coalesce(cc.n_clients, 0)
    from public.profiles p
    left join stats s on s.uid = p.id
    left join client_counts cc on cc.uid = p.id
   where p.role = 'AGENT' or s.uid is not null or cc.uid is not null
   order by lower(coalesce(nullif(btrim(p.name), ''), p.email)), p.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- follow_up_tab_counts: the Voicemails badge counts what the Voicemails tab lists
-- ---------------------------------------------------------------------------------------------
-- voicemails_total comes from list_voicemails itself (same scoping, same rows), so the badge and the
-- list can never drift. voicemails_unheard stays, for the alert styling and the nav badge.
create or replace function public.follow_up_tab_counts()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_tz text;
  v_now timestamptz := now();
  v_end_of_today timestamptz;
  v_total bigint;
  v_result jsonb;
begin
  if v_uid is not null then
    select p.timezone into v_tz from public.profiles p where p.id = v_uid and p.active;
  end if;
  if v_tz is null then
    return jsonb_build_object('overdue', 0, 'today', 0, 'upcoming', 0, 'completed', 0,
                              'voicemails_unheard', 0, 'voicemails_total', 0);
  end if;
  v_admin := public.is_admin();
  v_end_of_today := ((date_trunc('day', v_now at time zone v_tz) + interval '1 day') at time zone v_tz);

  select coalesce(max(v.total_count), 0) into v_total from public.list_voicemails(false, 1, 0) v;

  select jsonb_build_object(
    'overdue', count(*) filter (where f.completed_at is null and f.due_at < v_now),
    'today', count(*) filter (where f.completed_at is null and f.due_at >= v_now and f.due_at < v_end_of_today),
    'upcoming', count(*) filter (where f.completed_at is null and f.due_at >= v_end_of_today),
    'completed', count(*) filter (where f.completed_at is not null),
    'voicemails_unheard', coalesce(public.unheard_voicemail_count(), 0),
    'voicemails_total', coalesce(v_total, 0)
  )
  into v_result
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id
  where v_admin or (f.user_id = v_uid and l.assigned_to = v_uid);

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_phone_number_rows: show whether the assignee is still an active user
-- ---------------------------------------------------------------------------------------------
-- Adding a column changes the return type, which create or replace cannot do, so the function is
-- dropped and recreated with its grants re-applied. The body is otherwise unchanged.
drop function if exists public.admin_phone_number_rows();

create function public.admin_phone_number_rows()
returns table (
  id uuid,
  e164 text,
  label text,
  twilio_sid text,
  active boolean,
  assigned_to uuid,
  assigned_name text,
  assigned_active boolean,
  calls_today bigint,
  last_used_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- "Today" is the calling admin's day.
  select p.timezone into v_tz from public.profiles p where p.id = auth.uid();
  v_start := (date_trunc('day', now() at time zone v_tz) at time zone v_tz);
  v_end := ((date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz);

  return query
  select n.id,
         n.e164,
         n.label,
         n.twilio_sid,
         n.active,
         n.assigned_to,
         case when pr.id is null then null else coalesce(nullif(btrim(pr.name), ''), pr.email) end,
         pr.active,
         (select count(*)
            from public.calls c
           where c.phone_number_id = n.id
             and c.created_at >= v_start
             and c.created_at < v_end),
         n.last_used_at,
         n.created_at
    from public.phone_numbers n
    left join public.profiles pr on pr.id = n.assigned_to
   order by n.active desc, n.created_at, n.e164;
end;
$$;

revoke execute on function public.admin_phone_number_rows() from public, anon;
grant execute on function public.admin_phone_number_rows() to authenticated, service_role;
