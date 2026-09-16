-- Stage 10a: admin agent drill-down (SPEC 8 "Agents (admin)": view activity).
-- Stats use the shared definitions (ARCHITECTURE 4.7) and are attributed to calls.user_id, so they stay with
-- whoever made the call after a reassignment.

create or replace function public.admin_agent_activity(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile jsonb;
  v_stats jsonb;
  v_outcomes jsonb;
  v_recent jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_user_id is null or p_from is null or p_to is null or p_to <= p_from
     or p_to - p_from > interval '400 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
           'user_id', p.id,
           'name', p.name,
           'email', p.email,
           'role', p.role,
           'active', p.active,
           'timezone', p.timezone,
           'daily_call_target', p.daily_call_target,
           'in_app_calling_enabled', p.in_app_calling_enabled,
           'created_at', p.created_at,
           'leads_assigned', (select count(*) from public.leads l where l.assigned_to = p.id),
           'clients', (select count(*) from public.leads l where l.assigned_to = p.id and l.status = 'CLIENT')
         )
    into v_profile
    from public.profiles p
   where p.id = p_user_id;

  if v_profile is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select pg_catalog.jsonb_build_object(
           'dials', count(*) filter (
              where c.direction = 'OUTBOUND' and (c.outcome is not null or c.provider_call_sid is not null)),
           'connected', count(*) filter (
              where c.outcome is not null and c.outcome not in ('NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER')),
           'interested', count(*) filter (where c.outcome = 'INTERESTED'),
           'appointments', count(*) filter (where c.outcome = 'APPOINTMENT'),
           'talk_seconds', coalesce(sum(coalesce(c.duration_seconds, 0)), 0),
           'calls_with_duration', count(*) filter (where c.duration_seconds > 0),
           'inbound_calls', count(*) filter (where c.direction = 'INBOUND'),
           'total_calls', count(*)
         )
    into v_stats
    from public.calls c
   where c.user_id = p_user_id
     and c.created_at >= p_from
     and c.created_at < p_to;

  select coalesce(pg_catalog.jsonb_object_agg(o.outcome, o.n), '{}'::jsonb)
    into v_outcomes
    from (
      select c.outcome::text as outcome, count(*) as n
        from public.calls c
       where c.user_id = p_user_id
         and c.created_at >= p_from
         and c.created_at < p_to
         and c.outcome is not null
       group by c.outcome
    ) o;

  select coalesce(pg_catalog.jsonb_agg(r.item order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_recent
    from (
      select c.id,
             c.created_at,
             pg_catalog.jsonb_build_object(
               'id', c.id,
               'created_at', c.created_at,
               'direction', c.direction,
               'mode', c.mode,
               'outcome', c.outcome,
               'call_status', c.call_status,
               'duration_seconds', c.duration_seconds,
               'lead_id', c.lead_id,
               'business_name', l.business_name
             ) as item
        from public.calls c
        left join public.leads l on l.id = c.lead_id
       where c.user_id = p_user_id
         and c.created_at >= p_from
         and c.created_at < p_to
       order by c.created_at desc, c.id desc
       limit 50
    ) r;

  return pg_catalog.jsonb_build_object(
    'profile', v_profile,
    'from', p_from,
    'to', p_to,
    'stats', v_stats,
    'outcomes', v_outcomes,
    'recent_calls', v_recent
  );
end;
$$;

revoke execute on function public.admin_agent_activity(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_agent_activity(uuid, timestamptz, timestamptz) to authenticated, service_role;
