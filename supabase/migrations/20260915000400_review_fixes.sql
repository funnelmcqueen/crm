-- Stage 2-5 review fixes (DEVIATIONS D20-D22). Signatures and grants are unchanged; `create or replace`
-- keeps the existing EXECUTE privileges.

-- ---------------------------------------------------------------------------------------------
-- log_call: follow-up bounds (D21); completes follow-ups due before the end of the owner's day (D22)
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
  v_tz text;
  v_end_of_today timestamptz;
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
  -- A past follow-up is overdue at once, so Next Lead would serve the lead that was just logged again.
  -- One minute of tolerance absorbs clock skew between the device that picked the time and the server.
  if p_follow_up_at is not null
     and (p_follow_up_at < now() - interval '1 minute' or p_follow_up_at > now() + interval '1825 days') then
    raise exception 'follow_up_at must be in the future and within five years' using errcode = '22023';
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
      -- get_next_lead serves follow-ups due before the end of the owner's day as DUE_TODAY. The call made
      -- for that follow-up completes it; otherwise the lead returns as OVERDUE once the due time passes.
      select coalesce(
               (select p.timezone from public.leads l join public.profiles p on p.id = l.assigned_to where l.id = v_lead_id),
               (select p.timezone from public.profiles p where p.id = v_uid),
               'UTC')
        into v_tz;
      v_end_of_today := ((date_trunc('day', now() at time zone v_tz) + interval '1 day') at time zone v_tz);

      update public.follow_ups f
         set completed_at = now()
       where f.lead_id = v_lead_id
         and f.completed_at is null
         and f.due_at < v_end_of_today;

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
-- mark_voicemail_heard: only the voicemail's owner clears it (D20)
-- ---------------------------------------------------------------------------------------------
-- Returns true when the call is an accessible voicemail (now or already handled), else false. An admin
-- playing a voicemail that belongs to an agent (their lead, or an unmatched call routed to them) gets
-- true but leaves it unheard, so the agent's badge and Next Lead VOICEMAIL priority stay.
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

  if (v_lead_id is not null and v_owner is not null and v_owner <> v_uid)
     or (v_lead_id is null and v_call_user is not null and v_call_user <> v_uid) then
    return true;
  end if;

  update public.calls c
     set handled_at = now()
   where c.id = v_call_id
     and c.handled_at is null;
  return true;
end;
$$;
