-- Stage 7: follow-up lists (SPEC 8 "Follow-ups", SPEC 3 "Manage their own follow-ups").
--
-- Both functions are SECURITY INVOKER: the follow_ups and leads RLS policies scope every row, so an
-- agent only ever sees their own follow-ups on leads currently assigned to them, and an admin sees all.
-- Non-admins also get explicit owner filters (defense in depth, like search_leads).

-- ---------------------------------------------------------------------------------------------
-- list_follow_ups(p_tab, p_limit, p_offset)
--   overdue   open, due_at < now()                              oldest first
--   today     open, now() <= due_at < end of today (caller tz)  soonest first
--   upcoming  open, due_at >= end of today                      soonest first
--   completed completed_at is not null                          newest completion first
-- owner_name is filled for admins only; agents never read profiles here.
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_follow_ups(
  p_tab text,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  follow_up_id uuid,
  lead_id uuid,
  business_name text,
  contact_name text,
  phone text,
  lead_status public.lead_status,
  due_at timestamptz,
  completed_at timestamptz,
  note text,
  owner_name text,
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
  v_tab text := lower(btrim(coalesce(p_tab, '')));
  v_admin boolean;
  v_tz text;
  v_now timestamptz := now();
  v_end_of_today timestamptz;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if v_tab not in ('overdue', 'today', 'upcoming', 'completed') then
    raise exception 'invalid tab' using errcode = '22023';
  end if;
  if v_uid is null then
    return;
  end if;

  -- RLS returns the caller's own profile only while they are active.
  select p.timezone into v_tz from public.profiles p where p.id = v_uid and p.active;
  if not found then
    return;
  end if;
  v_admin := public.is_admin();
  v_end_of_today := ((date_trunc('day', v_now at time zone v_tz) + interval '1 day') at time zone v_tz);

  if v_admin then
    return query
    select
      f.id, f.lead_id, l.business_name, l.contact_name, l.phone, l.status,
      f.due_at, f.completed_at, f.note,
      coalesce(nullif(btrim(p.name), ''), p.email),
      count(*) over ()
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id
    left join public.profiles p on p.id = f.user_id
    where case v_tab
            when 'overdue' then f.completed_at is null and f.due_at < v_now
            when 'today' then f.completed_at is null and f.due_at >= v_now and f.due_at < v_end_of_today
            when 'upcoming' then f.completed_at is null and f.due_at >= v_end_of_today
            else f.completed_at is not null
          end
    order by
      case when v_tab = 'completed' then f.completed_at end desc,
      case when v_tab <> 'completed' then f.due_at end asc,
      f.id asc
    limit v_limit
    offset v_offset;
  else
    return query
    select
      f.id, f.lead_id, l.business_name, l.contact_name, l.phone, l.status,
      f.due_at, f.completed_at, f.note,
      null::text,
      count(*) over ()
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id
    where f.user_id = v_uid
      and l.assigned_to = v_uid
      and case v_tab
            when 'overdue' then f.completed_at is null and f.due_at < v_now
            when 'today' then f.completed_at is null and f.due_at >= v_now and f.due_at < v_end_of_today
            when 'upcoming' then f.completed_at is null and f.due_at >= v_end_of_today
            else f.completed_at is not null
          end
    order by
      case when v_tab = 'completed' then f.completed_at end desc,
      case when v_tab <> 'completed' then f.due_at end asc,
      f.id asc
    limit v_limit
    offset v_offset;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- follow_up_tab_counts() -> { overdue, today, upcoming, completed, voicemails_unheard }
-- Same scoping and boundaries as list_follow_ups; voicemails_unheard = unheard_voicemail_count().
-- ---------------------------------------------------------------------------------------------
create or replace function public.follow_up_tab_counts()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_tz text;
  v_now timestamptz := now();
  v_end_of_today timestamptz;
  v_result jsonb;
begin
  if v_uid is not null then
    select p.timezone into v_tz from public.profiles p where p.id = v_uid and p.active;
  end if;
  if v_tz is null then
    return jsonb_build_object('overdue', 0, 'today', 0, 'upcoming', 0, 'completed', 0, 'voicemails_unheard', 0);
  end if;
  v_admin := public.is_admin();
  v_end_of_today := ((date_trunc('day', v_now at time zone v_tz) + interval '1 day') at time zone v_tz);

  select jsonb_build_object(
    'overdue', count(*) filter (where f.completed_at is null and f.due_at < v_now),
    'today', count(*) filter (where f.completed_at is null and f.due_at >= v_now and f.due_at < v_end_of_today),
    'upcoming', count(*) filter (where f.completed_at is null and f.due_at >= v_end_of_today),
    'completed', count(*) filter (where f.completed_at is not null),
    'voicemails_unheard', coalesce(public.unheard_voicemail_count(), 0)
  )
  into v_result
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id
  where v_admin or (f.user_id = v_uid and l.assigned_to = v_uid);

  return v_result;
end;
$$;

revoke execute on function public.list_follow_ups(text, integer, integer) from public, anon;
revoke execute on function public.follow_up_tab_counts() from public, anon;
grant execute on function public.list_follow_ups(text, integer, integer) to authenticated, service_role;
grant execute on function public.follow_up_tab_counts() to authenticated, service_role;
