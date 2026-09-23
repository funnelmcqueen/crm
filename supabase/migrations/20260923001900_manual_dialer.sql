-- A manual outbound call belongs to its caller and has a remote destination without a lead.
alter table public.calls drop constraint calls_outbound_has_owner_and_lead;
alter table public.calls add constraint calls_outbound_has_owner_and_destination
  check (
    direction = 'INBOUND'
    or (user_id is not null and (lead_id is not null or remote_e164 is not null))
  );

create function public.create_manual_outbound_call(p_remote_e164 text, p_mode public.call_mode)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_call_id uuid;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- The same profile row lock as create_outbound_call serializes both call creation paths.
  select * into v_profile from public.profiles p where p.id = v_uid for update;
  if not found or not v_profile.active or (p_mode = 'IN_APP' and not v_profile.in_app_calling_enabled) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_mode is null or p_mode not in ('IN_APP', 'TEL') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if p_remote_e164 is null or p_remote_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid_destination' using errcode = '22023';
  end if;

  -- Only unclaimed manual IN_APP rows from this caller are replaceable.
  delete from public.calls c
   where c.user_id = v_uid
     and c.lead_id is null
     and c.direction = 'OUTBOUND'
     and c.mode = 'IN_APP'
     and c.provider_call_sid is null
     and c.call_status is null
     and c.outcome is null;

  if exists (
    select 1 from public.calls c
     where c.user_id = v_uid
       and c.outcome is null
       and c.call_status in ('queued', 'ringing', 'in-progress')
       and c.created_at > now() - interval '2 hours'
  ) then
    raise exception 'call_in_progress' using errcode = 'P0001';
  end if;

  if not public.apply_rate_limit(v_uid, 'outbound_call') then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.calls (direction, mode, user_id, lead_id, remote_e164)
  values ('OUTBOUND', p_mode, v_uid, null, p_remote_e164)
  returning id into v_call_id;

  return v_call_id;
end;
$$;

revoke execute on function public.create_manual_outbound_call(text, public.call_mode) from public, anon;
grant execute on function public.create_manual_outbound_call(text, public.call_mode) to authenticated, service_role;
