-- Access helpers, caller-dependent guard triggers and RLS policies (ARCHITECTURE 4.4, 4.6, 4.7).

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- SECURITY INVOKER on purpose: inside SECURITY DEFINER functions current_user is the owner, so
-- definer RPCs count as privileged and must do their own checks.
create or replace function public.is_privileged_role()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select current_user not in ('anon', 'authenticated')
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = (select auth.uid())
       and p.role = 'ADMIN'
       and p.active
  )
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = (select auth.uid())
       and p.active
  )
$$;

-- True only for an existing lead the caller may use: admin, or active and currently assigned.
create or replace function public.can_access_lead(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.leads l
     where l.id = p_lead_id
       and (
         public.is_admin()
         or (l.assigned_to = (select auth.uid()) and public.is_active_user())
       )
  )
$$;

create or replace function public.get_company_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.company_name from public.settings s where s.id), 'Funnel McQueen')
$$;

create or replace function public.outcome_to_status(p_outcome public.call_outcome, p_current public.lead_status)
returns public.lead_status
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_outcome is null then p_current
    -- DO_NOT_CONTACT is sticky: only an explicit status change re-opens a lead (DEVIATIONS D11).
    when p_current = 'DO_NOT_CONTACT' then p_current
    when p_outcome in ('NO_ANSWER', 'VOICEMAIL')
         and p_current in ('APPOINTMENT', 'PROPOSAL', 'CLIENT') then p_current
    when p_outcome = 'NO_ANSWER' then 'NO_ANSWER'::public.lead_status
    when p_outcome = 'VOICEMAIL' then 'VOICEMAIL'::public.lead_status
    when p_outcome = 'CONNECTED' then 'CONNECTED'::public.lead_status
    when p_outcome = 'INTERESTED' then 'INTERESTED'::public.lead_status
    when p_outcome = 'FOLLOW_UP' then 'FOLLOW_UP'::public.lead_status
    when p_outcome = 'APPOINTMENT' then 'APPOINTMENT'::public.lead_status
    when p_outcome = 'NOT_INTERESTED' then 'NOT_INTERESTED'::public.lead_status
    when p_outcome = 'WRONG_NUMBER' then 'DO_NOT_CONTACT'::public.lead_status
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- Guard triggers (SECURITY INVOKER: they inspect the real caller through current_user)
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

  if public.is_privileged_role() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at then
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

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- next_follow_up_at is derived. Privileged writers (definer RPCs, the follow_ups sync trigger,
-- service_role) recompute it; API callers keep the stored value, which the sync trigger maintains.
create or replace function public.leads_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A new lead has no follow-ups yet.
    new.next_follow_up_at := null;
    return new;
  end if;

  if public.is_privileged_role() then
    new.next_follow_up_at := public.lead_earliest_open_follow_up(new.id);
    return new;
  end if;

  new.next_follow_up_at := old.next_follow_up_at;

  if public.is_admin() then
    return new;
  end if;

  -- dedupe_name_key is generated and not readable in BEFORE triggers; updated_at is set afterwards.
  if (pg_catalog.to_jsonb(new) - array['status', 'notes', 'next_follow_up_at', 'updated_at', 'dedupe_name_key'])
     is distinct from
     (pg_catalog.to_jsonb(old) - array['status', 'notes', 'next_follow_up_at', 'updated_at', 'dedupe_name_key']) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- DO_NOT_CONTACT is a compliance decision: only an admin re-opens the lead (DEVIATIONS D12).
  if old.status = 'DO_NOT_CONTACT' and new.status is distinct from old.status then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger leads_guard
  before insert or update on public.leads
  for each row execute function public.leads_guard();

create or replace function public.follow_ups_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if public.is_privileged_role() or public.is_admin() then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.lead_id is distinct from old.lead_id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger follow_ups_guard
  before update on public.follow_ups
  for each row execute function public.follow_ups_guard();

-- ---------------------------------------------------------------------------------------------
-- 4.6 Policies (all to authenticated; anon has no table privileges and no policies)
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.leads enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.calls enable row level security;
alter table public.follow_ups enable row level security;
alter table public.rate_limit_hits enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using ((select public.is_admin()) or (id = (select auth.uid()) and (select public.is_active_user())));

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select public.is_admin()) or (id = (select auth.uid()) and (select public.is_active_user())))
  with check ((select public.is_admin()) or (id = (select auth.uid()) and (select public.is_active_user())));

create policy settings_select on public.settings
  for select to authenticated
  using ((select public.is_admin()));

create policy settings_update on public.settings
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy leads_select on public.leads
  for select to authenticated
  using ((select public.is_admin()) or (assigned_to = (select auth.uid()) and (select public.is_active_user())));

create policy leads_update on public.leads
  for update to authenticated
  using ((select public.is_admin()) or (assigned_to = (select auth.uid()) and (select public.is_active_user())))
  with check ((select public.is_admin()) or (assigned_to = (select auth.uid()) and (select public.is_active_user())));

create policy leads_insert on public.leads
  for insert to authenticated
  with check ((select public.is_admin()));

create policy leads_delete on public.leads
  for delete to authenticated
  using ((select public.is_admin()));

create policy calls_select on public.calls
  for select to authenticated
  using (
    (select public.is_admin())
    or (
      (select public.is_active_user())
      and (
        (
          calls.lead_id is not null
          and exists (
            select 1 from public.leads l
             where l.id = calls.lead_id
               and l.assigned_to = (select auth.uid())
          )
        )
        or (calls.lead_id is null and calls.user_id = (select auth.uid()))
      )
    )
  );

create policy calls_insert on public.calls
  for insert to authenticated
  with check ((select public.is_admin()));

create policy calls_update on public.calls
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy calls_delete on public.calls
  for delete to authenticated
  using ((select public.is_admin()));

create policy follow_ups_all on public.follow_ups
  for all to authenticated
  using (
    (select public.is_admin())
    or (
      (select public.is_active_user())
      and follow_ups.user_id = (select auth.uid())
      and exists (
        select 1 from public.leads l
         where l.id = follow_ups.lead_id
           and l.assigned_to = (select auth.uid())
      )
    )
  )
  with check (
    (select public.is_admin())
    or (
      (select public.is_active_user())
      and follow_ups.user_id = (select auth.uid())
      and exists (
        select 1 from public.leads l
         where l.id = follow_ups.lead_id
           and l.assigned_to = (select auth.uid())
      )
    )
  );

create policy phone_numbers_all on public.phone_numbers
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- rate_limit_hits: intentionally no policies.

-- ---------------------------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.is_privileged_role() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.can_access_lead(uuid) from public, anon;
revoke execute on function public.get_company_name() from public, anon;
revoke execute on function public.outcome_to_status(public.call_outcome, public.lead_status) from public, anon;
revoke execute on function public.profiles_guard() from public, anon, authenticated, service_role;
revoke execute on function public.leads_guard() from public, anon, authenticated, service_role;
revoke execute on function public.follow_ups_guard() from public, anon, authenticated, service_role;

-- is_privileged_role is called by the invoker guard triggers as the API role (it only reveals
-- that the caller is not privileged). is_admin/is_active_user are used by the policies.
grant execute on function public.is_privileged_role() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_active_user() to authenticated, service_role;
grant execute on function public.can_access_lead(uuid) to authenticated, service_role;
grant execute on function public.outcome_to_status(public.call_outcome, public.lead_status) to authenticated, service_role;
grant execute on function public.get_company_name() to anon, authenticated, service_role;
