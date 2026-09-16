-- Skipped queue (docs/DEVIATIONS.md D42).
--
-- Skipping a lead in the Next Lead flow used to only add its id to the URL, so the lead came back as soon as
-- the agent started a new session. A skip is now a row: who skipped which lead, when, an optional structured
-- reason and note. While it is open the lead stays out of get_next_lead and sits in the Skipped queue
-- (Follow-ups > Skipped). A skip closes on its own when the work moves on (the lead is called, its status
-- changes, a follow-up is scheduled for the skipper, or it is reassigned to someone else) or when the agent
-- resumes it. Closed skips stay as history on the lead.

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------
create table public.lead_skips (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete restrict,
  reason text constraint lead_skips_reason_valid
    check (reason in ('CALL_LATER', 'NEEDS_RESEARCH', 'BAD_DATA', 'NOT_PRIORITY', 'OTHER')),
  note text constraint lead_skips_note_length check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text constraint lead_skips_resolution_valid
    check (resolution in ('RESUMED', 'CALLED', 'STATUS_CHANGED', 'FOLLOW_UP', 'REASSIGNED', 'SKIPPED_AGAIN')),
  constraint lead_skips_resolution_consistent check ((resolved_at is null) = (resolution is null))
);

-- One open skip per lead per user; skipping again closes the previous one first.
create unique index lead_skips_open_lead_user_key on public.lead_skips (lead_id, user_id) where resolved_at is null;
create index lead_skips_user_open_idx on public.lead_skips (user_id, created_at) where resolved_at is null;
create index lead_skips_lead_created_idx on public.lead_skips (lead_id, created_at);

alter table public.lead_skips enable row level security;

-- Read through RLS; every write goes through the RPCs and triggers below.
revoke all on public.lead_skips from anon, authenticated;
grant select on public.lead_skips to authenticated;

-- Same shape as follow_ups: an agent sees their own skips on leads assigned to them; an admin sees all.
create policy lead_skips_select on public.lead_skips
  for select to authenticated
  using (
    (select public.is_admin())
    or (
      (select public.is_active_user())
      and lead_skips.user_id = (select auth.uid())
      and exists (
        select 1 from public.leads l
         where l.id = lead_skips.lead_id
           and l.assigned_to = (select auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------------------------------
-- skip_lead: the Skip button
-- ---------------------------------------------------------------------------------------------
-- Only the lead's owner skips it (Next Lead only ever offers the caller's own leads). A lead the caller does
-- not own answers P0002, the same as one that does not exist.
create or replace function public.skip_lead(p_lead_id uuid, p_reason text default null, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(upper(btrim(coalesce(p_reason, ''))), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_reason is not null and v_reason not in ('CALL_LATER', 'NEEDS_RESEARCH', 'BAD_DATA', 'NOT_PRIORITY', 'OTHER') then
    raise exception 'invalid skip reason' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  perform 1 from public.leads l where l.id = p_lead_id and l.assigned_to = v_uid for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update public.lead_skips s
     set resolved_at = now(), resolution = 'SKIPPED_AGAIN'
   where s.lead_id = p_lead_id
     and s.user_id = v_uid
     and s.resolved_at is null;

  insert into public.lead_skips (lead_id, user_id, reason, note)
  values (p_lead_id, v_uid, v_reason, v_note)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- resume_skipped_lead: "Resume calling" puts the lead back in the call queue
-- ---------------------------------------------------------------------------------------------
-- An agent resumes their own skip on their own lead; an admin closes every open skip on the lead.
-- Returns how many skips were closed (0 when there was nothing open or nothing visible).
create or replace function public.resume_skipped_lead(p_lead_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := public.is_admin();
  v_count integer;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with resumed as (
    update public.lead_skips s
       set resolved_at = now(), resolution = 'RESUMED'
     where s.lead_id = p_lead_id
       and s.resolved_at is null
       and (
         v_admin
         or (
           s.user_id = v_uid
           and exists (select 1 from public.leads l where l.id = s.lead_id and l.assigned_to = v_uid)
         )
       )
    returning s.id
  )
  select count(*)::integer into v_count from resumed;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- list_skipped_leads: the Skipped queue, longest-waiting first
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_skipped_leads(p_limit integer default 25, p_offset integer default 0)
returns table (
  skip_id uuid,
  lead_id uuid,
  business_name text,
  contact_name text,
  phone text,
  lead_status public.lead_status,
  reason text,
  note text,
  skipped_at timestamptz,
  next_follow_up_at timestamptz,
  assigned_to uuid,
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
  v_admin boolean := public.is_admin();
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if v_uid is null or not public.is_active_user() then
    return;
  end if;

  return query
  select
    s.id, s.lead_id, l.business_name, l.contact_name, l.phone, l.status, s.reason, s.note, s.created_at,
    l.next_follow_up_at,
    case when v_admin then l.assigned_to end,
    case when v_admin then coalesce(nullif(btrim(p.name), ''), p.email) end,
    count(*) over ()
  from public.lead_skips s
  join public.leads l on l.id = s.lead_id
  left join public.profiles p on v_admin and p.id = s.user_id
  where s.resolved_at is null
    and (v_admin or (s.user_id = v_uid and l.assigned_to = v_uid))
  order by s.created_at asc, s.id asc
  limit v_limit
  offset v_offset;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Closing skips when the work moves on
-- ---------------------------------------------------------------------------------------------
-- Calling the lead (log_call sets last_contacted_at) or changing its status closes every open skip on it.
-- Reassigning closes the skips of everyone who no longer owns it, so a lead never waits in the queue of an
-- agent who cannot see it, and never surprises its new owner.
create or replace function public.leads_resolve_skips()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    update public.lead_skips s
       set resolved_at = now(), resolution = 'REASSIGNED'
     where s.lead_id = new.id
       and s.resolved_at is null
       and s.user_id is distinct from new.assigned_to;
  end if;

  if new.last_contacted_at is distinct from old.last_contacted_at then
    update public.lead_skips s
       set resolved_at = now(), resolution = 'CALLED'
     where s.lead_id = new.id
       and s.resolved_at is null;
  elsif new.status is distinct from old.status then
    update public.lead_skips s
       set resolved_at = now(), resolution = 'STATUS_CHANGED'
     where s.lead_id = new.id
       and s.resolved_at is null;
  end if;

  return null;
end;
$$;

create trigger leads_resolve_skips
  after update of assigned_to, status, last_contacted_at on public.leads
  for each row execute function public.leads_resolve_skips();

-- Scheduling (or rescheduling) an open follow-up closes that user's skip on the lead: the follow-up now says
-- when to call. Completing a follow-up does not.
create or replace function public.follow_ups_resolve_skips()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.completed_at is null and (tg_op = 'INSERT' or new.due_at is distinct from old.due_at) then
    update public.lead_skips s
       set resolved_at = now(), resolution = 'FOLLOW_UP'
     where s.lead_id = new.lead_id
       and s.user_id = new.user_id
       and s.resolved_at is null;
  end if;
  return null;
end;
$$;

create trigger follow_ups_resolve_skips
  after insert or update of due_at on public.follow_ups
  for each row execute function public.follow_ups_resolve_skips();

-- ---------------------------------------------------------------------------------------------
-- get_next_lead: leave out leads the caller skipped
-- ---------------------------------------------------------------------------------------------
-- Unchanged from 20260915001300_review_fixes_3.sql except one condition in `mine`: a lead with an open skip by
-- the caller is not suggested, whatever its bucket, until the skip closes. p_exclude_ids still works for the
-- URL skip list the Next Lead flow falls back to when saving a skip fails.
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
       and not exists (
         select 1 from public.lead_skips s
          where s.lead_id = l.id
            and s.user_id = v_uid
            and s.resolved_at is null
       )
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
-- Grants
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.skip_lead(uuid, text, text) from public, anon;
revoke execute on function public.resume_skipped_lead(uuid) from public, anon;
revoke execute on function public.list_skipped_leads(integer, integer) from public, anon;
revoke execute on function public.leads_resolve_skips() from public, anon, authenticated, service_role;
revoke execute on function public.follow_ups_resolve_skips() from public, anon, authenticated, service_role;

grant execute on function public.skip_lead(uuid, text, text) to authenticated, service_role;
grant execute on function public.resume_skipped_lead(uuid) to authenticated, service_role;
grant execute on function public.list_skipped_leads(integer, integer) to authenticated, service_role;
