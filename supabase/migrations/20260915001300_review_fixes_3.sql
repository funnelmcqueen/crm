-- Final review round. Two changes, both about cost rather than correctness; neither changes who can
-- see what.
--
--   * get_next_lead     computes the voicemail and follow-up lookups set-based instead of once per
--                       assigned lead. Same rows, same order, same reason codes.
--   * apply_rate_limit  gains an `export` bucket, and consume_rate_limit accepts it, so the CSV export
--                       route cannot be looped without bound.

-- ---------------------------------------------------------------------------------------------
-- Supports the set-based voicemail lookup below, and the voicemail badge/list queries alongside it.
-- Tiny: it indexes only voicemails nobody has handled yet.
-- ---------------------------------------------------------------------------------------------
create index if not exists calls_open_voicemail_lead_idx
  on public.calls (lead_id)
  where voicemail_recording_sid is not null and handled_at is null;

-- ---------------------------------------------------------------------------------------------
-- get_next_lead: the hot path (every agent dashboard render, every Save & Next)
-- ---------------------------------------------------------------------------------------------
-- The candidates CTE used to attach two correlated scalar subqueries to every one of the caller's
-- assigned leads -- the oldest unhandled voicemail and the earliest open follow-up -- before any bucket
-- filtering and before the LIMIT 1. The only filter applied first was `assigned_to = v_uid`, so one
-- suggestion walked the agent's whole book twice over, and the cost grew with leads-per-agent.
--
-- The lookups are now one grouped pass per child table over just this caller's leads, joined back on.
-- `mine` is materialized on purpose: it is referenced three times and must be computed once.
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
  with mine as materialized (
    select l.id, l.business_name, l.contact_name, l.phone, l.status, l.city, l.state,
           l.last_contacted_at, l.next_follow_up_at, l.call_count, l.created_at
      from public.leads l
     where l.assigned_to = v_uid
       and l.status not in ('CLIENT', 'NOT_INTERESTED', 'DO_NOT_CONTACT')
       and l.id <> all (v_exclude)
  ),
  vm as (
    select c.lead_id, min(c.created_at) as voicemail_at
      from public.calls c
     where c.voicemail_recording_sid is not null
       and c.handled_at is null
       and exists (select 1 from mine m where m.id = c.lead_id)
     group by c.lead_id
  ),
  fu as (
    select f.lead_id, min(f.due_at) as follow_up_due_at
      from public.follow_ups f
     where f.completed_at is null
       and exists (select 1 from mine m where m.id = f.lead_id)
     group by f.lead_id
  ),
  candidates as (
    select m.*, vm.voicemail_at, fu.follow_up_due_at
      from mine m
      left join vm on vm.lead_id = m.id
      left join fu on fu.lead_id = m.id
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
-- Rate limits: an `export` bucket
-- ---------------------------------------------------------------------------------------------
-- SPEC 12 names the token endpoint and outbound call creation, and both are covered. The CSV export was
-- not: every call pages the caller's whole assigned book (an admin's covers every lead in the system)
-- at up to 1000 rows a page, with no cap on pages. It leaks nothing -- RLS and the route's explicit
-- assigned_to filter hold -- but it is an unbounded cost driver per request. The policy stays here,
-- never in caller arguments (D14).
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
    when 'export' then
      v_max := 30;
      v_window := interval '10 minutes';
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

-- For limits a route checks before work that has no RPC of its own (issuing a Twilio token, streaming
-- an export). outbound_call is enforced inside create_outbound_call and is still not accepted here.
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
  if p_bucket is null or p_bucket not in ('voice_token', 'export') then
    raise exception 'invalid bucket' using errcode = '22023';
  end if;
  return public.apply_rate_limit(v_uid, p_bucket);
end;
$$;
