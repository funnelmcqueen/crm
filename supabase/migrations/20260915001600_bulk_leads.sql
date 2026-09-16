-- Bulk lead actions from the Leads list (docs/DEVIATIONS.md D41).
--
-- Every function here is SECURITY INVOKER, so RLS and the guard triggers decide exactly as they do for the
-- single-lead paths: an agent only ever reaches leads assigned to them, and only the columns they may change
-- (status and follow-ups). Admin-only actions also check is_admin() first, so an agent gets 42501 instead of
-- a silent zero. Every id list is de-duplicated and capped at 5000, the most the Leads page can select.
--
-- The status and assignment functions return each visible lead's previous value, so the app can offer an
-- undo that only reverts leads still holding the value the bulk action set.

-- ---------------------------------------------------------------------------------------------
-- search_lead_ids: every id matching the Leads list filters ("Select all N matching")
-- ---------------------------------------------------------------------------------------------
-- Same visibility and filters as search_leads (20260915000300_core_rpcs.sql); sort and paging do not apply.
-- tests/db/bulk-leads.test.ts pins that both return the same set for the same filters.
create or replace function public.search_lead_ids(
  p_query text default null,
  p_statuses public.lead_status[] default null,
  p_source text default null,
  p_assigned_to uuid default null,
  p_unassigned boolean default false,
  p_limit integer default 5000
)
returns table (
  id uuid,
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
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
begin
  if v_uid is null then
    return;
  end if;

  if v_query is not null then
    v_query := left(v_query, 200);
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_query ~ '^[-+0-9().[:space:]]+$' then
      v_digits := regexp_replace(v_query, '[^0-9]', '', 'g');
    end if;
    if length(v_digits) < 3 then
      v_digits := null;
    end if;
  end if;

  return query
  select l.id, count(*) over ()
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
  order by l.created_at desc, l.id asc
  limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_set_lead_status
-- ---------------------------------------------------------------------------------------------
-- One row per visible lead: `updated`, `unchanged` (already that status, or not the expected status), or
-- `locked` (an agent cannot move a lead off DO_NOT_CONTACT, D12; those leads are left out instead of failing
-- the whole batch in leads_guard). p_expected_status limits the change to leads currently at that status,
-- which is how an undo avoids overwriting a later change.
create or replace function public.bulk_set_lead_status(
  p_lead_ids uuid[],
  p_status public.lead_status,
  p_expected_status public.lead_status default null
)
returns table (
  lead_id uuid,
  previous_status public.lead_status,
  result text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status is null then
    raise exception 'status is required' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  return query
  with visible as (
    select l.id, l.status
      from public.leads l
     where l.id = any (v_ids)
     order by l.id
       for update
  ),
  eligible as (
    select v.id, v.status
      from visible v
     where v.status is distinct from p_status
       and (p_expected_status is null or v.status = p_expected_status)
       and (v_admin or v.status <> 'DO_NOT_CONTACT')
  ),
  updated as (
    update public.leads l
       set status = p_status
      from eligible e
     where l.id = e.id
    returning l.id
  )
  select
    v.id,
    v.status,
    case
      when u.id is not null then 'updated'
      when not v_admin and v.status = 'DO_NOT_CONTACT' and p_status <> 'DO_NOT_CONTACT'
           and (p_expected_status is null or v.status = p_expected_status) then 'locked'
      else 'unchanged'
    end
  from visible v
  left join updated u on u.id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_assign_leads (admin)
-- ---------------------------------------------------------------------------------------------
-- Moves the leads with reassign_leads, so the target check and the open follow-ups moving with the lead are
-- exactly the single-lead behavior. One row per existing lead: `updated` or `unchanged` (already the target's,
-- or, with p_match_expected, not currently owned by p_expected_assigned_to, which is how an undo avoids
-- overwriting a later reassignment). previous_assigned_to is the owner before this call.
create or replace function public.bulk_assign_leads(
  p_lead_ids uuid[],
  p_to_user_id uuid,
  p_expected_assigned_to uuid default null,
  p_match_expected boolean default false
)
returns table (
  lead_id uuid,
  previous_assigned_to uuid,
  result text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_found uuid[];
  v_owners uuid[];
  v_eligible uuid[];
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id order by x.id), '{}'::uuid[]),
         coalesce(array_agg(x.assigned_to order by x.id), '{}'::uuid[])
    into v_found, v_owners
    from (
      select l.id, l.assigned_to
        from public.leads l
       where l.id = any (v_ids)
       order by l.id
         for update
    ) x;

  select coalesce(array_agg(t.id), '{}'::uuid[])
    into v_eligible
    from unnest(v_found, v_owners) as t(id, owner)
   where t.owner is distinct from p_to_user_id
     and (not coalesce(p_match_expected, false) or t.owner is not distinct from p_expected_assigned_to);

  -- Always called, even with nothing to move, so an invalid target is refused (22023) either way.
  perform public.reassign_leads(v_eligible, p_to_user_id);

  return query
  select t.id, t.owner, case when t.id = any (v_eligible) then 'updated' else 'unchanged' end
    from unnest(v_found, v_owners) as t(id, owner);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_schedule_follow_ups
-- ---------------------------------------------------------------------------------------------
-- The bulk form of the lead page's follow-up picker (setNextFollowUp in src/server/services/leads.ts): on each
-- lead, move the follow-up owner's earliest open follow-up to p_due_at, or create one. The owner is the lead's
-- agent when an admin schedules on an assigned lead, otherwise the caller. RLS on follow_ups decides access.
-- p_set_note false keeps a rescheduled follow-up's note; true replaces it (null clears it).
create or replace function public.bulk_schedule_follow_ups(
  p_lead_ids uuid[],
  p_due_at timestamptz,
  p_note text default null,
  p_set_note boolean default false
)
returns table (
  lead_id uuid,
  follow_up_id uuid,
  result text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_admin boolean := public.is_admin();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lead record;
  v_owner uuid;
  v_follow_up uuid;
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;
  if p_due_at is null or p_due_at <= now() - interval '1 day' or p_due_at >= now() + interval '5 years' then
    raise exception 'invalid follow-up time' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  for v_lead in
    select l.id, l.assigned_to
      from public.leads l
     where l.id = any (v_ids)
     order by l.id
       for update
  loop
    v_owner := case when v_admin and v_lead.assigned_to is not null then v_lead.assigned_to else v_uid end;

    select f.id
      into v_follow_up
      from public.follow_ups f
     where f.lead_id = v_lead.id
       and f.user_id = v_owner
       and f.completed_at is null
     order by f.due_at asc, f.created_at asc
     limit 1
       for update;

    if found then
      update public.follow_ups f
         set due_at = p_due_at,
             note = case when coalesce(p_set_note, false) then v_note else f.note end
       where f.id = v_follow_up;
      lead_id := v_lead.id;
      follow_up_id := v_follow_up;
      result := 'rescheduled';
    else
      insert into public.follow_ups (lead_id, user_id, due_at, note)
      values (v_lead.id, v_owner, p_due_at, case when coalesce(p_set_note, false) then v_note end)
      returning id into v_follow_up;
      lead_id := v_lead.id;
      follow_up_id := v_follow_up;
      result := 'created';
    end if;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_complete_follow_ups
-- ---------------------------------------------------------------------------------------------
-- "Clear follow-ups": completes every open follow-up the caller can see on these leads, the same write as
-- Complete on the Follow-ups page. Completed follow-ups stay as history. Returns how many were completed.
create or replace function public.bulk_complete_follow_ups(p_lead_ids uuid[])
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  with completed as (
    update public.follow_ups f
       set completed_at = now()
     where f.lead_id = any (v_ids)
       and f.completed_at is null
    returning f.id
  )
  select count(*)::integer into v_count from completed;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_set_lead_source (admin)
-- ---------------------------------------------------------------------------------------------
-- Blank clears the source. Returns how many leads changed.
create or replace function public.bulk_set_lead_source(p_lead_ids uuid[], p_source text)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;
  if char_length(coalesce(v_source, '')) > 200 then
    raise exception 'source too long' using errcode = '22023';
  end if;

  with changed as (
    update public.leads l
       set source = v_source
     where l.id = any (v_ids)
       and l.source is distinct from v_source
    returning l.id
  )
  select count(*)::integer into v_count from changed;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- bulk_delete_leads (admin)
-- ---------------------------------------------------------------------------------------------
-- The bulk form of the lead page's Delete: a hard delete, calls and follow-ups cascade (SPEC 4).
create or replace function public.bulk_delete_leads(p_lead_ids uuid[])
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  with deleted as (
    delete from public.leads l
     where l.id = any (v_ids)
    returning l.id
  )
  select count(*)::integer into v_count from deleted;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_selected_leads: the export of a selection
-- ---------------------------------------------------------------------------------------------
-- Same columns, visibility and keyset paging as export_leads (20260915000900_import_export.sql), limited to
-- the given ids instead of the list filters.
create or replace function public.export_selected_leads(
  p_lead_ids uuid[],
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 1000
)
returns table (
  id uuid,
  created_at timestamptz,
  business_name text,
  contact_name text,
  phone text,
  email text,
  website text,
  address text,
  city text,
  state text,
  country text,
  status public.lead_status,
  notes text,
  assigned_to uuid,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  call_count integer
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
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_lead_ids, '{}'::uuid[])) as u where u is not null);
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 1000));
begin
  if v_uid is null or not public.is_active_user() then
    return;
  end if;
  if cardinality(v_ids) > 5000 then
    raise exception 'too_many_leads' using errcode = '22023';
  end if;

  return query
  select
    l.id, l.created_at, l.business_name, l.contact_name, l.phone, l.email, l.website, l.address,
    l.city, l.state, l.country, l.status, l.notes, l.assigned_to, l.last_contacted_at,
    l.next_follow_up_at, l.call_count
  from public.leads l
  where (v_admin or l.assigned_to = v_uid)
    and l.id = any (v_ids)
    and (
      p_after_created_at is null
      or (l.created_at, l.id) > (p_after_created_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  order by l.created_at asc, l.id asc
  limit v_limit;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.search_lead_ids(text, public.lead_status[], text, uuid, boolean, integer) from public, anon;
revoke execute on function public.bulk_set_lead_status(uuid[], public.lead_status, public.lead_status) from public, anon;
revoke execute on function public.bulk_assign_leads(uuid[], uuid, uuid, boolean) from public, anon;
revoke execute on function public.bulk_schedule_follow_ups(uuid[], timestamptz, text, boolean) from public, anon;
revoke execute on function public.bulk_complete_follow_ups(uuid[]) from public, anon;
revoke execute on function public.bulk_set_lead_source(uuid[], text) from public, anon;
revoke execute on function public.bulk_delete_leads(uuid[]) from public, anon;
revoke execute on function public.export_selected_leads(uuid[], timestamptz, uuid, integer) from public, anon;

grant execute on function public.search_lead_ids(text, public.lead_status[], text, uuid, boolean, integer) to authenticated, service_role;
grant execute on function public.bulk_set_lead_status(uuid[], public.lead_status, public.lead_status) to authenticated, service_role;
grant execute on function public.bulk_assign_leads(uuid[], uuid, uuid, boolean) to authenticated, service_role;
grant execute on function public.bulk_schedule_follow_ups(uuid[], timestamptz, text, boolean) to authenticated, service_role;
grant execute on function public.bulk_complete_follow_ups(uuid[]) to authenticated, service_role;
grant execute on function public.bulk_set_lead_source(uuid[], text) to authenticated, service_role;
grant execute on function public.bulk_delete_leads(uuid[]) to authenticated, service_role;
grant execute on function public.export_selected_leads(uuid[], timestamptz, uuid, integer) to authenticated, service_role;
