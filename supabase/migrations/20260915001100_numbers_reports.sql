-- Stage 10b: admin phone numbers list and reports (SPEC 7d, 8 "Phone Numbers (admin)" and "Reports (admin)").
--
-- Every function here is admin-only (42501 otherwise) and aggregates with the shared stat definitions:
--   * attribution  = calls.user_id (stats stay with whoever made the call, even after reassignment)
--   * dial         = OUTBOUND row with (outcome is not null or provider_call_sid is not null)
--   * connected    = outcome is not null and outcome not in (NO_ANSWER, VOICEMAIL, WRONG_NUMBER), any direction
--   * connect rate = connected / dials (0 when there are no dials)
--   * interested   = outcome INTERESTED, appointments = outcome APPOINTMENT (any direction)
--   * talk seconds = sum(coalesce(duration_seconds, 0)) over the user's calls (both directions)
--   * avg call     = talk seconds / count of calls with duration_seconds > 0 (0 when none)
--   * clients      = leads currently assigned to the user with status CLIENT (not range-bound)
--   * answered     = OUTBOUND dial on the number with call_status 'completed' and duration_seconds > 0
-- Report ranges are half-open [p_from, p_to). The app computes both instants from local dates in the
-- admin's timezone. Rates are rounded to 4 decimals, averages to 2.

-- ---------------------------------------------------------------------------------------------
-- admin_phone_number_rows: the Phone Numbers page
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_phone_number_rows()
returns table (
  id uuid,
  e164 text,
  label text,
  twilio_sid text,
  active boolean,
  assigned_to uuid,
  assigned_name text,
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

-- ---------------------------------------------------------------------------------------------
-- admin_report_agents: per-agent rows for a date range
-- ---------------------------------------------------------------------------------------------
-- Rows: every AGENT profile (active or disabled), plus ADMIN profiles that made calls in the range.
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
   where p.role = 'AGENT' or s.uid is not null
   order by lower(coalesce(nullif(btrim(p.name), ''), p.email)), p.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_report_numbers: per-number rows for a date range
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_report_numbers(p_from timestamptz, p_to timestamptz)
returns table (
  phone_number_id uuid,
  e164 text,
  label text,
  active boolean,
  dials bigint,
  answered bigint,
  answer_rate numeric
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
  if extract(epoch from (p_to - p_from)) > 366 * 86400 + 3600 then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  return query
  with stats as (
    select c.phone_number_id as nid,
           count(*) as n_dials,
           count(*) filter (where c.call_status = 'completed' and c.duration_seconds > 0) as n_answered
      from public.calls c
     where c.phone_number_id is not null
       and c.direction = 'OUTBOUND'
       and (c.outcome is not null or c.provider_call_sid is not null)
       and c.created_at >= p_from
       and c.created_at < p_to
     group by c.phone_number_id
  )
  select n.id,
         n.e164,
         n.label,
         n.active,
         coalesce(s.n_dials, 0),
         coalesce(s.n_answered, 0),
         case when coalesce(s.n_dials, 0) = 0 then 0::numeric
              else round(s.n_answered::numeric / s.n_dials, 4) end
    from public.phone_numbers n
    left join stats s on s.nid = n.id
   order by n.active desc, n.created_at, n.e164;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_report_totals: team totals, consistent with admin_report_agents
-- ---------------------------------------------------------------------------------------------
-- Counts are sums of the per-agent rows. connect_rate and avg_call_seconds are recomputed from those
-- sums (not averaged across agents), with the same rounding as the rows.
create or replace function public.admin_report_totals(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- admin_report_agents validates the range (22023).

  with agent_rows as (
    select * from public.admin_report_agents(p_from, p_to)
  ),
  sums as (
    select count(*)::bigint as n_agents,
           coalesce(sum(r.dials), 0)::bigint as n_dials,
           coalesce(sum(r.connected), 0)::bigint as n_connected,
           coalesce(sum(r.talk_seconds), 0)::bigint as n_talk,
           coalesce(sum(r.interested), 0)::bigint as n_interested,
           coalesce(sum(r.appointments), 0)::bigint as n_appointments,
           coalesce(sum(r.clients), 0)::bigint as n_clients
      from agent_rows r
  ),
  timed as (
    select count(*)::bigint as n_timed
      from public.calls c
     where c.user_id in (select r.user_id from agent_rows r)
       and c.created_at >= p_from
       and c.created_at < p_to
       and c.duration_seconds > 0
  )
  select jsonb_build_object(
           'agents', s.n_agents,
           'dials', s.n_dials,
           'connected', s.n_connected,
           'connect_rate', case when s.n_dials = 0 then 0::numeric else round(s.n_connected::numeric / s.n_dials, 4) end,
           'talk_seconds', s.n_talk,
           'avg_call_seconds', case when t.n_timed = 0 then 0::numeric else round(s.n_talk::numeric / t.n_timed, 2) end,
           'interested', s.n_interested,
           'appointments', s.n_appointments,
           'clients', s.n_clients
         )
    into v_result
    from sums s cross join timed t;

  return v_result;
end;
$$;

revoke execute on function public.admin_phone_number_rows() from public, anon;
revoke execute on function public.admin_report_agents(timestamptz, timestamptz) from public, anon;
revoke execute on function public.admin_report_numbers(timestamptz, timestamptz) from public, anon;
revoke execute on function public.admin_report_totals(timestamptz, timestamptz) from public, anon;

grant execute on function public.admin_phone_number_rows() to authenticated, service_role;
grant execute on function public.admin_report_agents(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.admin_report_numbers(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.admin_report_totals(timestamptz, timestamptz) to authenticated, service_role;
