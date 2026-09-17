-- Closer calendar booking (docs/DEVIATIONS.md D46,
-- docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md).

-- ---------------------------------------------------------------------------------------------
-- 1. Business type
-- ---------------------------------------------------------------------------------------------
create type public.business_type as enum (
  'restaurant', 'cafe_bakery', 'hotel_motel', 'home_services', 'auto', 'retail', 'beauty', 'other'
);

-- Null means "guess from the business name" (src/lib/domain/business-type.ts).
alter table public.leads add column business_type public.business_type;

-- Agents may change only status and notes by direct update (leads_guard), so a correction from the
-- booking panel goes through this guarded function. Admin: any lead. Agent: leads assigned to them.
create or replace function public.set_lead_business_type(p_lead_id uuid, p_type public.business_type default null)
returns void
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

  update public.leads l
     set business_type = p_type
   where l.id = p_lead_id
     and (public.is_admin() or l.assigned_to = v_uid);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Bulk action on All Leads (admin), same shape as bulk_set_lead_source (D41). Null clears.
create or replace function public.bulk_set_business_type(p_lead_ids uuid[], p_type public.business_type default null)
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

  with changed as (
    update public.leads l
       set business_type = p_type
     where l.id = any (v_ids)
       and l.business_type is distinct from p_type
    returning l.id
  )
  select count(*)::integer into v_count from changed;
  return v_count;
end;
$$;

revoke execute on function public.set_lead_business_type(uuid, public.business_type) from public, anon;
revoke execute on function public.bulk_set_business_type(uuid[], public.business_type) from public, anon;
grant execute on function public.set_lead_business_type(uuid, public.business_type) to authenticated, service_role;
grant execute on function public.bulk_set_business_type(uuid[], public.business_type) to authenticated, service_role;
