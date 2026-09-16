-- localbase bootstrap
--
-- Replicates the parts of a fresh Supabase database that supabase/migrations rely on, so the SAME
-- migration files run unchanged on PGlite. Applied once by localbase/db.ts, as the PGlite superuser
-- (postgres), BEFORE any migration. Never add application objects here.

-- ---------------------------------------------------------------------------------------------
-- Roles (PostgREST switches into these with SET LOCAL ROLE based on the JWT "role" claim)
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit createrole;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

-- ---------------------------------------------------------------------------------------------
-- Schemas and extensions
-- ---------------------------------------------------------------------------------------------
create schema if not exists auth authorization supabase_auth_admin;
create schema if not exists extensions;
create schema if not exists localbase;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
revoke all on schema localbase from public;

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Supabase's default privileges: every new object in public is granted to the API roles.
-- RLS (and explicit revokes in migrations) are what actually protect data.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- auth schema: tables mirror Supabase Auth (GoTrue) columns used by SQL seeds and triggers
-- ---------------------------------------------------------------------------------------------
create table if not exists auth.users (
  instance_id uuid,
  id uuid not null primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255) default '',
  confirmation_sent_at timestamptz,
  recovery_token varchar(255) default '',
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255) default '',
  email_change varchar(255) default '',
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz,
  updated_at timestamptz,
  phone text unique default null,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
create unique index if not exists users_email_partial_key on auth.users (email) where (is_sso_user = false);

create table if not exists auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  id uuid not null default gen_random_uuid() primary key,
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);

alter table auth.users owner to supabase_auth_admin;
alter table auth.identities owner to supabase_auth_admin;

-- ---------------------------------------------------------------------------------------------
-- auth helper functions (identical semantics to Supabase)
-- ---------------------------------------------------------------------------------------------
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- localbase internals (never exposed through /rest/v1, which only serves the public schema)
-- ---------------------------------------------------------------------------------------------
create table if not exists localbase.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

-- GoTrue subset state. Real Supabase keeps these in auth.sessions / auth.refresh_tokens; localbase keeps
-- them out of the auth schema so app SQL cannot come to depend on emulator-specific shapes. The hosted
-- columns app SQL does use are exposed as views in localbase/auth-compat.sql.
create table if not exists localbase.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  aal text not null default 'aal1',
  amr jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists localbase.refresh_tokens (
  id bigint generated always as identity primary key,
  token text not null unique,
  session_id uuid not null references localbase.sessions (id) on delete cascade,
  user_id uuid not null,
  parent text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists refresh_tokens_session_idx on localbase.refresh_tokens (session_id);

-- The GoTrue emulator runs its SQL as supabase_auth_admin, like the real Auth server.
grant usage on schema localbase to supabase_auth_admin;
grant select, insert, update, delete on localbase.sessions, localbase.refresh_tokens to supabase_auth_admin;
