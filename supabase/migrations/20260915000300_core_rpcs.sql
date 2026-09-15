-- Core RPCs (ARCHITECTURE 4.7). SECURITY DEFINER functions run as the owner, bypass RLS and
-- therefore check the caller themselves. Errors: P0002 not_found, 42501 forbidden,
-- 22023 validation, P0001 do_not_contact / call_in_progress.

-- ---------------------------------------------------------------------------------------------
-- log_call
-- ---------------------------------------------------------------------------------------------
create or replace function public.log_call(
  p_outcome public.call_outcome,
  p_lead_id uuid default null,
  p_call_id uuid default null,
  p_notes text default null,
  p_follow_up_at timestamptz default null,
  p_follow_up_note text default null,
  p_duration_seconds integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_call public.calls%rowtype;
  v_lead public.leads%rowtype;
  v_found boolean;
  v_call_id uuid;
  v_lead_id uuid;
  v_first_log boolean;
  v_notes text;
  v_attempt integer := 0;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_is_admin := public.is_admin();

  if p_outcome is null then
    raise exception 'outcome is required' using errcode = '22023';
  end if;
  if p_outcome = 'FOLLOW_UP' and p_follow_up_at is null then
    raise exception 'follow_up_at is required for FOLLOW_UP' using errcode = '22023';
  end if;
  if p_duration_seconds is not null and (p_duration_seconds < 0 or p_duration_seconds > 86400) then
    raise exception 'duration_seconds must be between 0 and 86400' using errcode = '22023';
  end if;

  -- Same rules as normalizeCallNotes/applyWrongNumberPrefix in src/lib/domain/outcomes.ts:
  -- trim ASCII whitespace, blank means null, and the WRONG_NUMBER prefix is applied once
  -- (a retried save that already carries it is left unchanged).
  v_notes := nullif(regexp_replace(coalesce(p_notes, ''), '^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$', '', 'g'), '');
  if p_outcome = 'WRONG_NUMBER' then
    if v_notes is null then
      v_notes := 'Wrong number';
    elsif v_notes !~* '^wrong number( — |$)' then
      v_notes := 'Wrong number — ' || v_notes;
    end if;
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_found := false;
    if p_call_id is not null then
      -- A row the caller may log, by id. A row the caller may not log is handled exactly like a
      -- missing id, so a known id (another agent's call, or the caller's own call on a lead that was
      -- reassigned away or deleted) reveals nothing about that row.
      select c.* into v_call
        from public.calls c
        left join public.leads l on l.id = c.lead_id
       where c.id = p_call_id
         and (v_is_admin or (c.user_id = v_uid and (c.lead_id is null or l.assigned_to = v_uid)))
       for update of c;
      v_found := found;

      -- A TEL call this caller already logged with the same client key on the same accessible lead.
      if not v_found and p_lead_id is not null then
        select c.* into v_call
          from public.calls c
          join public.leads l on l.id = c.lead_id
         where c.user_id = v_uid
           and c.lead_id = p_lead_id
           and c.client_request_id = p_call_id
           and (v_is_admin or l.assigned_to = v_uid)
         for update of c;
        v_found := found;
      end if;
    end if;

    if v_found then
      -- Existing call row (Twilio pre-created, inbound, or a TEL re-log).
      if p_lead_id is not null and v_call.lead_id is distinct from p_lead_id then
        raise exception 'not_found' using errcode = 'P0002';
      end if;
      if v_call.lead_id is not null then
        select * into v_lead from public.leads l where l.id = v_call.lead_id for update;
        if not found or not (v_is_admin or v_lead.assigned_to = v_uid) then
          raise exception 'not_found' using errcode = 'P0002';
        end if;
      elsif p_follow_up_at is not null then
        raise exception 'a follow-up needs a lead' using errcode = '22023';
      end if;

      v_first_log := v_call.outcome is null;

      update public.calls c
         set outcome = p_outcome,
             notes = v_notes,
             -- Twilio status callbacks own the talk time of in-app calls; only TEL durations are manual.
             duration_seconds = case
               when c.mode = 'TEL' then coalesce(c.duration_seconds, p_duration_seconds)
               else c.duration_seconds
             end,
             handled_at = case
               when c.voicemail_recording_sid is not null then coalesce(c.handled_at, now())
               else c.handled_at
             end
       where c.id = v_call.id;

      v_call_id := v_call.id;
      v_lead_id := v_call.lead_id;
      exit;
    end if;

    -- No row yet: a TEL call logged by the client. p_call_id is stored as the idempotency key, never
    -- as the row id.
    if p_lead_id is null then
      if p_call_id is not null then
        raise exception 'not_found' using errcode = 'P0002';
      end if;
      raise exception 'lead_id is required' using errcode = '22023';
    end if;

    if not public.can_access_lead(p_lead_id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    select * into v_lead from public.leads l where l.id = p_lead_id for update;
    if not found or not (v_is_admin or v_lead.assigned_to = v_uid) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if v_lead.status = 'DO_NOT_CONTACT' then
      raise exception 'do_not_contact' using errcode = 'P0001';
    end if;

    v_call_id := null;
    insert into public.calls (lead_id, user_id, direction, mode, remote_e164, outcome, notes, duration_seconds, client_request_id)
    values (v_lead.id, v_uid, 'OUTBOUND', 'TEL', v_lead.phone, p_outcome, v_notes, p_duration_seconds, p_call_id)
    on conflict (user_id, lead_id, client_request_id) where client_request_id is not null do nothing
    returning id into v_call_id;

    if v_call_id is null then
      -- A concurrent request stored the same client key first: handle it as a re-log.
      if v_attempt >= 2 then
        raise exception 'not_found' using errcode = 'P0002';
      end if;
      continue;
    end if;

    v_first_log := true;
    v_lead_id := v_lead.id;
    exit;
  end loop;

  if v_lead_id is not null then
    update public.leads l
       set call_count = l.call_count + case when v_first_log then 1 else 0 end,
           last_contacted_at = now(),
           status = public.outcome_to_status(p_outcome, l.status)
     where l.id = v_lead_id;

    update public.calls c
       set handled_at = now()
     where c.lead_id = v_lead_id
       and c.voicemail_recording_sid is not null
       and c.handled_at is null;

    -- Follow-up work happens once per call row: a retried save never duplicates the follow-up or
    -- completes the one the first save created.
    if v_first_log then
      update public.follow_ups f
         set completed_at = now()
       where f.lead_id = v_lead_id
         and f.completed_at is null
         and f.due_at <= now();

      if p_follow_up_at is not null then
        insert into public.follow_ups (lead_id, user_id, due_at, note)
        values (
          v_lead_id,
          coalesce(v_lead.assigned_to, v_uid),
          p_follow_up_at,
          case when btrim(coalesce(p_follow_up_note, '')) = '' then null else p_follow_up_note end
        );
      end if;
    end if;

    select * into v_lead from public.leads l where l.id = v_lead_id;
    return jsonb_build_object(
      'call_id', v_call_id,
      'lead_id', v_lead_id,
      'status', v_lead.status,
      'call_count', v_lead.call_count,
      'next_follow_up_at', v_lead.next_follow_up_at
    );
  end if;

  return jsonb_build_object(
    'call_id', v_call_id,
    'lead_id', null,
    'status', null,
    'call_count', null,
    'next_follow_up_at', null
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- get_next_lead
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_next_lead(p_exclude_ids uuid[] default '{}')
returns table (
  lead_id uuid,
  business_name text,
  contact_name text,
  phone text,
  status public.lead_status,
  city text,
  state text,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  call_count integer,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_tz text;
  v_end_of_today timestamptz;
  v_exclude uuid[] := array_remove(coalesce(p_exclude_ids, '{}'::uuid[]), null);
begin
  if v_uid is null then
    return;
  end if;
  select p.timezone into v_tz from public.profiles p where p.id = v_uid and p.active;
  if not found then
    return;
  end if;
  v_end_of_today := ((date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz);

  return query
  with candidates as (
    select
      l.id, l.business_name, l.contact_name, l.phone, l.status, l.city, l.state,
      l.last_contacted_at, l.next_follow_up_at, l.call_count, l.created_at,
      (select min(c.created_at) from public.calls c
        where c.lead_id = l.id and c.voicemail_recording_sid is not null and c.handled_at is null) as voicemail_at,
      (select min(f.due_at) from public.follow_ups f
        where f.lead_id = l.id and f.completed_at is null) as follow_up_due_at
    from public.leads l
    where l.assigned_to = v_uid
      and l.status not in ('CLIENT', 'NOT_INTERESTED', 'DO_NOT_CONTACT')
      and l.id <> all (v_exclude)
  ),
  bucketed as (
    select
      cand.*,
      case
        when cand.voicemail_at is not null then 1
        when cand.follow_up_due_at < now() then 2
        when cand.follow_up_due_at < v_end_of_today then 3
        when cand.status in ('NEW', 'TO_CALL') then 4
        when cand.status in ('NO_ANSWER', 'VOICEMAIL') then 5
      end as bucket
    from candidates cand
    where cand.last_contacted_at is null
       or cand.last_contacted_at <= now() - interval '4 hours'
       or cand.follow_up_due_at <= now()
       or cand.voicemail_at is not null
  )
  select
    b.id, b.business_name, b.contact_name, b.phone, b.status, b.city, b.state,
    b.last_contacted_at, b.next_follow_up_at, b.call_count,
    case b.bucket
      when 1 then 'VOICEMAIL'
      when 2 then 'OVERDUE'
      when 3 then 'DUE_TODAY'
      when 4 then 'NEW'
      else 'RETRY'
    end
  from bucketed b
  where b.bucket is not null
  order by
    b.bucket,
    case b.bucket
      when 1 then b.voicemail_at
      when 2 then b.follow_up_due_at
      when 3 then b.follow_up_due_at
      when 4 then b.created_at
    end asc nulls last,
    case when b.bucket = 5 then b.last_contacted_at end asc nulls first,
    case when b.bucket = 5 then b.call_count end asc,
    b.created_at asc,
    b.id asc
  limit 1;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- create_outbound_call
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_outbound_call(p_lead_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_lead public.leads%rowtype;
  v_call_id uuid;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Row lock serializes concurrent call creation for the same caller.
  select * into v_profile from public.profiles p where p.id = v_uid for update;
  if not found or not v_profile.active or not v_profile.in_app_calling_enabled then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_lead_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
     and (v_profile.role = 'ADMIN' or l.assigned_to = v_uid);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_lead.status = 'DO_NOT_CONTACT' then
    raise exception 'do_not_contact' using errcode = 'P0001';
  end if;

  -- One dialable pre-created call per caller: a new call replaces earlier ones that never reached
  -- Twilio. The outbound webhook claims only rows with no provider SID and no status.
  delete from public.calls c
   where c.user_id = v_uid
     and c.direction = 'OUTBOUND'
     and c.mode = 'IN_APP'
     and c.provider_call_sid is null
     and c.call_status is null
     and c.outcome is null;

  -- A call that is still live on Twilio blocks, unless its outcome was already logged (a lost final
  -- status callback must not lock the agent out).
  if exists (
    select 1 from public.calls c
     where c.user_id = v_uid
       and c.outcome is null
       and c.call_status in ('queued', 'ringing', 'in-progress')
       and c.created_at > now() - interval '2 hours'
  ) then
    raise exception 'call_in_progress' using errcode = 'P0001';
  end if;

  -- Enforced here rather than in the route, so calling the RPC directly is limited too.
  if not public.apply_rate_limit(v_uid, 'outbound_call') then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.calls (lead_id, user_id, direction, mode, remote_e164)
  values (v_lead.id, v_uid, 'OUTBOUND', 'IN_APP', v_lead.phone)
  returning id into v_call_id;

  return v_call_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Call history and voicemails
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_lead_call_history(p_lead_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  direction public.call_direction,
  mode public.call_mode,
  call_status text,
  outcome public.call_outcome,
  notes text,
  duration_seconds integer,
  has_voicemail boolean,
  voicemail_duration_seconds integer,
  handled_at timestamptz,
  is_mine boolean,
  caller_name text,
  caller_id_e164 text
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select public.can_access_lead(p_lead_id) as can_access, public.is_admin() as admin, auth.uid() as uid
  )
  select
    c.id, c.created_at, c.direction, c.mode, c.call_status, c.outcome, c.notes, c.duration_seconds,
    c.voicemail_recording_sid is not null,
    c.voicemail_duration_seconds, c.handled_at,
    coalesce(c.user_id = me.uid, false),
    case when me.admin then p.name end,
    case when me.admin then n.e164 end
  from me
  join public.calls c on me.can_access and c.lead_id = p_lead_id
  left join public.profiles p on p.id = c.user_id
  left join public.phone_numbers n on n.id = c.phone_number_id
  order by c.created_at desc, c.id desc
$$;

-- Service role only (the /api/voicemail/[callId] route, DEVIATIONS D13). A recording SID plus the
-- account SID is a Twilio media URL, so it must never reach a browser (SPEC 5). p_user_id is the
-- session user the route verified with getUser(); access is re-checked here for that user.
create or replace function public.get_voicemail_recording(p_call_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin boolean;
  v_sid text;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_call_id is null or p_user_id is null then
    return null;
  end if;
  select p.role = 'ADMIN' into v_admin from public.profiles p where p.id = p_user_id and p.active;
  if not found then
    return null;
  end if;

  select c.voicemail_recording_sid into v_sid
    from public.calls c
    left join public.leads l on l.id = c.lead_id
   where c.id = p_call_id
     and (
       v_admin
       or (c.lead_id is not null and l.assigned_to = p_user_id)
       or (c.lead_id is null and c.user_id = p_user_id)
     );
  return v_sid;
end;
$$;

-- Returns true when the call is an accessible voicemail (now or already handled), else false.
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
begin
  if v_uid is null or p_call_id is null or not v_active then
    return false;
  end if;

  select c.id into v_call_id
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

  update public.calls c
     set handled_at = now()
   where c.id = v_call_id
     and c.handled_at is null;
  return true;
end;
$$;

create or replace function public.list_voicemails(
  p_unheard_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  call_id uuid,
  created_at timestamptz,
  lead_id uuid,
  business_name text,
  contact_name text,
  phone text,
  lead_status public.lead_status,
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
    select public.is_admin() as admin, public.is_active_user() as active, auth.uid() as uid
  )
  select
    c.id, c.created_at, c.lead_id, l.business_name, l.contact_name,
    case when c.lead_id is null then c.remote_e164 else l.phone end,
    l.status, c.voicemail_duration_seconds, c.handled_at,
    count(*) over ()
  from me
  join public.calls c on c.voicemail_recording_sid is not null
  left join public.leads l on l.id = c.lead_id
  where (not coalesce(p_unheard_only, false) or c.handled_at is null)
    and (
      me.admin
      or (me.active and (
            (c.lead_id is not null and l.assigned_to = me.uid)
            or (c.lead_id is null and c.user_id = me.uid)
          ))
    )
  order by c.created_at desc, c.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0))
$$;

create or replace function public.unheard_voicemail_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select public.is_admin() as admin, public.is_active_user() as active, auth.uid() as uid
  )
  select count(*)::integer
  from me
  join public.calls c on c.voicemail_recording_sid is not null and c.handled_at is null
  left join public.leads l on l.id = c.lead_id
  where me.admin
     or (me.active and (
           (c.lead_id is not null and l.assigned_to = me.uid)
           or (c.lead_id is null and c.user_id = me.uid)
         ))
$$;

-- ---------------------------------------------------------------------------------------------
-- reassign_leads (admin)
-- ---------------------------------------------------------------------------------------------
create or replace function public.reassign_leads(p_lead_ids uuid[], p_to_user_id uuid)
returns integer
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

  if p_to_user_id is not null and not exists (
    select 1 from public.profiles p
     where p.id = p_to_user_id and p.active and p.role in ('AGENT', 'ADMIN')
  ) then
    raise exception 'target user must be an active agent or admin' using errcode = '22023';
  end if;

  if p_lead_ids is null or cardinality(p_lead_ids) = 0 then
    return 0;
  end if;

  with updated as (
    update public.leads l
       set assigned_to = p_to_user_id
     where l.id = any (p_lead_ids)
    returning l.id
  )
  select count(*)::integer into v_count from updated;

  -- Open follow-ups move to the new owner in the leads_move_open_follow_ups trigger.
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- search_leads / list_lead_sources (SECURITY INVOKER: RLS scopes rows, plus explicit owner filter)
-- ---------------------------------------------------------------------------------------------
create or replace function public.search_leads(
  p_query text default null,
  p_statuses public.lead_status[] default null,
  p_source text default null,
  p_assigned_to uuid default null,
  p_unassigned boolean default false,
  p_sort text default 'created_at',
  p_dir text default 'desc',
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  created_at timestamptz,
  business_name text,
  contact_name text,
  phone text,
  email text,
  website text,
  city text,
  state text,
  country text,
  source text,
  status public.lead_status,
  assigned_to uuid,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  call_count integer,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_digits text;
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_sort text := case
    when p_sort in ('business_name', 'last_contacted_at', 'next_follow_up_at', 'call_count', 'created_at') then p_sort
    else 'created_at'
  end;
  v_asc boolean := lower(coalesce(p_dir, 'desc')) = 'asc';
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if v_uid is null then
    return;
  end if;

  if v_query is not null then
    v_query := left(v_query, 200);
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- Phone digits match only for phone-like queries ("(212) 555-0142", "+1 212.555"), so a text
    -- query such as "Suite 100" never matches unrelated phone numbers.
    if v_query ~ '^[-+0-9().[:space:]]+$' then
      v_digits := regexp_replace(v_query, '[^0-9]', '', 'g');
    end if;
    if length(v_digits) < 3 then
      v_digits := null;
    end if;
  end if;

  return query
  select
    l.id, l.created_at, l.business_name, l.contact_name, l.phone, l.email, l.website, l.city,
    l.state, l.country, l.source, l.status, l.assigned_to, l.last_contacted_at,
    l.next_follow_up_at, l.call_count,
    count(*) over ()
  from public.leads l
  where (v_admin or l.assigned_to = v_uid)
    and (
      v_query is null
      or l.business_name ilike v_pattern
      or l.contact_name ilike v_pattern
      or l.email ilike v_pattern
      or l.website ilike v_pattern
      or l.city ilike v_pattern
      or (v_digits is not null and l.phone like '%' || v_digits || '%')
    )
    and (p_statuses is null or cardinality(p_statuses) = 0 or l.status = any (p_statuses))
    and (v_source is null or l.source = v_source)
    and (
      not v_admin
      or (
        (p_assigned_to is null or l.assigned_to = p_assigned_to)
        and (not coalesce(p_unassigned, false) or l.assigned_to is null)
      )
    )
  order by
    case when v_sort = 'business_name' and v_asc then lower(l.business_name) end asc nulls last,
    case when v_sort = 'business_name' and not v_asc then lower(l.business_name) end desc nulls last,
    case when v_sort = 'last_contacted_at' and v_asc then l.last_contacted_at end asc nulls last,
    case when v_sort = 'last_contacted_at' and not v_asc then l.last_contacted_at end desc nulls last,
    case when v_sort = 'next_follow_up_at' and v_asc then l.next_follow_up_at end asc nulls last,
    case when v_sort = 'next_follow_up_at' and not v_asc then l.next_follow_up_at end desc nulls last,
    case when v_sort = 'call_count' and v_asc then l.call_count end asc nulls last,
    case when v_sort = 'call_count' and not v_asc then l.call_count end desc nulls last,
    case when v_sort = 'created_at' and v_asc then l.created_at end asc nulls last,
    case when v_sort = 'created_at' and not v_asc then l.created_at end desc nulls last,
    l.id asc
  limit v_limit
  offset v_offset;
end;
$$;

create or replace function public.list_lead_sources()
returns setof text
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct l.source
    from public.leads l
   where l.source is not null
     and btrim(l.source) <> ''
     and (public.is_admin() or l.assigned_to = auth.uid())
   order by 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Presence and rate limiting
-- ---------------------------------------------------------------------------------------------
create or replace function public.touch_device_presence()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.profiles p
     set device_seen_at = now()
   where p.id = v_uid
     and p.active;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

-- The policy (limit and window) of every bucket lives here, never in caller arguments, so nobody can
-- shrink a window to prune their own hits. Internal: not executable by any API role.
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

-- For limits a route checks before work that has no RPC of its own (issuing a Twilio token).
-- outbound_call is enforced inside create_outbound_call and is not accepted here.
create or replace function public.consume_rate_limit(p_bucket text)
returns boolean
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
  if p_bucket is distinct from 'voice_token' then
    raise exception 'invalid bucket' using errcode = '22023';
  end if;
  return public.apply_rate_limit(v_uid, p_bucket);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Service-role-only functions used by Twilio webhooks. EXECUTE is granted to service_role only;
-- they also refuse API-role JWT claims in case a grant is ever widened by mistake.
-- ---------------------------------------------------------------------------------------------
create or replace function public.claim_caller_id(p_user_id uuid)
returns table (phone_number_id uuid, e164 text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_e164 text;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user_id is null
     or not exists (select 1 from public.profiles p where p.id = p_user_id and p.active) then
    return;
  end if;

  -- The agent's own number is locked without skipping: a concurrent calls insert holds a KEY SHARE
  -- lock on it through the FK, and skipping would silently fall back to a pool number. NO KEY UPDATE
  -- does not conflict with KEY SHARE. Pool numbers may be skipped while another claim holds them.
  select n.id, n.e164 into v_id, v_e164
    from public.phone_numbers n
   where n.active
     and n.assigned_to = p_user_id
   order by n.last_used_at asc nulls first, n.created_at asc, n.id asc
   limit 1
   for no key update;

  if v_id is null then
    select n.id, n.e164 into v_id, v_e164
      from public.phone_numbers n
     where n.active
       and n.assigned_to is null
     order by n.last_used_at asc nulls first, n.created_at asc, n.id asc
     limit 1
     for no key update skip locked;
  end if;

  if v_id is null then
    return;
  end if;

  update public.phone_numbers n set last_used_at = now() where n.id = v_id;

  phone_number_id := v_id;
  e164 := v_e164;
  return next;
end;
$$;

-- Returns true when a call row with that SID exists (the update itself is idempotent).
create or replace function public.apply_call_status(p_call_sid text, p_status text, p_duration integer default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_call public.calls%rowtype;
  v_current_rank integer;
  v_new_rank integer;
  v_status text;
  v_duration integer;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status is null
     or p_status not in ('queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled') then
    raise exception 'invalid call status' using errcode = '22023';
  end if;
  if p_duration is not null and p_duration < 0 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;
  if p_call_sid is null or btrim(p_call_sid) = '' then
    return false;
  end if;

  select * into v_call from public.calls c where c.provider_call_sid = p_call_sid for update;
  if not found then
    return false;
  end if;

  -- queued < ringing < in-progress < terminal. Out-of-order retries never move a call backwards.
  v_current_rank := case v_call.call_status
    when 'queued' then 1 when 'ringing' then 2 when 'in-progress' then 3
    when 'completed' then 4 when 'busy' then 4 when 'no-answer' then 4 when 'failed' then 4 when 'canceled' then 4
    else 0 end;
  v_new_rank := case p_status
    when 'queued' then 1 when 'ringing' then 2 when 'in-progress' then 3
    else 4 end;

  v_status := v_call.call_status;
  if v_new_rank = 4 and v_current_rank = 4 then
    if v_call.duration_seconds is null and p_duration is not null then
      v_status := p_status;
    end if;
  elsif v_new_rank > v_current_rank then
    v_status := p_status;
  end if;

  v_duration := greatest(v_call.duration_seconds, p_duration);

  if v_status is distinct from v_call.call_status or v_duration is distinct from v_call.duration_seconds then
    update public.calls c
       set call_status = v_status,
           duration_seconds = v_duration
     where c.id = v_call.id;
  end if;

  return true;
end;
$$;

-- Returns true only when this call is the one that newly stored the recording.
create or replace function public.record_voicemail(p_call_sid text, p_recording_sid text, p_duration integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_call_id uuid;
  v_lead_id uuid;
  v_owner uuid;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_call_sid is null or btrim(p_call_sid) = '' or p_recording_sid is null or btrim(p_recording_sid) = '' then
    raise exception 'call and recording SIDs are required' using errcode = '22023';
  end if;
  if p_duration is not null and p_duration < 0 then
    raise exception 'invalid duration' using errcode = '22023';
  end if;

  update public.calls c
     set voicemail_recording_sid = p_recording_sid,
         voicemail_duration_seconds = p_duration
   where c.provider_call_sid = p_call_sid
     and c.voicemail_recording_sid is null
  returning c.id, c.lead_id into v_call_id, v_lead_id;

  if v_call_id is null then
    return false;
  end if;

  if v_lead_id is not null then
    select l.assigned_to into v_owner from public.leads l where l.id = v_lead_id;
    if v_owner is not null then
      insert into public.follow_ups (lead_id, user_id, due_at, note)
      values (v_lead_id, v_owner, now(), 'Voicemail received');
    end if;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.log_call(public.call_outcome, uuid, uuid, text, timestamptz, text, integer) from public, anon;
revoke execute on function public.get_next_lead(uuid[]) from public, anon;
revoke execute on function public.create_outbound_call(uuid) from public, anon;
revoke execute on function public.get_lead_call_history(uuid) from public, anon;
revoke execute on function public.get_voicemail_recording(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.mark_voicemail_heard(uuid) from public, anon;
revoke execute on function public.list_voicemails(boolean, integer, integer) from public, anon;
revoke execute on function public.unheard_voicemail_count() from public, anon;
revoke execute on function public.reassign_leads(uuid[], uuid) from public, anon;
revoke execute on function public.search_leads(text, public.lead_status[], text, uuid, boolean, text, text, integer, integer) from public, anon;
revoke execute on function public.list_lead_sources() from public, anon;
revoke execute on function public.touch_device_presence() from public, anon;
revoke execute on function public.consume_rate_limit(text) from public, anon;
revoke execute on function public.apply_rate_limit(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.claim_caller_id(uuid) from public, anon, authenticated;
revoke execute on function public.apply_call_status(text, text, integer) from public, anon, authenticated;
revoke execute on function public.record_voicemail(text, text, integer) from public, anon, authenticated;

grant execute on function public.log_call(public.call_outcome, uuid, uuid, text, timestamptz, text, integer) to authenticated, service_role;
grant execute on function public.get_next_lead(uuid[]) to authenticated, service_role;
grant execute on function public.create_outbound_call(uuid) to authenticated, service_role;
grant execute on function public.get_lead_call_history(uuid) to authenticated, service_role;
grant execute on function public.get_voicemail_recording(uuid, uuid) to service_role;
grant execute on function public.mark_voicemail_heard(uuid) to authenticated, service_role;
grant execute on function public.list_voicemails(boolean, integer, integer) to authenticated, service_role;
grant execute on function public.unheard_voicemail_count() to authenticated, service_role;
grant execute on function public.reassign_leads(uuid[], uuid) to authenticated, service_role;
grant execute on function public.search_leads(text, public.lead_status[], text, uuid, boolean, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.list_lead_sources() to authenticated, service_role;
grant execute on function public.touch_device_presence() to authenticated, service_role;
grant execute on function public.consume_rate_limit(text) to authenticated, service_role;
grant execute on function public.claim_caller_id(uuid) to service_role;
grant execute on function public.apply_call_status(text, text, integer) to service_role;
grant execute on function public.record_voicemail(text, text, integer) to service_role;

-- Functions created by later migrations are not executable by PUBLIC or anon unless granted
-- explicitly. authenticated/service_role keep Supabase's defaults, so every later migration still
-- revokes from authenticated what only the service role may call.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
