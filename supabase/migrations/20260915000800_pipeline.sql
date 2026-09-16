-- Stage 8: pipeline (SPEC 8 "Pipeline"). One page of one pipeline column.
--
-- SECURITY INVOKER: RLS scopes the rows, and non-admins also get an explicit assigned_to = auth.uid()
-- filter, exactly like search_leads. p_assigned_to / p_unassigned are admin filters and are ignored
-- for everyone else.
--
-- Order within a column (DEVIATIONS "Pipeline column order"): next_follow_up_at asc nulls last, then
-- updated_at desc, then id asc as a stable tie-breaker so paging never repeats or skips a card.

create or replace function public.pipeline_column(
  p_statuses public.lead_status[],
  p_limit integer default 20,
  p_offset integer default 0,
  p_assigned_to uuid default null,
  p_unassigned boolean default false
)
returns table (
  id uuid,
  business_name text,
  contact_name text,
  phone text,
  status public.lead_status,
  assigned_to uuid,
  next_follow_up_at timestamptz,
  updated_at timestamptz,
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
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 1000000));
begin
  -- A column always names its statuses; no statuses means no cards (never "every status").
  if v_uid is null or p_statuses is null or cardinality(p_statuses) = 0 then
    return;
  end if;

  return query
  select
    l.id, l.business_name, l.contact_name, l.phone, l.status, l.assigned_to,
    l.next_follow_up_at, l.updated_at, l.call_count,
    count(*) over ()
  from public.leads l
  where (v_admin or l.assigned_to = v_uid)
    and l.status = any (p_statuses)
    and (
      not v_admin
      or (
        (p_assigned_to is null or l.assigned_to = p_assigned_to)
        and (not coalesce(p_unassigned, false) or l.assigned_to is null)
      )
    )
  order by l.next_follow_up_at asc nulls last, l.updated_at desc, l.id asc
  limit v_limit
  offset v_offset;
end;
$$;

revoke execute on function public.pipeline_column(public.lead_status[], integer, integer, uuid, boolean) from public, anon;
grant execute on function public.pipeline_column(public.lead_status[], integer, integer, uuid, boolean) to authenticated, service_role;
