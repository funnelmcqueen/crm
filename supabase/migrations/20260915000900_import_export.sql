-- Stage 9: CSV import duplicate lookup (SPEC section 9) and CSV export paging (SPEC section 10).

-- ---------------------------------------------------------------------------------------------
-- find_duplicate_leads (admin only)
-- ---------------------------------------------------------------------------------------------
-- Returns the existing leads that share a normalized phone, a normalized website domain or a
-- business+city key (leads.dedupe_name_key) with any of the given keys. Admin only (42501
-- otherwise). SECURITY INVOKER, so RLS applies on top of the explicit admin check. Each array may
-- hold at most 1000 entries (the import sends chunks of 1000); null arrays count as empty. Each key
-- type is looked up on its own index (leads_phone_idx, leads_website_domain_idx,
-- leads_dedupe_name_key_idx).

create or replace function public.find_duplicate_leads(p_phones text[], p_domains text[], p_name_keys text[])
returns table (
  lead_id uuid,
  business_name text,
  city text,
  phone text,
  website_domain text,
  dedupe_name_key text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_phones text[];
  v_domains text[];
  v_name_keys text[];
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if coalesce(cardinality(p_phones), 0) > 1000
     or coalesce(cardinality(p_domains), 0) > 1000
     or coalesce(cardinality(p_name_keys), 0) > 1000 then
    raise exception 'at most 1000 keys per array' using errcode = '22023';
  end if;

  -- Blank keys identify nothing. A name key for a punctuation-only business name is '|city'.
  select coalesce(array_agg(distinct k), '{}') into v_phones
    from unnest(coalesce(p_phones, '{}'::text[])) as t(k)
   where k is not null and btrim(k) <> '';
  select coalesce(array_agg(distinct lower(btrim(k))), '{}') into v_domains
    from unnest(coalesce(p_domains, '{}'::text[])) as t(k)
   where k is not null and btrim(k) <> '';
  select coalesce(array_agg(distinct k), '{}') into v_name_keys
    from unnest(coalesce(p_name_keys, '{}'::text[])) as t(k)
   where k is not null and k <> '' and left(k, 1) <> '|';

  if cardinality(v_phones) = 0 and cardinality(v_domains) = 0 and cardinality(v_name_keys) = 0 then
    return;
  end if;

  return query
  with matched as (
    select l.id from public.leads l where l.phone = any (v_phones)
    union
    select l.id from public.leads l where l.website_domain = any (v_domains)
    union
    select l.id from public.leads l where l.dedupe_name_key = any (v_name_keys)
  )
  select l.id, l.business_name, l.city, l.phone, l.website_domain, l.dedupe_name_key
    from public.leads l
    join matched m on m.id = l.id
   order by l.created_at, l.id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_leads (SECURITY INVOKER: RLS scopes rows, plus an explicit owner filter)
-- ---------------------------------------------------------------------------------------------
-- The leads list filters of search_leads (same query, status, source, agent and unassigned
-- semantics, including the phone-like digit match of DEVIATIONS D17), keyset-paged in a stable
-- (created_at, id) order for /api/leads/export. Pass the last row's created_at and id to get the
-- next page. p_limit is clamped to 1..1000. Non-admins only ever get their own assigned leads, and
-- p_assigned_to / p_unassigned are ignored for them.

create or replace function public.export_leads(
  p_query text default null,
  p_statuses public.lead_status[] default null,
  p_source text default null,
  p_assigned_to uuid default null,
  p_unassigned boolean default false,
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
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_digits text;
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 1000));
begin
  if v_uid is null or not public.is_active_user() then
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
  select
    l.id, l.created_at, l.business_name, l.contact_name, l.phone, l.email, l.website, l.address,
    l.city, l.state, l.country, l.status, l.notes, l.assigned_to, l.last_contacted_at,
    l.next_follow_up_at, l.call_count
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
    and (
      p_after_created_at is null
      or (l.created_at, l.id) > (p_after_created_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  order by l.created_at asc, l.id asc
  limit v_limit;
end;
$$;

revoke execute on function public.find_duplicate_leads(text[], text[], text[]) from public, anon;
revoke execute on function public.export_leads(text, public.lead_status[], text, uuid, boolean, timestamptz, uuid, integer) from public, anon;

grant execute on function public.find_duplicate_leads(text[], text[], text[]) to authenticated, service_role;
grant execute on function public.export_leads(text, public.lead_status[], text, uuid, boolean, timestamptz, uuid, integer) to authenticated, service_role;
