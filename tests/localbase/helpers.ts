import os from 'node:os';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { startLocalbase, type Localbase } from '../../localbase/server';

/** A directory that never exists, so emulator tests do not depend on the app's migrations. */
export const NO_MIGRATIONS_DIR = path.join(os.tmpdir(), 'localbase-tests-no-migrations-dir-does-not-exist');

export const PASSWORD = 'password-123';

export function startTestLocalbase(): Promise<Localbase> {
  return startLocalbase({ port: 0, silent: true, migrationsDir: NO_MIGRATIONS_DIR });
}

export function makeClient(lb: Localbase, key: string = lb.anonKey): SupabaseClient {
  return createClient(lb.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function serviceClient(lb: Localbase): SupabaseClient {
  return makeClient(lb, lb.serviceRoleKey);
}

export async function createConfirmedUser(lb: Localbase, email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await serviceClient(lb).auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    ...extra,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

export async function signedInClient(lb: Localbase, email: string, password = PASSWORD): Promise<SupabaseClient> {
  const client = makeClient(lb);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn failed for ${email}: ${error.message}`);
  return client;
}

export async function raw(
  lb: Localbase,
  pathAndQuery: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; apikey?: string | null } = {},
): Promise<{ status: number; headers: Headers; text: string; json: () => unknown }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const apikey = init.apikey === undefined ? lb.anonKey : init.apikey;
  if (apikey !== null) headers.apikey = apikey;
  const res = await fetch(`${lb.url}${pathAndQuery}`, { method: init.method ?? 'GET', headers, body: init.body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Test-only schema, created as postgres through the returned db handle. */
export const FIXTURE_SQL = `
create type public.item_kind as enum ('A', 'B', 'C');

create table public.items (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid(),
  name text not null,
  kind public.item_kind not null default 'A',
  qty int,
  tags text[],
  meta jsonb,
  code text unique,
  created_at timestamptz not null default now()
);
alter table public.items enable row level security;
create policy items_select on public.items for select to authenticated using (owner = (select auth.uid()));
create policy items_insert on public.items for insert to authenticated with check (owner = (select auth.uid()));
create policy items_update on public.items for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy items_delete on public.items for delete to authenticated using (owner = (select auth.uid()));
revoke all on public.items from anon;

create table public.notes (id int primary key, body text not null, secret text);
alter table public.notes enable row level security;
create policy notes_read on public.notes for select to authenticated using (true);
revoke all on public.notes from anon;
revoke select on public.notes from authenticated;
grant select (id, body) on public.notes to authenticated;
insert into public.notes values (1, 'hello', 'classified');

create table public.children (id int primary key, item_id uuid not null references public.items (id) on delete restrict);

create table public.profiles_t (id uuid primary key references auth.users (id) on delete restrict, email text);
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles_t (id, email) values (new.id, new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.fx_types(p_ids uuid[], p_at timestamptz, p_kind public.item_kind, p_meta jsonb,
                                p_n int default 7, p_label text default 'dflt')
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'ids', p_ids, 'ids_type', pg_typeof(p_ids)::text,
    'at', p_at, 'at_type', pg_typeof(p_at)::text,
    'kind', p_kind, 'kind_type', pg_typeof(p_kind)::text,
    'meta', p_meta, 'meta_type', pg_typeof(p_meta)::text,
    'n', p_n, 'label', p_label)
$$;

create function public.fx_items(p_min int default 0) returns table (id uuid, name text, qty int)
language sql stable as $$
  select i.id, i.name, i.qty from public.items i where coalesce(i.qty, 0) >= p_min order by i.name
$$;

create function public.fx_names() returns setof text language sql stable as $$ select unnest(array['x', 'y', 'z']) $$;
create function public.fx_void() returns void language plpgsql as $$ begin end $$;
create function public.fx_add(a int, b int) returns int language sql immutable as $$ select a + b $$;
create function public.fx_note() returns public.notes language sql stable security definer set search_path = '' as $$
  select * from public.notes where id = 1
$$;
create function public.fx_whoami() returns jsonb language sql stable as $$
  select jsonb_build_object('current_user', current_user, 'uid', auth.uid(), 'role', auth.role(),
                            'method', current_setting('request.method', true))
$$;
create function public.fx_raise(p_code text, p_message text default 'boom') returns void language plpgsql as $$
begin
  raise exception using errcode = p_code, message = p_message, detail = 'the detail', hint = 'the hint';
end $$;
create function public.fx_bump() returns int language plpgsql volatile as $$
begin
  insert into public.notes (id, body) values (floor(random() * 1000000)::int + 100, 'bump');
  return 1;
end $$;
create function public.fx_authed_only() returns int language sql stable as $$ select 42 $$;
revoke execute on function public.fx_authed_only() from public, anon;
grant execute on function public.fx_authed_only() to authenticated;
`;
