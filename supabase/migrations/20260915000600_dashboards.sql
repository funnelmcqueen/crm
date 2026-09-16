-- Stage 6: dashboards and daily targets (SPEC 8 "Agent dashboard" and "Admin dashboard").
--
-- Shared stat definitions (every stats surface must agree):
--   * Stats are attributed to calls.user_id (they stay with whoever made the call after reassignment).
--   * dial         = OUTBOUND row with (outcome is not null or provider_call_sid is not null). A pre-created
--                    in-app row that never reached Twilio and was never logged is not a dial.
--   * connected    = outcome is not null and outcome not in (NO_ANSWER, VOICEMAIL, WRONG_NUMBER), any direction.
--   * interested   = outcome INTERESTED; appointments = outcome APPOINTMENT (any direction).
--   * talk seconds = sum(coalesce(duration_seconds, 0)) over the user's calls (both directions).
--   * "today"      = [local midnight, next local midnight) in that user's profiles.timezone, by calls.created_at.

-- ---------------------------------------------------------------------------------------------
-- get_my_dashboard: the caller's own numbers only
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_my_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_target integer;
  v_start timestamptz;
  v_end timestamptz;
  v_dials bigint;
  v_connected bigint;
  v_interested bigint;
  v_appointments bigint;
  v_talk bigint;
  v_follow_ups bigint;
  v_unheard integer;
begin
  select p.timezone, p.daily_call_target
    into v_tz, v_target
    from public.profiles p
   where p.id = v_uid and p.active;
  if v_uid is null or v_tz is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_start := (date_trunc('day', now() at time zone v_tz) at time zone v_tz);
  v_end := ((date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz);

  select count(*) filter (where c.direction = 'OUTBOUND' and (c.outcome is not null or c.provider_call_sid is not null)),
         count(*) filter (where c.outcome is not null and c.outcome not in ('NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER')),
         count(*) filter (where c.outcome = 'INTERESTED'),
         count(*) filter (where c.outcome = 'APPOINTMENT'),
         coalesce(sum(coalesce(c.duration_seconds, 0)), 0)
    into v_dials, v_connected, v_interested, v_appointments, v_talk
    from public.calls c
   where c.user_id = v_uid
     and c.created_at >= v_start
     and c.created_at < v_end;

  select count(*)
    into v_follow_ups
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id
   where f.user_id = v_uid
     and l.assigned_to = v_uid
     and f.completed_at is null
     and f.due_at < v_end;

  v_unheard := public.unheard_voicemail_count();

  return jsonb_build_object(
    'timezone', v_tz,
    'daily_call_target', v_target,
    'dials_today', v_dials,
    'remaining', greatest(v_target - v_dials, 0),
    'target_hit', v_target > 0 and v_dials >= v_target,
    'connected_today', v_connected,
    'interested_today', v_interested,
    'appointments_today', v_appointments,
    'talk_seconds_today', v_talk,
    'follow_ups_due', v_follow_ups,
    'unheard_voicemails', coalesce(v_unheard, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_agent_rows: one row per AGENT and ADMIN profile, "today" in that user's own timezone
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_agent_rows()
returns table (
  user_id uuid,
  name text,
  email text,
  role public.user_role,
  active boolean,
  in_app_calling_enabled boolean,
  timezone text,
  daily_call_target integer,
  leads_assigned bigint,
  dials_today bigint,
  connected_today bigint,
  interested_today bigint,
  appointments_today bigint,
  talk_seconds_today bigint,
  assigned_numbers text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with bounds as (
    select p.id,
           (date_trunc('day', now() at time zone p.timezone) at time zone p.timezone) as day_start,
           ((date_trunc('day', now() at time zone p.timezone) + interval '1 day') at time zone p.timezone) as day_end
      from public.profiles p
     where p.role in ('AGENT', 'ADMIN')
  )
  select p.id,
         p.name,
         p.email,
         p.role,
         p.active,
         p.in_app_calling_enabled,
         p.timezone,
         p.daily_call_target,
         coalesce(la.leads_assigned, 0)::bigint,
         coalesce(cs.dials, 0)::bigint,
         coalesce(cs.connected, 0)::bigint,
         coalesce(cs.interested, 0)::bigint,
         coalesce(cs.appointments, 0)::bigint,
         coalesce(cs.talk_seconds, 0)::bigint,
         coalesce(nums.e164s, '{}'::text[])
    from public.profiles p
    join bounds b on b.id = p.id
    left join lateral (
      select count(*) as leads_assigned
        from public.leads l
       where l.assigned_to = p.id
    ) la on true
    left join lateral (
      select count(*) filter (where c.direction = 'OUTBOUND' and (c.outcome is not null or c.provider_call_sid is not null)) as dials,
             count(*) filter (where c.outcome is not null and c.outcome not in ('NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER')) as connected,
             count(*) filter (where c.outcome = 'INTERESTED') as interested,
             count(*) filter (where c.outcome = 'APPOINTMENT') as appointments,
             sum(coalesce(c.duration_seconds, 0)) as talk_seconds
        from public.calls c
       where c.user_id = p.id
         and c.created_at >= b.day_start
         and c.created_at < b.day_end
    ) cs on true
    left join lateral (
      select array_agg(n.e164 order by n.e164) as e164s
        from public.phone_numbers n
       where n.assigned_to = p.id
         and n.active
    ) nums on true
   order by p.active desc, lower(p.name), p.email;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_team_totals: whole-team numbers; today totals are sums of admin_agent_rows
-- ---------------------------------------------------------------------------------------------
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
           'talk_minutes_today', round(coalesce(sum(r.talk_seconds_today), 0) / 60.0)::bigint
         )
    into v_today
    from public.admin_agent_rows() r;

  return v_leads || v_today;
end;
$$;

revoke execute on function public.get_my_dashboard() from public, anon;
revoke execute on function public.admin_agent_rows() from public, anon;
revoke execute on function public.admin_team_totals() from public, anon;

grant execute on function public.get_my_dashboard() to authenticated, service_role;
grant execute on function public.admin_agent_rows() to authenticated, service_role;
grant execute on function public.admin_team_totals() to authenticated, service_role;
