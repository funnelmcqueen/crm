-- The agent "Today" dashboard (docs/DEVIATIONS.md D43): two small read-only functions for the signed-in user.
-- Neither exposes another user's data or any phone number.

-- ---------------------------------------------------------------------------------------------
-- get_my_call_days: the caller's dials on each of their last 7 local days (today last)
-- ---------------------------------------------------------------------------------------------
-- The consistency indicator ("called on 5 of the last 7 days") needs history attributed to whoever made the
-- calls. RLS on calls follows the lead's *current* owner, so a reassigned lead would silently drop days;
-- this reads calls.user_id instead, with exactly get_my_dashboard's dial definition and day boundaries in the
-- caller's timezone (tests/db/stats-consistency.test.ts keeps today's count equal to get_my_dashboard's).
create or replace function public.get_my_call_days()
returns table (
  day date,
  dials bigint
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
  v_today date;
begin
  select p.timezone into v_tz from public.profiles p where p.id = v_uid and p.active;
  if v_uid is null or v_tz is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_today := (now() at time zone v_tz)::date;

  return query
  with days as (
    select (v_today - g.n) as day,
           ((v_today - g.n)::timestamp at time zone v_tz) as day_start,
           ((v_today - g.n + 1)::timestamp at time zone v_tz) as day_end
      from generate_series(0, 6) as g(n)
  )
  select d.day,
         count(c.id) filter (where c.direction = 'OUTBOUND' and (c.outcome is not null or c.provider_call_sid is not null))
    from days d
    left join public.calls c
      on c.user_id = v_uid
     and c.created_at >= d.day_start
     and c.created_at < d.day_end
   group by d.day
   order by d.day asc;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- my_caller_id_available: can an in-app call made now get a caller ID?
-- ---------------------------------------------------------------------------------------------
-- The same choice claim_caller_id makes (an active number assigned to the caller, else an active pool
-- number), answered as a yes/no so the dashboard can warn before a call fails. Agents still never see
-- phone_numbers rows.
create or replace function public.my_caller_id_available()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return exists (
    select 1
      from public.phone_numbers n
     where n.active
       and (n.assigned_to = v_uid or n.assigned_to is null)
  );
end;
$$;

revoke execute on function public.get_my_call_days() from public, anon;
revoke execute on function public.my_caller_id_available() from public, anon;
grant execute on function public.get_my_call_days() to authenticated, service_role;
grant execute on function public.my_caller_id_available() to authenticated, service_role;
