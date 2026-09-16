-- Admin "Delete agent" (docs/DEVIATIONS.md D40).
--
-- An admin may delete an AGENT who has no leads assigned and no open follow-ups. The profile row stays,
-- because calls and completed follow-ups keep pointing at it (so reports keep their history), but it is
-- marked deleted, made inactive for good, and frozen for every caller, postgres and the service role
-- included. The service layer (src/server/services/agents.ts deleteAgent) then closes the login: a new
-- random password and a permanent ban, every session ended, and last the Auth email moved off the real
-- address so it can be reused.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------
alter table public.profiles add column deleted_at timestamptz;

-- A deleted profile can never be active again, whatever the path.
alter table public.profiles
  add constraint profiles_deleted_is_inactive check (deleted_at is null or not active);

-- ---------------------------------------------------------------------------------------------
-- profiles_guard: unchanged from 20260915000200_rls.sql, plus the deleted-profile freeze.
-- ---------------------------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Lockout guard: nobody changes their own role or active flag, whatever the path.
  if old.id = (select auth.uid())
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- A deleted profile is frozen for every caller, postgres and the service role included: no
  -- reactivation, no role or name change, no undelete. The one change left is the email, which
  -- on_auth_user_email_changed copies from auth.users when the service closes the login; the checks
  -- below still refuse it to API callers. Only a privileged caller (admin_delete_agent, SECURITY
  -- DEFINER) sets deleted_at in the first place.
  if old.deleted_at is not null
     and (pg_catalog.to_jsonb(new) - 'email') is distinct from (pg_catalog.to_jsonb(old) - 'email') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if public.is_privileged_role() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if public.is_admin() then
    return new;
  end if;

  if (pg_catalog.to_jsonb(new) - 'name') is distinct from (pg_catalog.to_jsonb(old) - 'name') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- A deleted profile never owns work again.
--
-- The trigger takes FOR KEY SHARE on the owner's profile row, and admin_delete_agent takes FOR UPDATE on
-- it, so an assignment and a delete that race are serialized: whichever commits second sees the other.
-- KEY SHARE (the lock a foreign-key check takes) is enough for that, and unlike FOR SHARE it does not
-- block ordinary updates of the profile such as the device heartbeat or a target change.
--
-- TG_ARGV[0] names the owner column (leads.assigned_to, follow_ups.user_id, phone_numbers.assigned_to).
-- TG_ARGV[1], when given, names the column whose null means the row is open (follow_ups.completed_at):
-- an update that keeps the owner but reopens the row hands them open work again, so it is checked too.
-- ---------------------------------------------------------------------------------------------
create or replace function public.reject_deleted_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_deleted_at timestamptz;
begin
  v_owner := (pg_catalog.to_jsonb(new) ->> tg_argv[0])::uuid;
  if v_owner is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and (pg_catalog.to_jsonb(old) ->> tg_argv[0])::uuid is not distinct from v_owner then
    if tg_nargs < 2
       or (pg_catalog.to_jsonb(old) ->> tg_argv[1]) is null
       or (pg_catalog.to_jsonb(new) ->> tg_argv[1]) is not null then
      return new;
    end if;
  end if;

  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = v_owner
     for key share;

  if v_deleted_at is not null then
    raise exception 'owner is a deleted user' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger leads_reject_deleted_owner
  before insert or update of assigned_to on public.leads
  for each row execute function public.reject_deleted_owner('assigned_to');

create trigger follow_ups_reject_deleted_owner
  before insert or update of user_id, completed_at on public.follow_ups
  for each row execute function public.reject_deleted_owner('user_id', 'completed_at');

create trigger phone_numbers_reject_deleted_owner
  before insert or update of assigned_to on public.phone_numbers
  for each row execute function public.reject_deleted_owner('assigned_to');

-- ---------------------------------------------------------------------------------------------
-- admin_agent_rows: same rows and stats as 20260915000600_dashboards.sql, plus a `deleted` column.
-- Deleted agents stay in the result so admin_team_totals (which sums these rows) keeps counting calls
-- they made today; the app hides them from every list and picker. A new OUT column needs drop + create.
-- ---------------------------------------------------------------------------------------------
drop function public.admin_agent_rows();

create function public.admin_agent_rows()
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
  assigned_numbers text[],
  deleted boolean
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
         coalesce(nums.e164s, '{}'::text[]),
         p.deleted_at is not null
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
-- admin_agent_delete_check: what stands between an admin and deleting this user (read only).
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_agent_delete_check(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_leads integer;
  v_open integer;
  v_completed integer;
  v_calls integer;
  v_numbers integer;
  v_reason text;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select p.id, p.role, p.email, p.deleted_at
    into v_profile
    from public.profiles p
   where p.id = p_user_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select count(*) into v_leads from public.leads l where l.assigned_to = p_user_id;
  select count(*) filter (where f.completed_at is null), count(*) filter (where f.completed_at is not null)
    into v_open, v_completed
    from public.follow_ups f
   where f.user_id = p_user_id;
  select count(*) into v_calls from public.calls c where c.user_id = p_user_id;
  select count(*) into v_numbers from public.phone_numbers n where n.assigned_to = p_user_id;

  v_reason := case
    when v_profile.deleted_at is not null then 'deleted'
    when v_profile.id = (select auth.uid()) then 'self'
    when v_profile.role <> 'AGENT' then 'admin'
    when v_leads > 0 or v_open > 0 then 'has_work'
    else null
  end;

  return pg_catalog.jsonb_build_object(
    'leads', v_leads,
    'open_follow_ups', v_open,
    'completed_follow_ups', v_completed,
    'calls', v_calls,
    'phone_numbers', v_numbers,
    'deleted', v_profile.deleted_at is not null,
    -- The service compares this with the address it moves a closed login to, to tell a finished delete
    -- from one whose Auth half still has to run.
    'email', v_profile.email,
    'reason', v_reason,
    'deletable', v_reason is null
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_delete_agent: the database half of deleting an agent (the Auth half is in the service).
-- Idempotent: a second call on a deleted agent returns already_deleted so the service can finish a
-- half-done Auth step.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_delete_agent(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_profile record;
  v_leads integer;
  v_open integer;
  v_numbers integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- FOR UPDATE serializes this against reject_deleted_owner (FOR KEY SHARE), so no lead or follow-up can
  -- be assigned to this user, or reopened for them, between the counts below and the delete.
  select p.id, p.role, p.name, p.deleted_at
    into v_profile
    from public.profiles p
   where p.id = p_user_id
     for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_profile.deleted_at is not null then
    return pg_catalog.jsonb_build_object('user_id', v_profile.id, 'already_deleted', true, 'phone_numbers_unassigned', 0);
  end if;

  if v_profile.id = (select auth.uid()) or v_profile.role <> 'AGENT' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_leads from public.leads l where l.assigned_to = p_user_id;
  select count(*) into v_open from public.follow_ups f where f.user_id = p_user_id and f.completed_at is null;
  if v_leads > 0 or v_open > 0 then
    raise exception 'agent_has_work'
      using errcode = 'P0001',
            detail = pg_catalog.jsonb_build_object('leads', v_leads, 'open_follow_ups', v_open)::text;
  end if;

  update public.phone_numbers n
     set assigned_to = null
   where n.assigned_to = p_user_id;
  get diagnostics v_numbers = row_count;

  update public.profiles p
     set deleted_at = now(),
         active = false,
         name = case
           when pg_catalog.btrim(p.name) = '' then 'Deleted agent'
           when p.name like '% (deleted)' then p.name
           else left(pg_catalog.btrim(p.name), 190) || ' (deleted)'
         end
   where p.id = p_user_id;

  return pg_catalog.jsonb_build_object('user_id', p_user_id, 'already_deleted', false, 'phone_numbers_unassigned', v_numbers);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- admin_report_agents: a deleted agent gets a row only for a range in which they made calls
-- ---------------------------------------------------------------------------------------------
-- Unchanged from 20260915001200_review_fixes_2.sql except the row set: every AGENT profile that is not
-- deleted, plus any profile with calls in the range or CLIENT leads. Without this every deleted agent
-- stayed in the table with zeros for every range, and admin_report_totals (which counts these rows)
-- kept counting them as agents.
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
   where (p.role = 'AGENT' and p.deleted_at is null) or s.uid is not null or cc.uid is not null
   order by lower(coalesce(nullif(btrim(p.name), ''), p.email)), p.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- mark_voicemail_heard: an admin may handle a voicemail routed to a deleted agent
-- ---------------------------------------------------------------------------------------------
-- Unchanged from 20260915000400_review_fixes.sql except the routed-elsewhere branch. A voicemail from an
-- unknown caller stays routed to the agent who was ringing; once that agent is deleted nobody else could
-- ever mark it heard, and it would sit in every admin's unheard count for good.
create or replace function public.mark_voicemail_heard(p_call_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_active boolean := public.is_active_user();
  v_call_id uuid;
  v_lead_id uuid;
  v_call_user uuid;
  v_owner uuid;
begin
  if v_uid is null or p_call_id is null or not v_active then
    return false;
  end if;

  select c.id, c.lead_id, c.user_id, l.assigned_to
    into v_call_id, v_lead_id, v_call_user, v_owner
    from public.calls c
    left join public.leads l on l.id = c.lead_id
   where c.id = p_call_id
     and c.voicemail_recording_sid is not null
     and (
       v_admin
       or (c.lead_id is not null and l.assigned_to = v_uid)
       or (c.lead_id is null and c.user_id = v_uid)
     )
   for update of c;
  if v_call_id is null then
    return false;
  end if;

  -- A voicemail routed to someone else is theirs to handle: the admin sees it but does not mark it.
  -- A deleted agent can never handle one again, so their voicemails are the admin's to handle.
  if (v_lead_id is not null and v_owner is not null and v_owner <> v_uid)
     or (v_lead_id is null and v_call_user is not null and v_call_user <> v_uid
         and not exists (select 1 from public.profiles p where p.id = v_call_user and p.deleted_at is not null)) then
    return true;
  end if;

  update public.calls c
     set handled_at = now()
   where c.id = v_call_id
     and c.handled_at is null;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.reject_deleted_owner() from public, anon, authenticated, service_role;

revoke execute on function public.admin_agent_rows() from public, anon;
grant execute on function public.admin_agent_rows() to authenticated, service_role;

revoke execute on function public.admin_agent_delete_check(uuid) from public, anon;
grant execute on function public.admin_agent_delete_check(uuid) to authenticated, service_role;

revoke execute on function public.admin_delete_agent(uuid) from public, anon;
grant execute on function public.admin_delete_agent(uuid) to authenticated, service_role;
