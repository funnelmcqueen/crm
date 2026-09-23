-- A history list needs calls.user_id and voicemail presence, neither of which is readable from
-- authenticated table queries. Keep those columns hidden and expose only scoped display data.
create or replace function public.list_call_history(
  p_tab text default 'all',
  p_agent_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  call_id uuid,
  created_at timestamptz,
  lead_id uuid,
  business_name text,
  contact_name text,
  remote_e164 text,
  user_id uuid,
  agent_name text,
  direction public.call_direction,
  outcome public.call_outcome,
  call_status text,
  duration_seconds integer,
  has_voicemail boolean,
  voicemail_duration_seconds integer,
  handled_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select public.is_active_user() as active, public.is_admin() as admin, auth.uid() as uid
  )
  select c.id, c.created_at, c.lead_id, l.business_name, l.contact_name,
    coalesce(c.remote_e164, l.phone), c.user_id,
    case when me.admin then p.name end,
    c.direction, c.outcome, c.call_status, c.duration_seconds,
    c.voicemail_recording_sid is not null, c.voicemail_duration_seconds, c.handled_at,
    count(*) over ()
  from me
  join public.calls c on me.active and (me.admin or c.user_id = me.uid)
  left join public.leads l on l.id = c.lead_id
  left join public.profiles p on p.id = c.user_id
  where (not me.admin or p_agent_id is null or c.user_id = p_agent_id)
    and (
      p_tab = 'all'
      or (p_tab = 'voicemail' and c.voicemail_recording_sid is not null)
      or (p_tab = 'missed' and c.direction = 'INBOUND' and (
        c.outcome in ('NO_ANSWER', 'VOICEMAIL')
        or (c.outcome is null and (
          c.voicemail_recording_sid is not null
          or c.call_status in ('busy', 'no-answer', 'failed', 'canceled')
        ))
      ))
    )
  order by c.created_at desc, c.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0))
$$;

revoke execute on function public.list_call_history(text, uuid, integer, integer) from public, anon;
grant execute on function public.list_call_history(text, uuid, integer, integer) to authenticated, service_role;
