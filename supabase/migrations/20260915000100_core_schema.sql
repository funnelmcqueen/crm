-- Core schema: enums, tables, indexes, integrity triggers and table privileges.
-- Row level security is enabled here (deny by default) so no table is ever exposed without it.
-- Policies and guard triggers: 20260915000200_rls.sql. API functions: 20260915000300_core_rpcs.sql.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- 4.1 Enums
-- ---------------------------------------------------------------------------------------------
create type public.user_role as enum ('ADMIN', 'AGENT');
create type public.lead_status as enum (
  'NEW', 'TO_CALL', 'NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP',
  'APPOINTMENT', 'PROPOSAL', 'CLIENT', 'NOT_INTERESTED', 'DO_NOT_CONTACT'
);
create type public.call_outcome as enum (
  'NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'APPOINTMENT',
  'NOT_INTERESTED', 'WRONG_NUMBER'
);
create type public.call_direction as enum ('OUTBOUND', 'INBOUND');
create type public.call_mode as enum ('IN_APP', 'TEL');

-- ---------------------------------------------------------------------------------------------
-- 4.2 Tables
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  email text not null,
  name text not null default '' constraint profiles_name_length check (char_length(name) <= 200),
  role public.user_role not null default 'AGENT',
  active boolean not null default true,
  daily_call_target integer not null default 50
    constraint profiles_daily_call_target_range check (daily_call_target between 0 and 1000),
  timezone text not null default 'America/New_York',
  in_app_calling_enabled boolean not null default true,
  device_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.settings (
  id boolean primary key default true constraint settings_single_row check (id),
  company_name text not null default 'Funnel McQueen',
  default_daily_target integer not null default 50
    constraint settings_default_daily_target_range check (default_daily_target between 0 and 1000),
  default_timezone text not null default 'America/New_York',
  voicemail_greeting text not null
    default 'Sorry we missed your call. Please leave a message after the beep.',
  updated_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  business_name text not null constraint leads_business_name_not_blank check (btrim(business_name) <> ''),
  contact_name text,
  phone text not null constraint leads_phone_e164 check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  phone_raw text,
  email text,
  website text,
  website_domain text,
  address text,
  city text,
  state text,
  country text,
  source text,
  status public.lead_status not null default 'NEW',
  notes text,
  assigned_to uuid references public.profiles (id) on delete restrict,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  call_count integer not null default 0 constraint leads_call_count_non_negative check (call_count >= 0),
  dedupe_name_key text generated always as (
    lower(regexp_replace(business_name, '[^A-Za-z0-9]+', '', 'g'))
    || '|'
    || lower(regexp_replace(coalesce(city, ''), '[^A-Za-z0-9]+', '', 'g'))
  ) stored
);

create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null constraint phone_numbers_e164_key unique
    constraint phone_numbers_e164_format check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  twilio_sid text not null constraint phone_numbers_twilio_sid_key unique,
  label text,
  active boolean not null default true,
  assigned_to uuid references public.profiles (id) on delete restrict,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid references public.leads (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete restrict,
  direction public.call_direction not null,
  mode public.call_mode not null,
  phone_number_id uuid references public.phone_numbers (id) on delete restrict,
  remote_e164 text,
  provider_call_sid text constraint calls_provider_call_sid_key unique,
  call_status text constraint calls_call_status_valid check (
    call_status in ('queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled')
  ),
  outcome public.call_outcome,
  notes text,
  duration_seconds integer constraint calls_duration_non_negative check (duration_seconds >= 0),
  voicemail_recording_sid text,
  voicemail_duration_seconds integer
    constraint calls_voicemail_duration_non_negative check (voicemail_duration_seconds >= 0),
  handled_at timestamptz,
  -- Idempotency key of a TEL call logged by the client (log_call p_call_id). Never the row id, so
  -- a client-chosen id can never collide with (and reveal) another row.
  client_request_id uuid,
  constraint calls_outbound_has_owner_and_lead check (
    direction = 'INBOUND' or (user_id is not null and lead_id is not null)
  ),
  constraint calls_provider_sid_requires_in_app check (mode = 'IN_APP' or provider_call_sid is null)
);

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  due_at timestamptz not null,
  completed_at timestamptz,
  note text
);

create table public.rate_limit_hits (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  bucket text not null,
  created_at timestamptz not null default now()
);

insert into public.settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 4.3 Indexes (calls.provider_call_sid is covered by its unique constraint)
-- ---------------------------------------------------------------------------------------------
create index leads_assigned_to_status_idx on public.leads (assigned_to, status);
create index leads_assigned_to_next_follow_up_at_idx on public.leads (assigned_to, next_follow_up_at);
create index leads_assigned_to_last_contacted_at_idx on public.leads (assigned_to, last_contacted_at);
create index leads_phone_idx on public.leads (phone);
create index leads_website_domain_idx on public.leads (website_domain);
create index leads_dedupe_name_key_idx on public.leads (dedupe_name_key);
create index leads_created_at_idx on public.leads (created_at);
create index leads_business_name_trgm_idx on public.leads using gin (business_name extensions.gin_trgm_ops);
create index leads_contact_name_trgm_idx on public.leads using gin (contact_name extensions.gin_trgm_ops);
create index leads_email_trgm_idx on public.leads using gin (email extensions.gin_trgm_ops);
create index leads_website_trgm_idx on public.leads using gin (website extensions.gin_trgm_ops);
create index leads_city_trgm_idx on public.leads using gin (city extensions.gin_trgm_ops);
create index leads_phone_trgm_idx on public.leads using gin (phone extensions.gin_trgm_ops);

create index calls_user_id_created_at_idx on public.calls (user_id, created_at);
create index calls_lead_id_created_at_idx on public.calls (lead_id, created_at);
-- Supports per-number reports and the ON DELETE RESTRICT check on phone_numbers.
create index calls_phone_number_id_created_at_idx on public.calls (phone_number_id, created_at);
-- Scoped per caller and lead: a key is only ever looked up on a lead the caller can access.
create unique index calls_client_request_key on public.calls (user_id, lead_id, client_request_id)
  where client_request_id is not null;

create index follow_ups_user_id_due_at_open_idx on public.follow_ups (user_id, due_at) where completed_at is null;
create index follow_ups_lead_id_open_idx on public.follow_ups (lead_id) where completed_at is null;

create index phone_numbers_assigned_to_idx on public.phone_numbers (assigned_to);

create index rate_limit_hits_user_bucket_created_at_idx on public.rate_limit_hits (user_id, bucket, created_at);

-- ---------------------------------------------------------------------------------------------
-- 4.4 Integrity triggers (guards that depend on the caller live in the RLS migration)
-- ---------------------------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

create or replace function public.profiles_validate_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = new.timezone) then
    raise exception 'invalid timezone' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.profiles_validate_timezone();

create or replace function public.settings_validate_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = new.default_timezone) then
    raise exception 'invalid timezone' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger settings_validate_timezone
  before insert or update of default_timezone on public.settings
  for each row execute function public.settings_validate_timezone();

-- New auth users always become active AGENTs. Role is never taken from user metadata.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target integer := 50;
  v_timezone text := 'America/New_York';
begin
  select s.default_daily_target, s.default_timezone
    into v_target, v_timezone
    from public.settings s
   where s.id;
  if not found then
    v_target := 50;
    v_timezone := 'America/New_York';
  end if;

  insert into public.profiles (id, email, name, role, active, daily_call_target, timezone)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    ), 200),
    'AGENT',
    true,
    v_target,
    v_timezone
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.handle_auth_user_email_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles p
       set email = coalesce(new.email, '')
     where p.id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_user_email_changed();

create or replace function public.lead_earliest_open_follow_up(p_lead_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(f.due_at)
    from public.follow_ups f
   where f.lead_id = p_lead_id
     and f.completed_at is null
$$;

-- Keeps leads.next_follow_up_at equal to the earliest open follow-up. The update runs as the
-- function owner, so leads_guard takes its privileged branch and recomputes the value.
create or replace function public.follow_ups_sync_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.leads l
       set next_follow_up_at = public.lead_earliest_open_follow_up(l.id)
     where l.id = old.lead_id
       and l.next_follow_up_at is distinct from public.lead_earliest_open_follow_up(l.id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.lead_id is distinct from old.lead_id) then
    update public.leads l
       set next_follow_up_at = public.lead_earliest_open_follow_up(l.id)
     where l.id = new.lead_id
       and l.next_follow_up_at is distinct from public.lead_earliest_open_follow_up(l.id);
  end if;
  return null;
end;
$$;

create trigger follow_ups_sync_lead
  after insert or update or delete on public.follow_ups
  for each row execute function public.follow_ups_sync_lead();

-- Open follow-ups always belong to the lead's owner, whatever path assigns the lead (reassign_leads,
-- a direct admin update, an import). Completed follow-ups stay with whoever did them.
create or replace function public.leads_move_open_follow_ups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is not null then
    update public.follow_ups f
       set user_id = new.assigned_to
     where f.lead_id = new.id
       and f.completed_at is null
       and f.user_id <> new.assigned_to;
  end if;
  return null;
end;
$$;

create trigger leads_move_open_follow_ups
  after update of assigned_to on public.leads
  for each row execute function public.leads_move_open_follow_ups();

-- ---------------------------------------------------------------------------------------------
-- Row level security: on for every table, deny by default (policies in the next migration)
-- ---------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.leads enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.calls enable row level security;
alter table public.follow_ups enable row level security;
alter table public.rate_limit_hits enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 4.5 Table privileges (Supabase grants ALL on new public tables to anon/authenticated)
-- ---------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
-- Tables created by later migrations are not granted to anon either.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- RLS does not apply to TRUNCATE, and API roles never need REFERENCES or TRIGGER. The default
-- privileges cover tables that later migrations create.
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;

revoke select on public.calls from authenticated;
grant select (
  id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes,
  duration_seconds, voicemail_duration_seconds, handled_at
) on public.calls to authenticated;

-- API callers never choose follow-up ids or creation times: a chosen id that collides with an
-- existing row would reveal that the row exists.
revoke insert, update on public.follow_ups from authenticated;
grant insert (lead_id, user_id, due_at, note, completed_at) on public.follow_ups to authenticated;
grant update (lead_id, user_id, due_at, note, completed_at) on public.follow_ups to authenticated;

revoke all on public.rate_limit_hits from anon, authenticated;
revoke all on sequence public.rate_limit_hits_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Function privileges. Trigger functions are never callable directly. lead_earliest_open_follow_up
-- is internal; service_role needs it because leads_guard calls it when service_role updates leads.
-- ---------------------------------------------------------------------------------------------
revoke execute on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke execute on function public.profiles_validate_timezone() from public, anon, authenticated, service_role;
revoke execute on function public.settings_validate_timezone() from public, anon, authenticated, service_role;
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated, service_role;
revoke execute on function public.handle_auth_user_email_changed() from public, anon, authenticated, service_role;
revoke execute on function public.follow_ups_sync_lead() from public, anon, authenticated, service_role;
revoke execute on function public.leads_move_open_follow_ups() from public, anon, authenticated, service_role;
revoke execute on function public.lead_earliest_open_follow_up(uuid) from public, anon, authenticated;
grant execute on function public.lead_earliest_open_follow_up(uuid) to service_role;
