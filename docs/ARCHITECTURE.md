# Funnel McQueen CRM: Architecture Contract

This file is the contract every contributor (human or agent) builds against. The product spec is
`docs/SPEC.md`. If this contract and the spec disagree, the spec wins on behavior. Record the
disagreement in `docs/DEVIATIONS.md`, fix this file, and say so in your report. Do not silently
diverge.

Next.js here is **16.3**. Read `node_modules/next/dist/docs/` before using an API you are unsure of.
Key differences: `proxy.ts` replaces `middleware.ts` (Node runtime only), `cookies()`/`headers()`/
`params`/`searchParams` are async only, `next lint` is gone (use `eslint`), `revalidateTag(tag,
'max')` needs 2 args, and `updateTag`/`refresh` from `next/cache` exist for Server Actions.

---

## 1. Golden rules

1. **Isolation lives in Postgres.** Every table has RLS. Every query from app code runs with the
   user's session (anon key + user JWT) so RLS applies. UI hiding is never a control.
2. **Service role** (`src/server/supabase/admin.ts`) is used only for (a) Supabase Auth admin ops
   (create/ban users) and (b) Twilio webhooks. Nothing else. Grep-able: `createAdminClient(`.
3. **Every server action, route handler and service** validates input with Zod and checks auth and
   role itself. `proxy.ts` is only an optimistic redirect.
4. **Unauthorized equals nonexistent.** Return 404 `{ error: 'not_found' }` for IDs the caller
   cannot access, with the same body and timing path as a truly missing ID. Never echo other users'
   data in error messages.
5. **Explicit column lists.** Never `select('*')` on `calls` (column grants will reject it). Prefer
   explicit columns everywhere.
6. **No embedded resources** in supabase-js selects (`select('*, profiles(name)')`). localbase does
   not implement them. Use RPCs or `security_invoker` views, or two queries.
7. **Telephony boundary.** `@twilio/voice-sdk` is imported only in
   `src/lib/dialer/drivers/twilio.ts`. The `twilio` Node lib is imported only under
   `src/server/twilio/**`, `scripts/**`, `tests/**`. ESLint enforces this.
8. **Secrets** are only read in `src/server/env.ts` (which has `import 'server-only'`). Never prefix
   a secret with `NEXT_PUBLIC_`.
9. **Services do not import `next/*`.** Business logic in `src/server/services/**` takes an explicit
   context so vitest can call it against localbase. Server actions and route files are thin wrappers.
10. **Phones in logs are masked** (`maskPhone('+12125550123') → '+1******0123'`).

---

## 2. Directory layout

```
docs/                    SPEC.md, PLAN.md, ARCHITECTURE.md (this), DEVIATIONS.md
supabase/
  config.toml            real Supabase CLI config (enable_signup = false)
  migrations/            timestamped SQL, the single source of truth for schema/RLS/RPCs
  seed.sql               comment only, pointing to `npm run db:seed`
localbase/               Docker-free Supabase emulator (dev + tests), TypeScript run via tsx
  bootstrap.sql          Supabase-compatible roles, auth schema, default privileges
  db.ts                  PGlite factory + migration runner
  rest.ts                PostgREST subset
  auth.ts                GoTrue subset
  jwt.ts                 HS256 sign/verify, anon/service keys
  server.ts              startLocalbase({ port, dataDir? })
  cli.ts                 `npm run localbase` entry
scripts/
  seed.ts                seed via Auth admin API + service-role REST (works on localbase AND real Supabase)
  make-admin.ts          `npm run make-admin -- email [--create]`
  gen-types.ts           introspect DB → src/lib/database.types.ts (Supabase gen format)
  gen-sample-csv.ts      writes samples/leads.csv (100 rows, dupes + invalid rows)
  check-bundle-secrets.ts
  e2e-server.ts          localbase(memory)+seed+next for Playwright
samples/leads.csv
src/
  proxy.ts               session refresh + optimistic auth/admin redirects
  app/
    (auth)/login/page.tsx
    (auth)/auth/confirm/route.ts     email-change confirmation (token_hash verify)
    (app)/layout.tsx                 app shell: nav, DialerProvider, voicemail badge
    (app)/dashboard/page.tsx         role-aware
    (app)/leads/page.tsx             "My Leads" / "All Leads"
    (app)/leads/[id]/page.tsx
    (app)/pipeline/page.tsx
    (app)/follow-ups/page.tsx
    (app)/settings/page.tsx
    (app)/admin/agents/page.tsx, (app)/admin/agents/[id]/page.tsx
    (app)/admin/phone-numbers/page.tsx
    (app)/admin/reports/page.tsx
    (app)/admin/import/page.tsx
    api/voice/token/route.ts
    api/voice/presence/route.ts
    api/calls/outbound/route.ts
    api/voicemail/[callId]/route.ts
    api/leads/export/route.ts
    api/twilio/voice/{outbound,dial-complete,status,inbound,inbound-dial-complete,voicemail-complete,recording-status}/route.ts
  components/
    ui/                  shadcn (do not hand-edit except theme-level tweaks)
    app-shell/           sidebar, bottom-nav, page-header, voicemail-badge
    dialer/              call-button, in-call-bar, outcome-sheet, incoming-call, keypad, dialer-provider
    leads/ follow-ups/ pipeline/ dashboard/ admin/ import/ common/
  lib/
    database.types.ts    generated (npm run db:types)
    utils.ts             shadcn cn()
    domain/              PURE, isomorphic, unit-tested:
      phone.ts website.ts dedupe.ts outcomes.ts statuses.ts csv.ts split.ts time.ts import-mapping.ts
    dialer/              client dialer module (types, resolve-mode, drivers/{twilio,tel,mock}.ts)
    supabase/browser.ts  createBrowserClient
  server/
    env.ts               Zod-validated env ('server-only')
    supabase/server.ts   createServerSupabase() for RSC/actions (next/headers cookies)
    supabase/request.ts  createRequestSupabase(req) for route handlers (cookie header OR Bearer)
    supabase/admin.ts    createAdminClient() service role ('server-only')
    context.ts           RequestContext, getActionContext(), getRouteContext(req), requireUser/requireAdmin
    errors.ts            AppError(code), toActionResult, toHttpResponse
    services/            business logic (leads, calls, follow-ups, pipeline, import, export, agents, numbers, reports, settings)
    actions/             'use server' thin wrappers → ActionResult<T>
    http/                route handler cores: handleX(req, deps) → Response (testable)
    twilio/              env, rest client (injectable), signature, twiml, token, inbound-routing, status
tests/
  helpers/               env, clients (signIn), fixtures, twilio signing, empty-module
  unit/                  pure domain + dialer mode resolution
  db/                    PGlite direct: raw SQL RLS as authenticated, RPC semantics
  integration/           supabase-js over HTTP (localbase or real Supabase): isolation, admin, reassignment
  routes/                http handler cores with real localbase + fake Twilio
  localbase/             emulator translation tests
e2e/                     Playwright specs (mock dialer)
```

---

## 3. Environment variables

| Name | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client+server | localbase: `http://127.0.0.1:54321` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client+server | anon or publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only | service_role or secret key |
| `APP_BASE_URL` | server-only | exact public origin, no trailing slash; used for Twilio signature URLs |
| `DIALER_DRIVER` | server-only | `twilio` \| `tel` \| `mock` (default `mock` in dev if Twilio vars missing) |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_API_KEY_SID` `TWILIO_API_KEY_SECRET` `TWILIO_TWIML_APP_SID` | server-only | required when `DIALER_DRIVER=twilio` |

`src/server/env.ts` exports `getServerEnv()`, which parses lazily and caches (so importing never
throws at build time). `DIALER_DRIVER` reaches the client only as a prop from the `(app)` layout.

localbase uses the Supabase CLI's default JWT secret `super-secret-jwt-token-with-at-least-32-characters-long`
and generates anon/service keys with payload `{"iss":"supabase-demo","role":"anon"|"service_role","exp":1983812996}`
(these equal the well-known Supabase local demo keys). `.env.example` documents both stacks.

---

## 4. Database contract

Postgres 15+ (Supabase) and PGlite (18). Schemas: `public` (app), `auth` (Supabase), `extensions`
(`pg_trgm`). Every function sets `search_path = ''` and fully qualifies names
(`public.leads`, `auth.uid()`, `extensions.gin_trgm_ops`).

### 4.1 Enums

```sql
create type public.user_role     as enum ('ADMIN','AGENT');
create type public.lead_status   as enum ('NEW','TO_CALL','NO_ANSWER','VOICEMAIL','CONNECTED','INTERESTED','FOLLOW_UP','APPOINTMENT','PROPOSAL','CLIENT','NOT_INTERESTED','DO_NOT_CONTACT');
create type public.call_outcome  as enum ('NO_ANSWER','VOICEMAIL','CONNECTED','INTERESTED','FOLLOW_UP','APPOINTMENT','NOT_INTERESTED','WRONG_NUMBER');
create type public.call_direction as enum ('OUTBOUND','INBOUND');
create type public.call_mode     as enum ('IN_APP','TEL');
```

`calls.call_status` is `text` with a CHECK in
`('queued','ringing','in-progress','completed','busy','no-answer','failed','canceled')`.

### 4.2 Tables

**profiles** (1:1 `auth.users`)
| column | type | notes |
|---|---|---|
| id | uuid PK | FK `auth.users(id)` ON DELETE RESTRICT |
| email | text not null | synced from auth.users by trigger |
| name | text not null default '' | |
| role | user_role not null default 'AGENT' | |
| active | boolean not null default true | |
| daily_call_target | int not null default 50, check 0..1000 | |
| timezone | text not null default 'America/New_York' | validated against `pg_timezone_names` in trigger |
| in_app_calling_enabled | boolean not null default true | |
| device_seen_at | timestamptz null | Twilio Device presence heartbeat (addition) |
| created_at | timestamptz not null default now() | |

**settings** (single row; `id boolean primary key default true check (id)`)
`company_name text not null default 'Funnel McQueen'`, `default_daily_target int not null default 50`,
`default_timezone text not null default 'America/New_York'`,
`voicemail_greeting text not null default 'Sorry we missed your call. Please leave a message after the beep.'`,
`updated_at timestamptz not null default now()`. The migration inserts the row.

**leads**
| column | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| created_at, updated_at | timestamptz not null default now() | updated_at via trigger |
| business_name | text not null, check btrim non-empty | |
| contact_name | text | |
| phone | text not null, check `^\+[1-9][0-9]{6,14}$` | normalized E.164 (app-normalized) |
| phone_raw | text | original input |
| email, website | text | |
| website_domain | text | normalized (app-normalized, `lib/domain/website.ts`) |
| address, city, state, country, source | text | |
| status | lead_status not null default 'NEW' | |
| notes | text | |
| assigned_to | uuid FK profiles ON DELETE RESTRICT, null = unassigned | |
| last_contacted_at | timestamptz | |
| next_follow_up_at | timestamptz | **derived**: always = earliest open follow-up |
| call_count | int not null default 0 | |
| dedupe_name_key | text GENERATED ALWAYS AS (`lower(regexp_replace(business_name,'[^A-Za-z0-9]+','','g')) \|\| '\|' \|\| lower(regexp_replace(coalesce(city,''),'[^A-Za-z0-9]+','','g'))`) STORED | must equal `nameCityKey()` in `lib/domain/dedupe.ts` |

**phone_numbers**
`id uuid PK`, `e164 text not null unique (E.164 check)`, `twilio_sid text not null unique`,
`label text`, `active boolean not null default true`,
`assigned_to uuid FK profiles ON DELETE RESTRICT (null = pool)`, `last_used_at timestamptz`,
`created_at timestamptz not null default now()`.

**calls**
| column | type | notes |
|---|---|---|
| id | uuid PK default gen_random_uuid() | |
| created_at | timestamptz not null default now() | |
| lead_id | uuid FK leads ON DELETE CASCADE, null only for unmatched inbound | |
| user_id | uuid FK profiles ON DELETE RESTRICT | null only for INBOUND admin-only voicemails |
| direction | call_direction not null | |
| mode | call_mode not null | |
| phone_number_id | uuid FK phone_numbers ON DELETE RESTRICT | caller ID used / number dialed |
| remote_e164 | text | other party: lead phone (outbound) or caller (inbound) (addition) |
| provider_call_sid | text unique | Twilio parent CallSid |
| call_status | text (check list) | |
| outcome | call_outcome | null until logged |
| notes | text | |
| duration_seconds | int check >= 0 | talk time |
| voicemail_recording_sid | text | |
| voicemail_duration_seconds | int | |
| handled_at | timestamptz | voicemail heard/handled |

CHECKs: `direction = 'INBOUND' or (user_id is not null and lead_id is not null)`,
`mode = 'IN_APP' or provider_call_sid is null`.

**follow_ups**
`id uuid PK`, `lead_id uuid not null FK leads ON DELETE CASCADE`,
`user_id uuid not null FK profiles ON DELETE RESTRICT`, `created_at timestamptz not null default now()`,
`due_at timestamptz not null`, `completed_at timestamptz`, `note text`.

**rate_limit_hits** (addition): `id bigint identity PK`, `user_id uuid not null`, `bucket text not null`,
`created_at timestamptz not null default now()`. RLS on, **no policies**, all privileges revoked from
anon/authenticated.

### 4.3 Indexes
- leads: `(assigned_to, status)`, `(assigned_to, next_follow_up_at)`, `(assigned_to, last_contacted_at)`,
  `(phone)`, `(website_domain)`, `(dedupe_name_key)`, `(created_at)`; GIN `extensions.gin_trgm_ops` on
  `business_name, contact_name, email, website, city, phone`
- calls: `(user_id, created_at)`, `(lead_id, created_at)`, unique `(provider_call_sid)`
- follow_ups: `(user_id, due_at) where completed_at is null`, `(lead_id) where completed_at is null`
- phone_numbers: `(assigned_to)`
- rate_limit_hits: `(user_id, bucket, created_at)`

### 4.4 Triggers
- `leads_set_updated_at` / `settings_set_updated_at`: BEFORE UPDATE sets `updated_at = now()`.
- `on_auth_user_created`: AFTER INSERT ON auth.users, SECURITY DEFINER. Inserts a profile with email,
  `name = coalesce(raw_user_meta_data->>'name', split_part(email,'@',1))`, and target/timezone from settings.
- `on_auth_user_email_changed`: AFTER UPDATE OF email ON auth.users, syncs `profiles.email`.
- `profiles_guard`: BEFORE UPDATE, SECURITY INVOKER. If `not public.is_privileged_role() and not public.is_admin()`,
  only `name` may change (else `42501`). `id`, `email`, `created_at` are immutable for non-privileged callers.
  An admin cannot change their own `role` or `active` (lockout guard).
- `leads_guard`: BEFORE UPDATE, SECURITY INVOKER. If `not is_privileged_role() and not is_admin()`, only
  `status`, `notes`, `next_follow_up_at` may differ (else `42501`). **Always** sets
  `NEW.next_follow_up_at := public.lead_earliest_open_follow_up(NEW.id)` (SECURITY DEFINER helper), so
  direct writes to that column cannot break the invariant.
- `follow_ups_sync_lead`: AFTER INSERT/UPDATE/DELETE on follow_ups, SECURITY DEFINER. Recomputes
  `leads.next_follow_up_at` for OLD/NEW lead_id.
- `follow_ups_guard`: BEFORE UPDATE. For non-privileged non-admins, `lead_id` and `user_id` are immutable.

`public.is_privileged_role()` returns `current_user not in ('anon','authenticated')`. Inside
SECURITY DEFINER functions `current_user` is the owner (`postgres`), so definer RPCs are trusted and
must do their own checks.

### 4.5 Grants (Supabase grants ALL to anon/authenticated by default, so revoke explicitly)
- `revoke all on all tables in schema public from anon;` (anon gets nothing; login page is static).
- `calls`: `revoke select on public.calls from authenticated;` then
  `grant select (id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes, duration_seconds, voicemail_duration_seconds, handled_at) on public.calls to authenticated;`
  Hidden from API reads: `user_id`, `phone_number_id`, `provider_call_sid`, `voicemail_recording_sid`.
  The app reads those through SECURITY DEFINER RPCs only.
- `rate_limit_hits`: revoke all from anon, authenticated.
- Functions: every migration ends by `revoke execute on function … from public, anon;` for each function
  it creates, then `grant execute … to authenticated` (API RPCs) or `to service_role` (webhook-only).
  `get_company_name()` is additionally granted to anon.

### 4.6 RLS policies (all `to authenticated`; wrap helpers as `(select public.is_admin())`)
- **profiles**: SELECT `is_admin() or (id = auth.uid() and is_active_user())`. UPDATE same using/check.
  No INSERT/DELETE policies.
- **settings**: SELECT/UPDATE `is_admin()`. Everyone reads the company name via `get_company_name()`.
- **leads**: SELECT/UPDATE `is_admin() or (assigned_to = auth.uid() and is_active_user())`, with the
  same WITH CHECK. INSERT/DELETE `is_admin()`.
- **calls**: SELECT `is_admin() or (is_active_user() and ((lead_id is not null and exists(select 1 from public.leads l where l.id = lead_id and l.assigned_to = auth.uid())) or (lead_id is null and user_id = auth.uid())))`.
  INSERT/UPDATE/DELETE `is_admin()`.
- **follow_ups**: ALL `is_admin() or (is_active_user() and user_id = auth.uid() and exists(select 1 from public.leads l where l.id = lead_id and l.assigned_to = auth.uid()))`, same WITH CHECK.
- **phone_numbers**: ALL `is_admin()`.
- **rate_limit_hits**: none.
- Any view: `with (security_invoker = true)`.

### 4.7 Functions (RPC contract)

Helpers (SECURITY DEFINER, STABLE, `search_path=''`, granted to authenticated):
`is_admin() → boolean` (role ADMIN and active), `is_active_user() → boolean`,
`can_access_lead(p_lead_id uuid) → boolean` (admin, or active and assigned to caller),
`get_company_name() → text` (anon+authenticated). Also `is_privileged_role()`,
`lead_earliest_open_follow_up(uuid)` (internal, not granted), and
`outcome_to_status(p_outcome call_outcome, p_current lead_status) → lead_status` (IMMUTABLE).

Outcome mapping: NO_ANSWER→NO_ANSWER, VOICEMAIL→VOICEMAIL, CONNECTED→CONNECTED, INTERESTED→INTERESTED,
FOLLOW_UP→FOLLOW_UP, APPOINTMENT→APPOINTMENT, NOT_INTERESTED→NOT_INTERESTED, WRONG_NUMBER→DO_NOT_CONTACT.
No downgrade: NO_ANSWER/VOICEMAIL on APPOINTMENT/PROPOSAL/CLIENT keeps the current status.
"Connected" in stats = outcome not null and not in (NO_ANSWER, VOICEMAIL, WRONG_NUMBER).

Error conventions raised by RPCs (the HTTP layer maps them):
`not_found` → `errcode 'P0002'` (HTTP 404) · `forbidden` → `'42501'` (403, used only where 404 would
be wrong, e.g. inactive self) · validation → `'22023'` (400) · `do_not_contact` / `call_in_progress` →
`'P0001'` with that exact message (409).

| RPC | security | who | behavior |
|---|---|---|---|
| `log_call(p_outcome call_outcome, p_lead_id uuid default null, p_call_id uuid default null, p_notes text default null, p_follow_up_at timestamptz default null, p_follow_up_note text default null, p_duration_seconds int default null) → jsonb` | definer | authenticated | One transaction. Caller must be active. If `p_call_id` names an existing row: caller must be admin or `user_id = auth.uid()`, the row's lead must match `p_lead_id` (if given) and be accessible, else `not_found`. If the row has no outcome yet, `call_count += 1`, else no increment (re-log only updates outcome/notes). `p_duration_seconds` applies only if `duration_seconds` is null. If no row exists: `p_lead_id` is required and must be accessible, then insert a `TEL` OUTBOUND row (with `id = p_call_id` if given, making TEL logging idempotent), `call_count += 1`. For lead rows: `last_contacted_at = now()`, `status = outcome_to_status()`, unhandled voicemails on that lead get `handled_at = now()`, open follow-ups with `due_at <= now()` get completed, and if `p_follow_up_at` is set a follow-up is inserted for `coalesce(lead.assigned_to, auth.uid())`. `FOLLOW_UP` requires `p_follow_up_at` (22023). `WRONG_NUMBER` prefixes notes with `Wrong number` (`'Wrong number — ' \|\| notes` when notes are non-empty). Returns `{call_id, lead_id, status, call_count, next_follow_up_at}`. |
| `get_next_lead(p_exclude_ids uuid[] default '{}') → table(lead_id, business_name, contact_name, phone, status, city, state, last_contacted_at, next_follow_up_at, call_count, reason text)` | definer | authenticated | Caller's own assigned leads only. Excludes CLIENT/NOT_INTERESTED/DO_NOT_CONTACT and `p_exclude_ids`. Excludes leads with `last_contacted_at > now() - 4h` unless they have an open follow-up due (`due_at <= now()`) or an unheard voicemail. Buckets in order, reason codes: `VOICEMAIL` (unheard voicemail, oldest voicemail first) → `OVERDUE` (open follow-up `due_at < now()`, oldest first) → `DUE_TODAY` (open follow-up due later today in caller's timezone, soonest first) → `NEW` (status NEW/TO_CALL, oldest created first) → `RETRY` (NO_ANSWER/VOICEMAIL, `last_contacted_at asc nulls first`, then `call_count asc`). Leads matching no bucket are not suggested. Returns 0 or 1 row. |
| `create_outbound_call(p_lead_id uuid) → uuid` | definer | authenticated | Active caller with `in_app_calling_enabled`, else forbidden. Lead must be accessible (admin: any lead), else `not_found`. DO_NOT_CONTACT → `do_not_contact`. If the caller has a call with `call_status in ('queued','ringing','in-progress')` created in the last 2h → `call_in_progress`. Inserts OUTBOUND/IN_APP row with `user_id = auth.uid()` and `remote_e164 = lead.phone`. |
| `get_lead_call_history(p_lead_id uuid) → table(id, created_at, direction, mode, call_status, outcome, notes, duration_seconds, has_voicemail boolean, voicemail_duration_seconds, handled_at, is_mine boolean, caller_name text, caller_id_e164 text)` | definer | authenticated | Empty set if `not can_access_lead`. `caller_name`/`caller_id_e164` are non-null **only for admins**. Newest first. |
| `get_voicemail_recording(p_call_id uuid) → text` | definer | authenticated | Recording SID if the caller may access that call (admin, lead accessible, or `lead_id is null and user_id = auth.uid()`), else null. |
| `mark_voicemail_heard(p_call_id uuid) → boolean` | definer | authenticated | Same access. Sets `handled_at` if null. |
| `list_voicemails(p_unheard_only boolean default false, p_limit int default 50, p_offset int default 0) → table(call_id, created_at, lead_id, business_name, contact_name, phone, lead_status, voicemail_duration_seconds, handled_at, total_count bigint)` | definer | authenticated | Scoped like `get_voicemail_recording`. For unmatched calls, `phone = remote_e164` and business is null. |
| `unheard_voicemail_count() → int` | definer | authenticated | Scoped count. |
| `reassign_leads(p_lead_ids uuid[], p_to_user_id uuid) → int` | definer | admin | `p_to_user_id` must be an active AGENT or ADMIN, or null (= unassign). Updates `assigned_to` and moves open follow-ups to the new owner (when non-null). Calls are untouched. Returns the updated count. |
| `search_leads(p_query text default null, p_statuses lead_status[] default null, p_source text default null, p_assigned_to uuid default null, p_unassigned boolean default false, p_sort text default 'created_at', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) → table(id, created_at, business_name, contact_name, phone, email, website, city, state, country, source, status, assigned_to, last_contacted_at, next_follow_up_at, call_count, total_count bigint)` | **invoker** | authenticated | RLS scopes rows. Non-admins also get an explicit `assigned_to = auth.uid()`, and `p_assigned_to`/`p_unassigned` are ignored. Query matches ILIKE on business/contact/email/website/city, or phone digits substring when the query contains ≥3 digits. Sort whitelist: `business_name, last_contacted_at, next_follow_up_at, call_count, created_at` (nulls last). `p_limit` is clamped to 1..100. |
| `list_lead_sources() → setof text` | invoker | authenticated | Distinct non-null sources visible to the caller. |
| `touch_device_presence() → void` | definer | authenticated | `device_seen_at = now()` for the active caller. |
| `consume_rate_limit(p_bucket text, p_max int, p_window_seconds int) → boolean` | definer | authenticated | Keyed on `auth.uid()`. Prunes old hits, returns false when over the limit, otherwise records a hit. |
| `claim_caller_id(p_user_id uuid) → table(phone_number_id uuid, e164 text)` | definer | **service_role only** | Least recently used active number assigned to the user, else least recently used active pool number (`last_used_at nulls first, created_at`), with `for update skip locked`. Sets `last_used_at = now()`. |
| `apply_call_status(p_call_sid text, p_status text, p_duration int default null) → boolean` | definer | service_role only | Idempotent. Finds the row by `provider_call_sid`. Terminal statuses (completed/busy/no-answer/failed/canceled) are never replaced by non-terminal ones, and a terminal status only changes if the duration is being filled. `duration_seconds = greatest(existing, p_duration)`. |
| `record_voicemail(p_call_sid text, p_recording_sid text, p_duration int) → boolean` | definer | service_role only | Atomic: sets the recording where `voicemail_recording_sid is null`. On first set, if the lead has an owner, inserts follow-up (owner, `due_at = now()`, note 'Voicemail received'). Returns whether it was newly set. |

Later stages add (same conventions): dashboard/report RPCs (`get_my_dashboard()`,
`admin_team_overview()`, `admin_agent_rows()`, `admin_report_agents(p_from, p_to)`,
`admin_report_numbers(p_from, p_to)`), follow-up listing (`list_follow_ups(p_tab, p_limit, p_offset)`),
duplicate lookup (`find_duplicate_leads(p_phones text[], p_domains text[], p_name_keys text[])`, admin).
Admin-only RPCs raise `42501` for non-admins, and stats RPCs aggregate by `calls.user_id` (stats stay
with whoever made the call).

### 4.8 Migration files (ownership slots)
```
supabase/migrations/20260915000100_core_schema.sql     stage 1
supabase/migrations/20260915000200_rls.sql             stage 1
supabase/migrations/20260915000300_core_rpcs.sql       stage 1
supabase/migrations/20260915000400_twilio.sql          stages 4-5
supabase/migrations/20260915000600_dashboards.sql      stage 6
supabase/migrations/20260915000700_follow_ups.sql      stage 7
supabase/migrations/20260915000800_pipeline.sql        stage 8
supabase/migrations/20260915000900_import_export.sql   stage 9
supabase/migrations/20260915001000_admin.sql           stage 10
```
Later migrations may `create or replace function`. After `npm run db:types`, commit the regenerated types.

---

## 5. Server layer conventions

```ts
// src/server/context.ts
export type Profile = Database['public']['Tables']['profiles']['Row'];
export interface RequestContext { supabase: SupabaseClient<Database>; userId: string; profile: Profile }
export async function getActionContext(): Promise<RequestContext | null>     // next/headers cookies
export async function getRouteContext(req: Request): Promise<RequestContext | null> // cookie header or Bearer
export function requireActive(ctx): RequestContext  // throws AppError('unauthorized')
export function requireAdmin(ctx): RequestContext   // throws AppError('forbidden')
```
- The user is identified via `supabase.auth.getUser()` (server-validated), and the profile is read with
  the same session. An inactive profile or a missing row counts as unauthorized.
- `AppError` codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `validation` (400),
  `conflict` (409), `rate_limited` (429), `unavailable` (503). `mapPostgrestError(err)` maps P0002→not_found,
  42501→forbidden, 22023/22P02/23514→validation, P0001 do_not_contact/call_in_progress→conflict.
- Server actions return `ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: AppErrorCode; message: string } }`
  and never throw to the client.
- Route handler cores: `src/server/http/<name>.ts` exports `handle<Name>(req: Request, deps?: Partial<Deps>)`.
  The `route.ts` file calls it and sets `export const dynamic = 'force-dynamic'`.
- Pages are Server Components that call services with `getActionContext()`. Mutations use server actions
  followed by `refresh()` or `revalidatePath` as appropriate.
- `next.config.ts`: headers on all routes: `Permissions-Policy: microphone=(self), camera=(), geolocation=()`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
  `serverActions.bodySizeLimit: '4mb'` (import batches).

---

## 6. Dialer module contract (`src/lib/dialer`, client-only)

```ts
export type DialerDriverName = 'twilio' | 'tel' | 'mock';
export type CallModePreference = 'auto' | 'in-app' | 'phone';           // localStorage 'fmq.callMode'
export type CallEndReason = 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
export interface CallEvents {
  onRinging(): void; onConnected(): void;
  onDisconnected(reason: CallEndReason): void;
  onWarning(message: string): void;      // plain language: "Poor connection", "Microphone not found"
  onError(message: string): void;
}
export interface ActiveCall { hangup(): void; setMuted(m: boolean): void; isMuted(): boolean; sendDigits(d: string): void }
export interface IncomingCall { callId: string | null; accept(events: CallEvents): ActiveCall; reject(): void }
export interface InAppDriver {
  readonly name: 'twilio' | 'mock';
  register(): Promise<{ ok: true } | { ok: false; reason: string }>;
  connect(callId: string, events: CallEvents): Promise<ActiveCall>;   // sends ONLY { callId }
  onIncoming(cb: (call: IncomingCall) => void): () => void;
  setInputDevice?(id: string): Promise<void>; setOutputDevice?(id: string): Promise<void>; testSpeaker?(): Promise<void>;
  destroy(): void;
}
export function resolveDialMode(i: { preference: CallModePreference; defaultDriver: DialerDriverName;
  isIOS: boolean; inAppEnabled: boolean; deviceReady: boolean }): 'in-app' | 'tel';
export function telHref(e164: string): string;   // 'tel:+15555550123'
```
`resolveDialMode` rules:
- `defaultDriver==='tel'` or `!inAppEnabled` → `tel`.
- `preference==='phone'` → `tel`.
- `preference==='in-app'` → `in-app` if `deviceReady`, else `tel`.
- `auto` → `tel` if `isIOS` or `!deviceReady`, else `in-app`.

`DialerProvider` (in the `(app)` layout) owns a single state machine
`idle → preparing → ringing → in-call → wrap-up(outcome sheet) → idle`. One active call at a time:
every CALL button is disabled unless idle. Flow for in-app: POST `/api/calls/outbound {leadId}` → `{callId}` → `driver.connect(callId)`.
When the call disconnects, the outcome sheet opens with **No Answer pre-selected** for busy/no-answer/failed.
For tel: CALL renders `<a href="tel:…">`. On click, remember `{leadId, startedAt}`. When the page becomes
visible again, open the outcome sheet (and show a sticky "Log outcome" bar as a fallback). The TEL `callId`
is a client-generated UUID passed to `log_call` for idempotency. Mock driver: rings 1.2s → connected until
hangup. It exposes `window.__fmqMockDialer = { remoteHangup(reason), simulateIncoming(callId) }` only
when `DIALER_DRIVER=mock`.

---

## 7. Twilio contract (`src/server/twilio`, `src/server/http/twilio`)

- Validation (every `/api/twilio/*`): read `formData` → params; `url = APP_BASE_URL + pathname + search`;
  `twilio.validateRequest(TWILIO_AUTH_TOKEN, header, url, params)`. If that fails, or if
  `params.AccountSid !== TWILIO_ACCOUNT_SID`, return 403 text `Forbidden` and log with a masked phone.
- TwiML responses: `Content-Type: text/xml`. Failure TwiML is `<Say>Sorry, this call cannot be completed.</Say><Hangup/>`.
  Never explain why.
- `/api/twilio/voice/outbound` (TwiML App Voice URL). If `From` starts with `client:` it is the outbound
  flow, otherwise it delegates to the inbound handler (numbers point at the TwiML App).
  Outbound checks: load the row by `params.callId` (uuid) via service role. The row must be OUTBOUND/IN_APP
  with `provider_call_sid is null` and be created ≤10 min ago. `From` must equal `client:<calls.user_id>`.
  The user must be active with in-app calling enabled. The lead must still be assigned to that user
  (or the user is admin), and its status must not be DO_NOT_CONTACT. Then `claim_caller_id`. If there is no
  number, return failure TwiML. Otherwise set `provider_call_sid=CallSid, phone_number_id, call_status='queued'`.
  Respond: `<Dial callerId="{e164}" timeout="30" answerOnBridge="true" action="{APP_BASE_URL}/api/twilio/voice/dial-complete"><Number statusCallback="{APP_BASE_URL}/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed">{lead.phone}</Number></Dial>`.
- `/status`: child-leg callbacks carry `ParentCallSid`, so look up by `ParentCallSid ?? CallSid` and call `apply_call_status`.
- `/dial-complete`: `DialCallStatus` and `DialCallDuration` go to `apply_call_status`. Respond with an empty `<Response/>`.
- Inbound (`/inbound`, or delegated): normalize `From`. The pure `decideInboundRoute(facts)` picks the target:
  1) matched lead (most recently contacted if duplicated) **with owner** → owner;
  2) matched lead without owner → admin-only voicemail;
  3) no match and `To` number assigned to an agent → that agent;
  4) otherwise admin-only voicemail.
  Ring only if the target is active, has in-app calling enabled, `device_seen_at` ≤ 3 min old, and no
  in-progress call. Always insert an INBOUND row (lead_id when matched; `user_id` = target, or null for
  admin-only; `phone_number_id`; `remote_e164 = From`; `provider_call_sid = CallSid`).
  Ring: `<Dial timeout="20" answerOnBridge="true" action="…/inbound-dial-complete"><Client><Identity>{userId}</Identity><Parameter name="callId" value="{callId}"/></Client></Dial>`.
  Voicemail: `<Say>{settings.voicemail_greeting}</Say><Record maxLength="120" playBeep="true" action="…/voicemail-complete" recordingStatusCallback="…/recording-status" recordingStatusCallbackEvent="completed"/>`.
- `/inbound-dial-complete`: `DialCallStatus` completed → `<Response/>`. Anything else → voicemail TwiML.
- `/recording-status`: `record_voicemail(CallSid, RecordingSid, RecordingDuration)`.
- `/voicemail-complete`: `<Say>Thank you. Goodbye.</Say><Hangup/>`.
- `/api/voice/token`: requires an active session with in-app calling enabled. Rate limit `voice_token` 20/10min.
  Returns 503 if Twilio isn't configured. AccessToken `{identity: userId, ttl: 3600}` + VoiceGrant
  `{outgoingApplicationSid, incomingAllow: true}` → `{ token, identity, ttl }`.
- `/api/calls/outbound`: Zod `{leadId: uuid}`, rate limit `outbound_call` 12/min, then `create_outbound_call`.
- `/api/voicemail/[callId]`: uuid check, then session, then `get_voicemail_recording`; if null → 404. Fetch
  `https://api.twilio.com/2010-04-01/Accounts/{sid}/Recordings/{RecordingSid}.mp3` with API-key basic auth
  (forward `Range`) and stream back with `Cache-Control: private, no-store`. In mock/unconfigured mode,
  stream a generated short WAV tone so dev seed voicemails play.
- Twilio REST client and fetch are injected via deps so tests never hit the network.

---

## 8. UI contract

- **Dark-only** theme on charcoal. Tokens in `src/app/globals.css` (`:root` is the dark palette):
  background `#1A1A1A`, card `#222222`, popover `#242424`, muted `#2A2A2A`, border/input `#333333`,
  foreground `#F5F5F5`, muted-foreground `#A3A3A3`, primary **Racing Red `#E10600`** (fg white), ring `#E10600`,
  destructive `#F04438`, gold `#F4B400` exposed as `--gold` / `text-gold` / `bg-gold` (target hit, highlights only),
  success `#22C55E`. No gradients, glows, decorative animation, or oversized stat cards.
- Font: Geist via `next/font`. Numbers use `font-extrabold tabular-nums`.
- Touch targets ≥ 48px (`min-h-12`). Transitions ≤ 150ms. Skeletons via `components/ui/skeleton`.
- Navigation: agent = Dashboard, My Leads, Pipeline, Follow-ups, Settings. Admin = Dashboard, All Leads,
  Pipeline, Follow-ups, Agents, Phone Numbers, Reports, Settings (plus Import from Leads/Agents). Mobile
  (<768px): bottom tab bar (admin shows 4 + "More" sheet). Desktop: left sidebar.
- The CALL button is always `bg-primary`, big, and sticky at the bottom on mobile lead detail. It is
  disabled for DO_NOT_CONTACT and while another call is active.
- Status labels/colors come from `lib/domain/statuses.ts` only.

---

## 9. localbase contract

`startLocalbase({ port = 54321, dataDir?: string, silent? }) → { url, anonKey, serviceRoleKey, jwtSecret, stop() }`.
It boots PGlite (memory when no `dataDir`), loads `pg_trgm` + `pgcrypto`, runs `bootstrap.sql`, then applies
`supabase/migrations/*.sql` in order (tracked in `localbase.schema_migrations`).

**Kong-like gate:** every request needs an `apikey` header equal to the anon or service key (else 401).
The role comes from the verified `Authorization: Bearer` JWT (`role` claim ∈ anon/authenticated/service_role;
anything else → 401).

**Per request:** `BEGIN; SET LOCAL ROLE <role>; select set_config('request.jwt.claims', $claims, true);`
run; `COMMIT` (or `ROLLBACK` on error). All work is serialized through one PGlite queue. **Never** run a
request's SQL as `postgres`.

**/rest/v1 (PostgREST subset):**
- `GET/HEAD/POST/PATCH/DELETE /rest/v1/:relation` on `public` tables/views only.
- `select=` columns with `alias:col`; `*` allowed; embeds are rejected (400 `PGRST100`).
- Filters `eq,neq,gt,gte,lt,lte,like,ilike,is(null|true|false),in.(…)`, `not.<op>`, `or=(…)`/`and=(…)`
  with nesting and quoted values. `order=col.asc|desc[.nullsfirst|.nullslast]`. `limit`, `offset`, `Range`.
- `Prefer: count=exact`, `return=representation|minimal`. `Accept: application/vnd.pgrst.object+json`
  gives a single object or 406 `PGRST116`. `Content-Range` header.
- `POST /rest/v1/rpc/:fn` (named JSON args, looked up in `pg_proc`, each arg JSON→declared type in SQL).
  Returns set/table → JSON array, scalar/composite → JSON value, void → 204.
- Columns and functions are validated against the catalog. Values are always bound parameters.
- Errors use the PostgREST shape `{code,message,details,hint}` with the PostgREST HTTP status mapping
  (42501→403 for authenticated / 401 for anon, P0002→404, 23505/23503→409, 22P02/22023/23514/P0001→400,
  PGRST116→406). Unsupported syntax → 400, never silently ignored.

**/auth/v1 (GoTrue subset):** `POST /token?grant_type=password|refresh_token`, `GET/PUT /user`,
`POST /logout`, `GET /health`, `GET/POST /admin/users`, `GET/PUT/DELETE /admin/users/:id`
(`email_confirm`, `user_metadata`, `app_metadata`, `ban_duration` incl. `'none'`). bcrypt passwords
(bcryptjs). Banned users cannot sign in or refresh, and `/user` returns 403 `user_banned`. Access tokens
last 1h and carry Supabase claims (`aud, exp, iat, iss, sub, email, phone, app_metadata, user_metadata,
role:'authenticated', aal, amr, session_id, is_anonymous`). Signup (`POST /signup`) → 422
`signup_disabled`. `auth.users` and `auth.identities` columns mirror Supabase's so the same SQL works on both.

---

## 10. Testing contract

- `npm run verify` = `npm run typecheck && npm run lint && npm test`.
- Vitest projects: `unit` (`tests/unit/**`), `db` (`tests/db/**`, PGlite in-process),
  `integration` (`tests/integration/**`, `tests/routes/**`, `tests/localbase/**`; a globalSetup starts
  one in-memory localbase on a free port and seeds it, unless `SUPABASE_TEST_URL`,
  `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` are set, in which case it targets a
  real stack). Values are passed with `project.provide`/`inject`.
- `server-only` is aliased to an empty module in vitest.
- Seeded data is **read-only** for tests. Any test that mutates (reassign, disable, log_call, webhooks)
  creates its own users/leads via `tests/helpers/fixtures.ts` with unique emails.
- Seed users (password for all: `McQueen-dev-2026`):
  `admin@funnelmcqueen.test` (ADMIN, "Velo Admin"), `alex@funnelmcqueen.test` ("Alex Rivera", America/New_York),
  `blair@funnelmcqueen.test` ("Blair Chen", America/Chicago), `casey@funnelmcqueen.test`
  ("Casey Morgan", America/Los_Angeles), `dana@funnelmcqueen.test` ("Dana Brooks", **disabled** + banned).
- Fictional phones only: `+1 NXX 555-0100…0199`. Seed Twilio numbers: `+14155550150` (Alex),
  `+14155550151` (Blair), `+14155550152` (pool).
- Twilio webhook tests sign with `twilio.getExpectedTwilioSignature(testToken, url, params)`.
- Playwright: `channel: 'chrome'`, projects `mobile` (iPhone-sized viewport + iOS UA → tel:) and
  `desktop`, with `DIALER_DRIVER=mock`.
