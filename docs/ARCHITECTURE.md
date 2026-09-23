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
   (create/ban users, and the `revoke_user_sessions` RPC that ends a user's sessions, D31), (b) Twilio webhooks, and (c) the voicemail route's
   `get_voicemail_recording(callId, sessionUserId)` lookup after `getUser()` (DEVIATIONS D13). Nothing else.
   Grep-able: `createAdminClient(`.
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
    app-shell/           app-shell, sidebar, bottom-nav, user-menu, brand, nav-config, voicemail-badge
    common/              page-header, empty-state
    dialer/              call-button, in-call-bar, outcome-sheet, incoming-call, keypad, dialer-provider
    leads/ follow-ups/ pipeline/ dashboard/ admin/ import/
  lib/
    database.types.ts    generated (npm run db:types)
    utils.ts             shadcn cn()
    domain/              PURE, isomorphic, unit-tested:
      phone.ts website.ts dedupe.ts outcomes.ts statuses.ts csv.ts split.ts time.ts import-mapping.ts
    dialer/              client dialer module (types, resolve-mode, drivers/{twilio,tel,mock}.ts)
    supabase/browser.ts  createBrowserSupabase() (singleton)
    supabase/auth-redirect.ts  safeNextPath, LOGIN_PATH, isPublicPath, isAdminPath
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
| `DIALER_DRIVER` | server-only | `twilio` \| `tel` \| `mock`. Unset: `twilio` when configured, else `mock` in development/test and `tel` in production (never silently fake calls in prod). `mock` with `NODE_ENV=production` is an invalid environment (D24) |
| `TWILIO_ACCOUNT_SID` `TWILIO_AUTH_TOKEN` `TWILIO_API_KEY_SID` `TWILIO_API_KEY_SECRET` `TWILIO_TWIML_APP_SID` | server-only | required when `DIALER_DRIVER=twilio` |
| `CALENDAR_DRIVER` | server-only | `google` \| `mock`. Unset: `google` when the three `GOOGLE_*` variables below are all set (mirroring how `DIALER_DRIVER` auto-detects `twilio`), else `mock` outside production, "booking unavailable" in production (never silently invent availability in prod). `mock` with `NODE_ENV=production` is refused at startup (D46) |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_TOKEN_ENCRYPTION_KEY` | server-only | required for `CALENDAR_DRIVER=google` (or its auto-detect above); `GOOGLE_TOKEN_ENCRYPTION_KEY` is 32 random bytes, base64, and encrypts the stored refresh token at rest (D47) |

`src/server/env.ts` exports `getServerEnv()`, which parses lazily and caches (so importing never
throws at build time). `DIALER_DRIVER` reaches the client only as a prop from the `(app)` layout.
Because parsing is lazy, `src/instrumentation.ts` calls it from Next's `register()` hook, which runs
once and must finish before the server accepts requests: an invalid environment therefore aborts
startup instead of surfacing later as a failing route (D35). Throwing from the hook is not enough on
its own — Next logs the failed hook and keeps the process up, answering every request with a 500 —
so `register` also exits the process. `next build` never calls the hook, so builds are unaffected.

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
| deleted_at | timestamptz null | set only by `admin_delete_agent` (D40); CHECK `deleted_at is null or not active` |

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
| client_request_id | uuid | TEL idempotency key from `log_call` `p_call_id`, never the row id; not granted to API roles (addition, D16) |

CHECKs: `direction = 'INBOUND' or (user_id is not null and lead_id is not null)`,
`mode = 'IN_APP' or provider_call_sid is null`.

**follow_ups**
`id uuid PK`, `lead_id uuid not null FK leads ON DELETE CASCADE`,
`user_id uuid not null FK profiles ON DELETE RESTRICT`, `created_at timestamptz not null default now()`,
`due_at timestamptz not null`, `completed_at timestamptz`, `note text`.

**rate_limit_hits** (addition): `id bigint identity PK`, `user_id uuid not null`, `bucket text not null`,
`created_at timestamptz not null default now()`. RLS on, **no policies**, all privileges revoked from
anon/authenticated.

**lead_skips** (addition, D42, `20260915001700_skipped_leads.sql`): `id uuid PK`, `lead_id uuid not null FK leads ON DELETE CASCADE`,
`user_id uuid not null FK profiles ON DELETE RESTRICT`, `reason text` (null or CALL_LATER, NEEDS_RESEARCH, BAD_DATA, NOT_PRIORITY,
OTHER), `note text` (≤ 500), `created_at timestamptz not null default now()`, `resolved_at timestamptz`, `resolution text` (RESUMED,
CALLED, STATUS_CHANGED, FOLLOW_UP, REASSIGNED, SKIPPED_AGAIN; set together with `resolved_at`). Unique open skip per
`(lead_id, user_id) where resolved_at is null`; indexes `(user_id, created_at) where resolved_at is null`, `(lead_id, created_at)`.
Policy `lead_skips_select`: admin, or active caller's own skips on leads assigned to them. API roles have SELECT only.

### 4.3 Indexes
- leads: `(assigned_to, status)`, `(assigned_to, next_follow_up_at)`, `(assigned_to, last_contacted_at)`,
  `(phone)`, `(website_domain)`, `(dedupe_name_key)`, `(created_at)`; GIN `extensions.gin_trgm_ops` on
  `business_name, contact_name, email, website, city, phone`
- calls: `(user_id, created_at)`, `(lead_id, created_at)`, `(phone_number_id, created_at)`, unique `(provider_call_sid)`,
  unique `(user_id, lead_id, client_request_id) where client_request_id is not null`
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
- `leads_guard`: BEFORE INSERT OR UPDATE, SECURITY INVOKER. On INSERT `next_follow_up_at` is forced to null
  (a new lead has no follow-ups). On UPDATE by a privileged caller (definer RPCs, the follow_ups sync trigger,
  service_role) `NEW.next_follow_up_at := public.lead_earliest_open_follow_up(NEW.id)`. API callers (agents and
  admins) keep `OLD.next_follow_up_at`, which `follow_ups_sync_lead` keeps current, so direct writes to that
  column are silently ignored and `lead_earliest_open_follow_up` never needs to be granted to authenticated.
  Non-admin API callers may change only `status` and `notes` (else `42501`), and may not change `status` away from
  `DO_NOT_CONTACT` (DEVIATIONS D12).
- `follow_ups_sync_lead`: AFTER INSERT/UPDATE/DELETE on follow_ups, SECURITY DEFINER. Recomputes
  `leads.next_follow_up_at` for OLD/NEW lead_id.
- `leads_move_open_follow_ups`: AFTER UPDATE OF assigned_to on leads, SECURITY DEFINER. When the new owner is non-null,
  moves the lead's open follow-ups to them, on every assignment path (`reassign_leads`, a direct admin update, imports).
  Completed follow-ups keep their user.
- `follow_ups_guard`: BEFORE UPDATE. For non-privileged non-admins, `id`, `lead_id`, `user_id` and `created_at` are immutable.
- `profiles_validate_timezone` / `settings_validate_timezone`: BEFORE INSERT/UPDATE OF timezone, invalid IANA zone → `22023`.
- `profiles_guard` details: the lockout (own `role`/`active`) applies to every caller whose `auth.uid()` is the row;
  non-privileged non-admins may change only `name` (max 200 chars); admins may change anything except `id`,
  `email` (synced from auth.users only) and `created_at`. Since `20260915001400_delete_agent.sql` (D40), no API caller,
  admins included, may set or clear `deleted_at`, and a deleted profile is frozen for every caller, postgres and the service role
  included, except for the `email` that `on_auth_user_email_changed` copies in.
- `leads_reject_deleted_owner` / `follow_ups_reject_deleted_owner` / `phone_numbers_reject_deleted_owner`: BEFORE INSERT/UPDATE OF
  the owner column, run `reject_deleted_owner(column [, open_column])` (SECURITY DEFINER, no API role). They take FOR KEY SHARE on
  the owner's profile row and refuse a deleted owner with `22023`; with `admin_delete_agent`'s FOR UPDATE this serializes an
  assignment racing a delete. The follow-ups trigger also fires on `completed_at` (`open_column`), so reopening a deleted agent's
  completed follow-up is refused too.

`public.is_privileged_role()` returns `current_user not in ('anon','authenticated')`. It is SECURITY INVOKER
(it must see the real caller) and granted to authenticated, because the invoker guard triggers call it as the
API role. Inside SECURITY DEFINER functions `current_user` is the owner (`postgres`), so definer RPCs are
trusted and must do their own checks.

### 4.5 Grants (Supabase grants ALL to anon/authenticated by default, so revoke explicitly)
- `revoke all on all tables in schema public from anon;` (anon gets nothing; login page is static).
- `calls`: `revoke select on public.calls from authenticated;` then
  `grant select (id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes, duration_seconds, voicemail_duration_seconds, handled_at) on public.calls to authenticated;`
  Hidden from API reads: `user_id`, `phone_number_id`, `provider_call_sid`, `voicemail_recording_sid`.
  The app reads those through SECURITY DEFINER RPCs only.
- `rate_limit_hits`: revoke all from anon, authenticated.
- `follow_ups`: authenticated has INSERT and UPDATE only on `(lead_id, user_id, due_at, note, completed_at)`. API callers
  never choose `id` or `created_at`: a chosen id that collides with an existing row would reveal that row (D16).
- Functions: every migration ends by `revoke execute on function … from public, anon;` for each function
  it creates, then `grant execute … to authenticated` (API RPCs) or `to service_role` (webhook-only; also
  revoke from authenticated). `get_company_name()` is additionally granted to anon. Trigger functions and the internal
  `apply_rate_limit` are revoked from every API role, service_role included.
- Default privileges (migration 000300): `alter default privileges for role postgres revoke execute on functions from public`
  and `... in schema public revoke execute on functions from anon`, so a function a later migration forgets to
  revoke is still not callable by anon. authenticated/service_role keep Supabase's default EXECUTE, so
  service-only functions must still be revoked from authenticated. Tables: later tables are not granted to anon;
  they are granted to authenticated by default, so every later table must enable RLS.
- `revoke truncate, references, trigger on all tables in schema public from authenticated` (RLS does not cover TRUNCATE),
  plus `alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from
  authenticated` so tables created by later migrations never get them either.
- `tests/db/grants.test.ts` holds the EXECUTE matrix for every public function; a new function must be added there.

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
Sticky DO_NOT_CONTACT: any outcome on a DO_NOT_CONTACT lead keeps DO_NOT_CONTACT (DEVIATIONS D11).
`src/lib/domain/outcomes.ts` `outcomeToStatus` must stay identical (tests/db/log-call.test.ts checks all 96 pairs).
"Connected" in stats = outcome not null and not in (NO_ANSWER, VOICEMAIL, WRONG_NUMBER).

Call notes (log_call): ASCII whitespace (` \t\n\r\f\v`) is trimmed and blank becomes null. WRONG_NUMBER stores
`'Wrong number'` for blank notes, keeps notes that already match `^wrong number( — |$)` case-insensitively
(so a retried save never doubles the prefix), and otherwise stores `'Wrong number — ' || notes` (em dash U+2014).
`normalizeCallNotes` / `applyWrongNumberPrefix` in `outcomes.ts` mirror this exactly.

Error conventions raised by RPCs: `not_found` → `errcode 'P0002'` · `forbidden` → `'42501'` (used only where
404 would be wrong, e.g. inactive self) · validation → `'22023'` · `do_not_contact` / `call_in_progress` /
`rate_limited` → `'P0001'` with that exact message. App code maps by **error code** (`mapPostgrestError`), never by the
PostgREST HTTP status: PostgREST returns 500 for P0002 and 400 for P0001/22023. The app's own responses are
404 / 403 / 400 / 409 (429 for `rate_limited`) respectively.

| RPC | security | who | behavior |
|---|---|---|---|
| `log_call(p_outcome call_outcome, p_lead_id uuid default null, p_call_id uuid default null, p_notes text default null, p_follow_up_at timestamptz default null, p_follow_up_note text default null, p_duration_seconds int default null) → jsonb` | definer | authenticated | One transaction. Caller must be active. `p_call_id` first names a row the caller may log: any row for an admin, else `user_id = auth.uid()` with the row's lead assigned to the caller (or no lead). Failing that, it is looked up as the caller's TEL idempotency key on `p_lead_id` (`client_request_id`). A row the caller may not log is handled exactly like an unknown id, so known ids reveal nothing (D16). A found row's lead must match `p_lead_id` (if given), else `not_found`. If the row has no outcome yet, `call_count += 1`, else no increment (re-log only updates outcome/notes). `p_duration_seconds` (0..86400, else `22023`) applies only to TEL rows, and only if `duration_seconds` is null. In-app durations come from Twilio. If no row exists: `p_lead_id` is required and must be accessible, then insert a `TEL` OUTBOUND row with a server-generated id and `client_request_id = p_call_id` (unique per user and lead, making TEL logging idempotent; a retry sends the same `p_lead_id` or the returned `call_id`), `call_count += 1`. For lead rows: `last_contacted_at = now()`, `status = outcome_to_status()`, unhandled voicemails on that lead get `handled_at = now()`, and on the first log of that call row only (never on a retry) open follow-ups due before the end of today (lead owner's timezone, else the caller's; D22) get completed and, if `p_follow_up_at` is set (must be within `now() - 1 minute` .. `now() + 1825 days`, else `22023`; D21), a follow-up is inserted for `coalesce(lead.assigned_to, auth.uid())`. `FOLLOW_UP` requires `p_follow_up_at` (22023). `WRONG_NUMBER` prefixes notes once (see "Call notes" above). A **new** TEL row on a DO_NOT_CONTACT lead raises `do_not_contact` (DEVIATIONS D8); logging an existing row still works. Returns `{call_id, lead_id, status, call_count, next_follow_up_at}` (lead fields null for an unmatched inbound call). |
| `get_next_lead(p_exclude_ids uuid[] default '{}') → table(lead_id, business_name, contact_name, phone, status, city, state, last_contacted_at, next_follow_up_at, call_count, reason text)` | definer | authenticated | Caller's own assigned leads only. Excludes CLIENT/NOT_INTERESTED/DO_NOT_CONTACT and `p_exclude_ids`. Excludes leads with `last_contacted_at > now() - 4h` unless they have an open follow-up due (`due_at <= now()`) or an unheard voicemail. Buckets in order, reason codes: `VOICEMAIL` (unheard voicemail, oldest voicemail first) → `OVERDUE` (open follow-up `due_at < now()`, oldest first) → `DUE_TODAY` (open follow-up due later today in caller's timezone, soonest first) → `NEW` (status NEW/TO_CALL, oldest created first) → `RETRY` (NO_ANSWER/VOICEMAIL, `last_contacted_at asc nulls first`, then `call_count asc`). Leads matching no bucket are not suggested. Returns 0 or 1 row. The voicemail and follow-up lookups are computed set-based (one grouped pass per child table over the caller's candidate leads, joined back on), never as correlated subqueries per assigned lead — this is the hot path and its cost must not grow with leads-per-agent (D39). |
| `create_outbound_call(p_lead_id uuid) → uuid` | definer | authenticated | Active caller with `in_app_calling_enabled`, else forbidden. Lead must be accessible (admin: any lead), else `not_found`. DO_NOT_CONTACT → `do_not_contact`. Deletes the caller's un-started pre-created rows (OUTBOUND/IN_APP with no provider SID, no status and no outcome), so each agent has at most one dialable row (D15). If the caller has an unlogged call (`outcome is null`) with `call_status in ('queued','ringing','in-progress')` created in the last 2h → `call_in_progress`. Applies the `outbound_call` rate limit (12/min) itself → `P0001 rate_limited` (D14). Inserts OUTBOUND/IN_APP row with `user_id = auth.uid()` and `remote_e164 = lead.phone`. |
| `get_lead_call_history(p_lead_id uuid) → table(id, created_at, direction, mode, call_status, outcome, notes, duration_seconds, has_voicemail boolean, voicemail_duration_seconds, handled_at, is_mine boolean, caller_name text, caller_id_e164 text)` | definer | authenticated | Empty set if `not can_access_lead`. `caller_name`/`caller_id_e164` are non-null **only for admins**. Newest first. |
| `get_voicemail_recording(p_call_id uuid, p_user_id uuid) → text` | definer | **service_role only** | Recording SID if the active user `p_user_id` may access that call (admin, lead assigned to them, or `lead_id is null and user_id = p_user_id`), else null. Refuses API-role JWT claims. Called only by `/api/voicemail/[callId]` with the `getUser()` id (D13). |
| `mark_voicemail_heard(p_call_id uuid) → boolean` | definer | authenticated | Same access (true for any accessible voicemail). Sets `handled_at` if null only when the caller owns it: lead assigned to the caller, or unmatched call routed to the caller; for admins also admin-only unmatched calls and unassigned leads. An admin play of an agent's voicemail leaves it unheard (D20). |
| `list_voicemails(p_unheard_only boolean default false, p_limit int default 50, p_offset int default 0) → table(call_id, created_at, lead_id, business_name, contact_name, phone, lead_status, voicemail_duration_seconds, handled_at, total_count bigint)` | definer | authenticated | Scoped like `get_voicemail_recording`. For unmatched calls, `phone = remote_e164` and business is null. |
| `unheard_voicemail_count() → int` | definer | authenticated | Scoped count. |
| `reassign_leads(p_lead_ids uuid[], p_to_user_id uuid) → int` | definer | admin | `p_to_user_id` must be an active AGENT or ADMIN, or null (= unassign). Updates `assigned_to`; the `leads_move_open_follow_ups` trigger moves open follow-ups to the new owner (when non-null). Calls are untouched. Returns the updated count. |
| `search_leads(p_query text default null, p_statuses lead_status[] default null, p_source text default null, p_assigned_to uuid default null, p_unassigned boolean default false, p_sort text default 'created_at', p_dir text default 'desc', p_limit int default 25, p_offset int default 0) → table(id, created_at, business_name, contact_name, phone, email, website, city, state, country, source, status, assigned_to, last_contacted_at, next_follow_up_at, call_count, total_count bigint)` | **invoker** | authenticated | RLS scopes rows. Non-admins also get an explicit `assigned_to = auth.uid()`, and `p_assigned_to`/`p_unassigned` are ignored. Query matches ILIKE on business/contact/email/website/city, or phone digits substring when the query is phone-like (only digits, spaces and `+-().`) with ≥3 digits (D17). Sort whitelist: `business_name, last_contacted_at, next_follow_up_at, call_count, created_at` (nulls last). `p_limit` is clamped to 1..100. |
| `pipeline_column(p_statuses lead_status[], p_limit int default 20, p_offset int default 0, p_assigned_to uuid default null, p_unassigned boolean default false) → table(id, business_name, contact_name, phone, status, assigned_to, next_follow_up_at, updated_at, call_count, total_count bigint)` | **invoker** | authenticated | Stage 8 (`20260915000800_pipeline.sql`). Same scoping as `search_leads`: RLS plus an explicit `assigned_to = auth.uid()` for non-admins, and `p_assigned_to`/`p_unassigned` are ignored for them. Null or empty `p_statuses` → no rows. Order `next_follow_up_at asc nulls last, updated_at desc, id asc`; `p_limit` clamped to 1..100. Used by `src/server/services/pipeline.ts` (one call per column; see the pipeline DEVIATIONS entry). |
| `list_follow_ups(p_tab text, p_limit int default 25, p_offset int default 0) → table(follow_up_id, lead_id, business_name, contact_name, phone, lead_status, due_at, completed_at, note, owner_name, total_count bigint)` | **invoker** | authenticated | Stage 7 (`20260915000700_follow_ups.sql`). RLS scopes rows; non-admins also get explicit `f.user_id = auth.uid() and l.assigned_to = auth.uid()`. Tabs: `overdue` (open, `due_at < now()`, oldest first), `today` (open, `now() <= due_at <` end of today in the **caller's** profile timezone, soonest first), `upcoming` (open, `due_at >=` end of today, soonest first), `completed` (`completed_at is not null`, newest completion first); ties by `id`. The tab is trimmed and lower-cased; any other value (including null) → `22023`. `owner_name` (`profiles.name`, else email) is filled for admins only and is null for agents, whose branch never reads profiles. Inactive or missing caller → no rows. `p_limit` clamped to 1..100, `p_offset` to ≥ 0. `src/server/services/follow-ups.ts` wraps it (`listFollowUps`, 25 per page); `completeFollowUp` and `rescheduleFollowUp[To]` are user-session updates `where completed_at is null` (0 rows → `not_found`), and reschedule choices are resolved in the caller's profile timezone (D26). |
| `follow_up_tab_counts() → jsonb` | **invoker** | authenticated | Stage 7. `{overdue, today, upcoming, completed, voicemails_unheard}` with the same scoping and boundaries as `list_follow_ups`; `voicemails_unheard = unheard_voicemail_count()`. All zeros for an inactive or missing caller. |
| `list_lead_sources() → setof text` | invoker | authenticated | Distinct non-null sources visible to the caller. |
| `touch_device_presence() → void` | definer | authenticated | `device_seen_at = now()` for the active caller. |
| `consume_rate_limit(p_bucket text) → boolean` | definer | authenticated | Keyed on `auth.uid()`; inactive or missing caller → `42501`. Only `voice_token` and `export` are accepted (else `22023`; `outbound_call` is enforced inside `create_outbound_call` and is still refused here). Delegates to `apply_rate_limit`. |
| `apply_rate_limit(p_user_id uuid, p_bucket text) → boolean` | definer | **none** (internal) | Fixed policy per bucket: `voice_token` 20 per 10 min, `outbound_call` 12 per min, `export` 30 per 10 min (D36), `book_appointment` 20 per hour (D46); unknown bucket → `22023`. Prunes hits older than that bucket's window, returns false when over the limit, otherwise records a hit (D14). |
| `claim_caller_id(p_user_id uuid) → table(phone_number_id uuid, e164 text)` | definer | **service_role only** | Least recently used active number assigned to the user, else least recently used active pool number (`last_used_at nulls first, created_at`), locking the assigned number with `for no key update` (without SKIP LOCKED, so the KEY SHARE lock of a concurrent calls insert never causes a pool fallback) and pool numbers with `for no key update skip locked`. Sets `last_used_at = now()`. |
| `apply_call_status(p_call_sid text, p_status text, p_duration int default null) → boolean` | definer | service_role only | Idempotent. Finds the row by `provider_call_sid`. Terminal statuses (completed/busy/no-answer/failed/canceled) are never replaced by non-terminal ones, and a terminal status only changes if the duration is being filled. `duration_seconds = greatest(existing, p_duration)`. |
| `record_voicemail(p_call_sid text, p_recording_sid text, p_duration int) → boolean` | definer | service_role only | Atomic: sets the recording where `voicemail_recording_sid is null`. On first set, if the lead has an owner, inserts follow-up (owner, `due_at = now()`, note 'Voicemail received'). Returns whether it was newly set. |

Stage 6 dashboard RPCs (`20260915000600_dashboards.sql`, all SECURITY DEFINER, `search_path=''`, executable by
authenticated + service_role only). Shared stat definitions: stats belong to `calls.user_id`; dial = OUTBOUND and
(`outcome is not null or provider_call_sid is not null`); connected = outcome not null and not in
(NO_ANSWER, VOICEMAIL, WRONG_NUMBER), any direction; interested/appointments = that outcome, any direction; talk seconds =
`sum(coalesce(duration_seconds,0))` over both directions; "today" = `[local midnight, next local midnight)` of
`calls.created_at` in that user's `profiles.timezone`.

| RPC | who | behavior |
|---|---|---|
| `get_my_dashboard() → jsonb` | active caller (else `42501`) | `{timezone, daily_call_target, dials_today, remaining, target_hit, connected_today, interested_today, appointments_today, talk_seconds_today, follow_ups_due, unheard_voicemails}` for `auth.uid()` only. `remaining = greatest(target - dials, 0)`; `target_hit = target > 0 and dials >= target` (a zero target is never "hit"). `follow_ups_due` = the caller's open follow-ups on leads assigned to the caller with `due_at <` end of today. `unheard_voicemails = unheard_voicemail_count()` (so an admin caller gets the admin scope). Never team data. |
| `admin_agent_rows() → table(user_id, name, email, role, active, in_app_calling_enabled, timezone, daily_call_target, leads_assigned bigint, dials_today bigint, connected_today bigint, interested_today bigint, appointments_today bigint, talk_seconds_today bigint, assigned_numbers text[])` | admin (else `42501`) | One row per AGENT and ADMIN profile, active or not, each "today" in that user's own timezone. `assigned_numbers` = active `phone_numbers.e164` assigned to the user, sorted (`{}` when none). Ordered `active desc, lower(name), email`. |
| `admin_team_totals() → jsonb` | admin (else `42501`) | `{leads_total, leads_unassigned, clients_total (status CLIENT), disabled_agents_with_leads (inactive profiles with ≥1 assigned lead), leads_on_disabled_agents, calls_today, connected_today, interested_today, appointments_today, talk_minutes_today}`. Today totals are sums of `admin_agent_rows()` (calls with a null `user_id` count for nobody); `talk_minutes_today = round(sum(talk_seconds_today) / 60)`. |

Services: `src/server/services/dashboard.ts` `getAgentDashboard(ctx)` (`get_my_dashboard` + `nextLead(ctx, [])`),
`getAdminDashboard(ctx)` (`requireAdmin`; `admin_team_totals` + `admin_agent_rows`), plus `getMyDashboardStats`,
`getTeamTotals` and `listAgentStatsRows` (camelCase `AgentStatsRow`) for other pages. The admin dashboard lists every AGENT row
and ADMIN rows only when they have leads or activity today; each row links to `/admin/agents/<user_id>`.

Later stages add (same conventions): report RPCs (`admin_report_agents(p_from, p_to)`,
`admin_report_numbers(p_from, p_to)`), follow-up listing (`list_follow_ups(p_tab, p_limit, p_offset)`),
duplicate lookup (`find_duplicate_leads(p_phones text[], p_domains text[], p_name_keys text[])`, admin).
Admin-only RPCs raise `42501` for non-admins, and stats RPCs aggregate by `calls.user_id` (stats stay
with whoever made the call).

Stage 9 (`20260915000900_import_export.sql`, DEVIATIONS D29). Both SECURITY INVOKER (RLS applies), granted to authenticated and service_role:

| RPC | behavior |
|---|---|
| `find_duplicate_leads(p_phones text[], p_domains text[], p_name_keys text[]) → table(lead_id, business_name, city, phone, website_domain, dedupe_name_key)` | Admin only (`42501`, also for disabled admins). Leads whose `phone`, `website_domain` (keys lower-cased/trimmed) or `dedupe_name_key` equals any key; each lead once, `created_at, id` order. Null arrays = empty; blank keys and `'|city'` name keys ignored; more than 1000 entries in any array → `22023`. |
| `export_leads(p_query, p_statuses, p_source, p_assigned_to, p_unassigned, p_after_created_at, p_after_id, p_limit) → table(id, created_at, business_name, contact_name, phone, email, website, address, city, state, country, status, notes, assigned_to, last_contacted_at, next_follow_up_at, call_count)` | Active caller (else no rows). Same filters as `search_leads` (incl. D17); non-admins get only `assigned_to = auth.uid()` and their `p_assigned_to`/`p_unassigned` are ignored. Keyset paging: rows after `(p_after_created_at, p_after_id)`, `p_limit` clamped 1..1000. |

App side: `src/components/import/import-model.ts` is the pure, isomorphic import model (parse, `checkImportRow`, `buildImportPreview`,
`buildImportPlan`, `buildImportBatches`, `summarizeImport`, `buildSkippedRowsCsv`) used by both the wizard and the server.
`src/server/services/import.ts` (`listImportAgents`, `checkImportDuplicates(ctx, {phones, domains, nameKeys})` one ≤1000-key chunk,
`importLeadsBatch(ctx, {mapping, appendUnmappedToNotes, rows: [{rowIndex, position, cells}] ≤ 500}, BatchAssignment)` → per-row
`{rowIndex, ok, leadId | reason}`) requires an active admin, validates with Zod (`validation` AppError), re-validates raw cells, checks
assigned ids are active AGENTs, and inserts with the admin session. Actions in `src/server/actions/import.ts`. Export:
`GET /api/leads/export?<leads list query>` → `src/server/http/leads-export.ts` `handleLeadsExport(req, { now, pageSize })` →
`src/server/services/export.ts` `createLeadExport(ctx, filters)`; `getRouteAuth` (cookie or Bearer), 401 without an active session,
streamed `text/csv; charset=utf-8`, `attachment; filename="funnel-mcqueen-leads-YYYY-MM-DD.csv"`, `Cache-Control: no-store`.

Stage 10b (`20260915001100_numbers_reports.sql`, DEVIATIONS D27). All SECURITY DEFINER, admin-only (`42501`), granted to
authenticated and service_role, shared stat definitions, attribution by `calls.user_id`:

| RPC | behavior |
|---|---|
| `admin_phone_number_rows() → table(id, e164, label, twilio_sid, active, assigned_to, assigned_name, calls_today bigint, last_used_at, created_at)` | Every number. `assigned_name` null for the pool. `calls_today` = calls in both directions on the number since midnight in the **calling admin's** timezone. Ordered active first, then `created_at`. |
| `admin_report_agents(p_from timestamptz, p_to timestamptz) → table(user_id, name, active, dials, connected, connect_rate numeric, talk_seconds, avg_call_seconds numeric, interested, appointments, clients)` | Half-open `[p_from, p_to)`. Rows: every AGENT profile plus ADMINs with calls in range. `connect_rate` rounded to 4 decimals, `avg_call_seconds` to 2; 0 when no dials / no timed calls. `clients` is current, not range-bound. `p_from`/`p_to` null, `p_from >= p_to`, or a span over 366 days + 1 hour → `22023`. |
| `admin_report_numbers(p_from, p_to) → table(phone_number_id, e164, label, active, dials, answered, answer_rate numeric)` | Every number. `answered` = its outbound dials with `call_status = 'completed'` and `duration_seconds > 0`. Same range checks. |
| `admin_report_totals(p_from, p_to) → jsonb {agents, dials, connected, connect_rate, talk_seconds, avg_call_seconds, interested, appointments, clients}` | Sums of `admin_report_agents` rows; rates recomputed from the sums with the same rounding. |

App side: `src/server/services/phone-numbers.ts` (`listPhoneNumbers`, `listAssignableAgents`, `addPhoneNumber(ctx, input, { verifier })`,
`assignPhoneNumber`, `unassignPhoneNumber`, `deactivatePhoneNumber`, `reactivatePhoneNumber`, `resolveNumberVerifier(env)` →
`twilio | mock | unavailable`) writes `phone_numbers` with the admin's session (RLS). `src/server/services/reports.ts` `getReport(ctx,
{ from, to })` takes inclusive `yyyy-MM-dd` dates, converted with `components/admin/reports/date-range.ts` `rangeToInstants` in the admin's
timezone.

Stage 10a (`20260915001000_admin_agents.sql`, DEVIATIONS D28):

| RPC | who | behavior |
|---|---|---|
| `admin_agent_activity(p_user_id uuid, p_from timestamptz, p_to timestamptz) → jsonb` | admin (else `42501`) | `{profile {user_id, name, email, role, active, timezone, daily_call_target, in_app_calling_enabled, created_at, leads_assigned, clients}, from, to, stats {dials, connected, interested, appointments, talk_seconds, calls_with_duration, inbound_calls, total_calls}, outcomes {OUTCOME: count}, recent_calls [≤50 newest {id, created_at, direction, mode, outcome, call_status, duration_seconds, lead_id, business_name}]}`. Calls by `calls.user_id` in half-open `[p_from, p_to)`, shared stat definitions. Unknown user → `P0002`; null bounds, `p_to <= p_from` or a span over 400 days → `22023`. `clients` is current, not range-bound. |

App side: `src/server/services/agents.ts` (`listAgents`, `createAgent(ctx, input, deps)`, `setAgentActive(ctx, id, active, deps)`,
`setInAppCalling`, `updateAgentProfile`, `countReassignableLeads`, `bulkReassign`, `reassignSelected`, `getAgentActivity(ctx, id, range)`
with `range ∈ today | 7d | 30d` in the admin's timezone). `deps.authAdmin` (service role) is used only for `auth.admin.createUser` and
`auth.admin.updateUserById({ ban_duration })`; every profile/lead read and write uses the admin's session. `src/server/services/settings.ts`
(`getSettingsPageData`, `updateOwnName`, `changePassword`, `requestEmailChange`, `getCompanyDefaults`, `updateCompanySettings`,
`updateAgentTarget`). Dialer context additions: `deviceReady`, `setInputDevice(id)`, `setOutputDevice(id)`, `testSpeaker()` (each resolves
false without a loaded driver that supports it); the chosen devices live in localStorage `fmq.audioInput` / `fmq.audioOutput` and are
re-applied whenever the in-app device becomes ready.

Delete agent (`20260915001400_delete_agent.sql`, DEVIATIONS D40):

| RPC | who | behavior |
|---|---|---|
| `admin_agent_delete_check(p_user_id uuid) → jsonb {leads, open_follow_ups, completed_follow_ups, calls, phone_numbers, deleted, email, reason, deletable}` | admin (else `42501`) | Read only. `reason` is `deleted`, `self`, `admin`, `has_work` (leads or open follow-ups) or null; `deletable = reason is null`. `email` is the profile email, which tells a finished delete from an unfinished one. Unknown id → `P0002`. |
| `admin_delete_agent(p_user_id uuid) → jsonb {user_id, already_deleted, phone_numbers_unassigned}` | admin (else `42501`) | Locks the profile FOR UPDATE. Unknown id → `P0002`; admin target or self → `42501`; leads or open follow-ups → `P0001 agent_has_work` with `DETAIL` `{"leads":n,"open_follow_ups":m}`. Otherwise unassigns the agent's phone numbers and sets `deleted_at = now()`, `active = false`, name + " (deleted)" ("Deleted agent" when blank). Calls and completed follow-ups are untouched. An already deleted profile returns `already_deleted: true`. |

| `revoke_user_sessions(p_user_id uuid) → integer` (`20260915001500_revoke_user_sessions.sql`, D31) | service role only | Deletes the user's `auth.sessions` rows (their refresh tokens cascade) and returns how many. Null id → `22023`. On localbase `auth.sessions` is a view over `localbase.sessions` (`localbase/auth-compat.sql`). |

The same migration also replaces two existing functions, changing one condition each: `admin_report_agents` lists an AGENT profile
only when it is not deleted, unless it has calls in the range or CLIENT leads (so `admin_report_totals.agents` drops deleted agents
too), and `mark_voicemail_heard` lets an admin mark heard a lead-less voicemail routed to a deleted agent.

`admin_agent_rows` is dropped and recreated with a trailing `deleted boolean` column. Deleted agents stay in its result so
`admin_team_totals` keeps counting calls they made today; `listAllAgentRows` (settings) and `listAgentStatsRows` (admin dashboard rows)
filter them out, and `listAgents` keeps only unfinished deletes (`AgentRow.deletePending`, profile email not yet
`deletedAuthEmail(id)`) on the Agents list and out of the reassign targets. `listAgentsForFilter` (Leads and Pipeline) skips deleted
profiles. App side: `src/server/services/agents.ts` `getAgentDeleteCheck(ctx, id)` (adds `loginClosed`) and
`deleteAgent(ctx, id, deps)`, which runs the RPC with the admin's session and then closes the login in three repeatable steps:
through `deps.authAdmin` a new password and a permanent ban, then `deps.revokeSessions(id)`, then the Auth email moved to
`deletedAuthEmail(id)` = `deleted-<id>@deleted.invalid` (with `email_confirm: true`, so nothing is mailed). A failed step is
`unavailable` with a message naming what is already done; deleting again finishes it, and `deleteAgentAction` refreshes on that error
so the list shows **Delete unfinished** with a **Finish deleting** action. `setAgentActive` answers `not_found` for a deleted agent,
and if a delete lands while it reactivates, it bans the login again. The drill-down page shows a **Deleted** badge.

Bulk lead actions (`20260915001600_bulk_leads.sql`, DEVIATIONS D41). All SECURITY INVOKER, so RLS and the guards apply; every id
list is de-duplicated and more than 5000 ids is `22023 too_many_leads`.

| RPC | who | behavior |
|---|---|---|
| `search_lead_ids(p_query, p_statuses, p_source, p_assigned_to, p_unassigned, p_limit ≤ 5000) → table(id, total_count)` | active user | Same visibility and filters as `search_leads`, ordered `created_at desc`. |
| `bulk_set_lead_status(p_lead_ids uuid[], p_status, p_expected_status default null) → table(lead_id, previous_status, result)` | active user | One row per visible lead: `updated`, `unchanged` (same status, or not at `p_expected_status`), `locked` (agent and DO_NOT_CONTACT). |
| `bulk_assign_leads(p_lead_ids uuid[], p_to_user_id, p_expected_assigned_to default null, p_match_expected default false) → table(lead_id, previous_assigned_to, result)` | admin (42501) | Moves eligible leads with `reassign_leads` (called even when none are eligible, so a bad target is always 22023). |
| `bulk_schedule_follow_ups(p_lead_ids uuid[], p_due_at, p_note default null, p_set_note default false) → table(lead_id, follow_up_id, result)` | active user | Per lead: reschedule the owner's earliest open follow-up or create one (`rescheduled` / `created`); owner = lead's agent for an admin on an assigned lead, else the caller. Time must be within (now − 1 day, now + 5 years), note ≤ 500, else 22023. |
| `bulk_complete_follow_ups(p_lead_ids uuid[]) → integer` | active user | Completes every visible open follow-up on the leads. |
| `bulk_set_lead_source(p_lead_ids uuid[], p_source) → integer` | admin (42501) | Blank clears; ≤ 200 chars. Counts leads that changed. |
| `bulk_delete_leads(p_lead_ids uuid[]) → integer` | admin (42501) | Hard delete; calls and follow-ups cascade. |
| `export_selected_leads(p_lead_ids uuid[], p_after_created_at, p_after_id, p_limit ≤ 1000)` | active user | `export_leads` columns and keyset paging, limited to the ids. |

App side: `src/server/services/bulk-leads.ts` (`listMatchingLeadIds`, `bulkUpdateStatus` / `undoBulkStatus`, `bulkAssign` /
`undoBulkAssign`, `bulkScheduleFollowUp`, `bulkCompleteFollowUps`, `bulkSetSource`, `bulkDelete`), actions in
`src/server/actions/bulk-leads.ts`, result messages in `src/lib/domain/bulk-leads.ts`. `POST /api/leads/export` takes form field
`ids` (Origin-checked, `export` rate limit). UI: `src/components/leads/bulk/*` (selection rules in `selection.ts`, a sessionStorage
store in `selection-store.ts`).

Skipped queue (`20260915001700_skipped_leads.sql`, DEVIATIONS D42):

| RPC | who | behavior |
|---|---|---|
| `skip_lead(p_lead_id uuid, p_reason text default null, p_note text default null) → uuid` | active owner of the lead | Closes the caller's open skip on the lead (SKIPPED_AGAIN), inserts a new one. Not the owner or unknown → P0002; bad reason or note → 22023. |
| `resume_skipped_lead(p_lead_id uuid) → integer` | active user | Closes open skips (RESUMED): the caller's own on their own lead, or every one for an admin. Returns how many. |
| `list_skipped_leads(p_limit ≤ 100, p_offset) → table(skip_id, lead_id, business_name, contact_name, phone, lead_status, reason, note, skipped_at, next_follow_up_at, assigned_to, owner_name, total_count)` | active user (INVOKER) | Open skips, oldest first; `assigned_to` and `owner_name` only for admins. |

Triggers `leads_resolve_skips` (AFTER UPDATE OF assigned_to, status, last_contacted_at: REASSIGNED for skips of users who no longer own
the lead; CALLED when `last_contacted_at` changes, else STATUS_CHANGED when status changes) and `follow_ups_resolve_skips` (AFTER INSERT
OR UPDATE OF due_at of an open follow-up: FOLLOW_UP for that user's skip). `get_next_lead` is unchanged from 001300 except that
`mine` leaves out leads with an open skip by the caller. App side: `src/server/services/skipped-leads.ts`, the Skipped tab on
/follow-ups (`FOLLOW_UP_TABS` gains `skipped`, `FollowUpCounts.skipped`), `SkipLeadMenu`, and the skip notice and history on the
lead page.

Agent Today (`20260915001800_agent_today.sql`, DEVIATIONS D43):

| RPC | who | behavior |
|---|---|---|
| `get_my_call_days() → table(day date, dials bigint)` | active user (definer, 42501 otherwise) | The caller's dials on each of their last 7 local days, oldest first, with get_my_dashboard's dial definition. |
| `my_caller_id_available() → boolean` | active user (definer, 42501 otherwise) | An active number assigned to the caller, or an active pool number, exists. |

`getAgentDashboard` adds `today` (`callDays`, `callerIdAvailable`, `overdueFollowUps` from `follow_up_tab_counts`, `skipped`,
`leadsAssigned`); `getAdminDashboard` adds `attention` (`activePhoneNumbers`, `skipped`). Goal, pace copy, next best action and
consistency are pure functions in `src/lib/domain/daily-goal.ts`; `TargetBar` takes a `DailyGoal`.

### 4.8 Migration files (ownership slots)
```
supabase/migrations/20260915000100_core_schema.sql     stage 1
supabase/migrations/20260915000200_rls.sql             stage 1
supabase/migrations/20260915000300_core_rpcs.sql       stage 1
supabase/migrations/20260915000400_review_fixes.sql    stages 2-5 (latest log_call / mark_voicemail_heard bodies)
supabase/migrations/20260915000600_dashboards.sql      stage 6
supabase/migrations/20260915000700_follow_ups.sql      stage 7
supabase/migrations/20260915000800_pipeline.sql        stage 8
supabase/migrations/20260915000900_import_export.sql   stage 9
supabase/migrations/20260915001000_admin_agents.sql    stage 10a (agents drill-down)
supabase/migrations/20260915001100_numbers_reports.sql stage 10b (phone numbers, reports)
supabase/migrations/20260915001200_review_fixes_2.sql  stages 6-10 review fixes (round 2)
supabase/migrations/20260915001300_review_fixes_3.sql  final review round (get_next_lead cost, export limit)
supabase/migrations/20260915001400_delete_agent.sql    delete agent (D40)
supabase/migrations/20260915001500_revoke_user_sessions.sql  end a user's Auth sessions without a hosted admin route (D31)
supabase/migrations/20260915001600_bulk_leads.sql      bulk lead actions (D41)
supabase/migrations/20260915001700_skipped_leads.sql   Skipped queue (D42)
supabase/migrations/20260915001800_agent_today.sql     agent Today dashboard (D43)
supabase/migrations/20260915001900_calendar_booking.sql closer calendar booking (D46)
supabase/migrations/20260915002000_google_calendar.sql   Google Calendar connection (D47)
```
Later migrations may `create or replace function`. After `npm run db:types`, commit the regenerated types.
Migrations 000600-001100 create 13 distinct functions (no overlapping `create or replace`). `tests/db/stats-consistency.test.ts`
asserts that `get_my_dashboard`, `admin_agent_rows`, `admin_agent_activity` and `admin_report_agents` return identical dials,
connected, interested, appointments and talk seconds for the same agent and local day (New York, Los Angeles, Auckland), that
`admin_report_numbers` counts the same dials, and that both team totals equal the sums of their rows. Talk time is displayed by one
helper, `components/common/format.ts` `formatTalkTime` ("45s", "12m", "1h 05m"). The admin dashboard's team tiles are built by
`teamTotalsItems` (`components/dashboard/format.ts`) and use that same helper, so the team tile floors exactly like the per-agent
rows beneath it; Reports still shows whole talk minutes (`talkMinutes`).

Migration `20260915001200_review_fixes_2.sql` replaces four functions so identically labelled numbers agree across screens:
`admin_team_totals` adds `clients_assigned`, `clients_unassigned` and `talk_seconds_today`; `admin_report_agents` also lists ADMIN
profiles that currently hold CLIENT leads (so the report "Clients" total equals the dashboard's assigned count);
`follow_up_tab_counts` adds `voicemails_total`, taken from `list_voicemails` itself so the Voicemails badge always equals the rows
that tab lists; and `admin_phone_number_rows` is dropped and recreated with `assigned_active`, so a number held by a disabled agent
is visible as parked. "Clients" means **leads currently assigned with status CLIENT** on every surface; the dashboard shows
unassigned client leads as a sub-line rather than folding them into that number. The agent drill-down
(`getAgentActivity`) computes its range in the **target agent's** timezone, matching `admin_agent_rows` and `get_my_dashboard`.
Admin-only profile lookups (`createLeadExport`, `listAgentsForFilter`) read `profiles` in explicit `.range()` pages, because an
unpaginated PostgREST response is silently capped at db-max-rows.

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
- Every Supabase client that owns the session cookie (`server.ts`, `request.ts`, `proxy.ts` and the browser
  client) passes `cookieOptions: sessionCookieOptions()` from `src/lib/supabase/cookie-options.ts`, which
  sets `secure` in production. `@supabase/ssr` sets no `Secure` flag of its own (D34).
- A malformed id is `not_found`, never `validation`, wherever a service takes one: `parseId` in
  `services/leads.ts` and `services/follow-ups.ts`, `parseCallId` in `services/calls.ts`, the uuid check in
  `pipeline.ts`, and `logCall`'s own id fields (D32). Only genuine form errors are `validation`.
- `AppError` codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `validation` (400),
  `conflict` (409), `rate_limited` (429), `unavailable` (503), `internal` (500, unmapped errors).
  Route handlers that browsers call with cookies use `getRouteAuth(req) → { ctx, applyCookies }`. `mapPostgrestError(err)` maps P0002→not_found,
  42501→forbidden, 22023/22P02/23514→validation, P0001 do_not_contact/call_in_progress/slot_taken→conflict, P0001 rate_limited→rate_limited.
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
is a client-generated UUID passed to `log_call` together with the lead id for idempotency. It is stored as
`client_request_id`, and `log_call` returns the row id as `call_id`. Mock driver: rings 1.2s → connected until
hangup. It exposes `window.__fmqMockDialer = { remoteHangup(reason), simulateIncoming(callId) }` only
when `DIALER_DRIVER=mock`.

Stage 3 module details (`src/lib/dialer`, `src/components/dialer`):
- `IncomingCall.onCancel?(listener)` (optional): the caller hung up before it was answered. Without it the incoming
  dialog closes after 30s. The twilio driver implements it from the moment the call arrives (a listener added after the
  cancel is called at once), and its `accept()` throws once the SDK call is no longer `pending`, so a late Accept shows
  "Could not answer" instead of an in-call state with no call. `hangup()` on an SDK call that is already closed ends the call locally.
- `InAppDriver.onStateChange?(cb: (state: 'ready' | 'unavailable') => void)` (optional): the twilio driver reports
  `unavailable` on `unregistered`, on token-expired errors (20104/31205) and when a token refresh still fails at the end of the
  60s `tokenRefreshMs` window (retries with 2s..16s backoff), and `ready` on `registered`.
- `startDeviceSession` (`lib/dialer/device-session.ts`) is the device lifecycle behind `DialerProvider`. The device state is
  `off | registering | ready | failed`. After 15s without registration the state is `failed` (tel: fallback), but a later success
  still becomes `ready`. `unavailable` → `failed`, with re-registration every 60s. A 403 from `/api/calls/outbound` → `turnOff()`
  (driver destroyed) plus `router.refresh()`. A 503 → `failed`, retried later. Presence heartbeats run only while `ready`. Accept
  uses the loaded driver whatever its state.
- `useCallModePreference(): [CallModePreference, (p) => void]` (`lib/dialer/preference.ts`); renders `auto` on the server.
- `useDialer()` (`components/dialer/dialer-context.tsx`) returns `{ state, timezone, dialMode, connecting, startCall,
  beginTelCall, hangup, setMuted, sendDigits }`, or null outside the provider. `state` is the `dialerReducer` union
  from `lib/dialer/state.ts`.
- Microphone permission is requested before the first in-app call or answer of the page session for the `twilio`
  driver only (the mock driver plays no audio).
- A tapped tel: call is kept in sessionStorage `fmq.pendingTel` (`{userId, leadId, label, clientRequestId, startedAt,
  stage}`) until it is logged or dismissed, so the outcome sheet survives a reload. Sign-out (user menu) clears it, calls the
  `signOut` action (cookies only, no redirect) and then does a full page load of `/login`, so no client state of the previous user
  survives. The nav voicemail badge store is keyed by user id (`components/app-shell/voicemail-count-store.ts`).
- Outcome sheet keys: `1`-`8` pick an outcome and move focus to it. Enter on an outcome button that is not selected selects it;
  Enter on the selected outcome, on Save & Next or in an input saves (`outcomeSheetEnterAction`).
- `logCall` sends an in-app or inbound call by `p_call_id` only (never with `p_lead_id`), so an id the caller may not
  log fails as `not_found` instead of falling back to inserting a TEL row. TEL calls send `p_call_id = clientRequestId`
  with `p_lead_id`.
- Next Lead: `/next?skip=<uuid,...>` (max 200, most recent kept) redirects to
  `/leads/<id>?flow=next&skip=<same>&reason=<VOICEMAIL|OVERDUE|DUE_TODAY|NEW|RETRY>`; the lead page renders
  `<NextLeadControls leadId>` when `flow=next`. Save & Next pushes `/next` with the current page's `skip`.
- Anything that changes the unheard voicemail count calls `notifyVoicemailsChanged()` (`lib/dialer/events.ts`) so the
  nav badge refetches immediately; otherwise it polls every 60s and on window focus.

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
  with `provider_call_sid is null` and `call_status is null`, and be created ≤10 min ago. `From` must equal `client:<calls.user_id>`.
  The user must be active with in-app calling enabled. The lead must still be assigned to that user
  (or the user is admin), and its status must not be DO_NOT_CONTACT. Other calls of that user created ≤ 2 h ago with a live
  `call_status` and a logged outcome are checked with `rest.fetchCallStatus`: still live or a failed lookup → failure TwiML; a final
  status is recorded with `apply_call_status` (D23). Then `claim_caller_id`. If there is no
  number, return failure TwiML. Otherwise claim the row atomically:
  `update … set provider_call_sid=CallSid, phone_number_id, call_status='queued' where id = … and provider_call_sid is null
  and call_status is null and outcome is null`. If no row was updated (superseded by a newer call, already claimed, or already
  logged), return failure TwiML. The `outcome is null` condition matters: `create_outbound_call` keeps rows whose outcome was
  logged, and its `call_in_progress` check ignores logged rows, so without it several logged-but-never-dialed rows could be
  dialed at once.
  Respond: `<Dial callerId="{e164}" timeout="30" answerOnBridge="true" action="{APP_BASE_URL}/api/twilio/voice/dial-complete"><Number statusCallback="{APP_BASE_URL}/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed">{lead.phone}</Number></Dial>`.
- `/status`: child-leg callbacks carry `ParentCallSid`, so look up by `ParentCallSid ?? CallSid` and call `apply_call_status`.
- `/dial-complete`: `DialCallStatus` and `DialCallDuration` go to `apply_call_status`. Respond with an empty `<Response/>`.
- Inbound (`/inbound`, or delegated): normalize `From`. The pure `decideInboundRoute(facts)` picks the target:
  1) matched lead (most recently contacted if duplicated) **with owner** → owner;
  2) matched lead without owner → admin-only voicemail;
  3) no match and `To` is an active number assigned to an agent → that agent;
  4) otherwise admin-only voicemail.
  Ring only if the target is active, has in-app calling enabled, `device_seen_at` ≤ 3 min old, and no
  in-progress call. Always insert an INBOUND row (lead_id when matched; `user_id` = target, or null for
  admin-only; `phone_number_id`; `remote_e164 = From`; `provider_call_sid = CallSid`).
  Ring: `<Dial timeout="20" answerOnBridge="true" action="…/inbound-dial-complete"><Client><Identity>{userId}</Identity><Parameter name="callId" value="{callId}"/></Client></Dial>`.
  Voicemail: `<Say>{settings.voicemail_greeting}</Say><Record maxLength="120" playBeep="true" action="…/voicemail-complete" recordingStatusCallback="…/recording-status" recordingStatusCallbackEvent="completed"/>`.
- `/inbound-dial-complete`: `DialCallStatus` completed → `<Response/>`. Anything else → voicemail TwiML. It also records
  `DialCallStatus`/`DialCallDuration` on the INBOUND row with `apply_call_status(CallSid, …)`. The inbound row is inserted
  without a `call_status`, so an unanswered or unreported inbound call never makes the agent "busy". A Twilio retry with the same
  `CallSid` reuses the existing INBOUND row.
- `/recording-status`: `record_voicemail(CallSid, RecordingSid, RecordingDuration)`.
- `/voicemail-complete`: `<Say>Thank you. Goodbye.</Say><Hangup/>`.
- `/api/voice/token`: requires an active session with in-app calling enabled. Rate limit with `consume_rate_limit('voice_token')` (20/10min, fixed in SQL).
  Returns 503 if Twilio isn't configured.
- All three browser POST routes resolve `getServerEnv()` **inside** their error handling, like `runTwilioWebhook` does: an invalid
  server environment answers 503 `{ error: 'unavailable' }`, never an unhandled 500 that skips the Origin check (D35).
- `/api/leads/export`: consumes `consume_rate_limit('export')` (30/10min) before streaming, → 429 `{ error: 'rate_limited' }` (D36). AccessToken `{identity: userId, ttl: 3600}` + VoiceGrant
  `{outgoingApplicationSid, incomingAllow: true}` → `{ token, identity, ttl }`.
- `/api/calls/outbound`: Zod `{leadId: uuid}`, then `create_outbound_call`, which enforces the `outbound_call` 12/min limit
  itself (`P0001 rate_limited` → 429). The route does not consume a separate hit.
- `/api/voicemail/[callId]`: uuid check, then session (`getUser()`, active), then
  `createAdminClient().rpc('get_voicemail_recording', { p_call_id, p_user_id: ctx.userId })`; if null → 404. The SID never
  leaves the server (D13). Fetch
  `https://api.twilio.com/2010-04-01/Accounts/{sid}/Recordings/{RecordingSid}.mp3` with API-key basic auth
  (forward `Range`) and stream back with `Cache-Control: private, no-store`. In mock/unconfigured mode,
  stream a generated short WAV tone so dev seed voicemails play.
- Twilio REST client and fetch are injected via deps so tests never hit the network.
- Code: signature/TwiML/token/routing/REST in `src/server/twilio/{signature,twiml,token,inbound-routing,rest,sids,log}.ts`;
  route cores in `src/server/http/voice.ts` (`handleVoiceToken`, `handleVoicePresence`, `handleCallsOutbound`),
  `src/server/http/voicemail.ts` (`handleVoicemail(req, callId, deps)`), `src/server/http/twilio/{outbound,inbound,callbacks}.ts`.
  Deps: `{ env, adminClient, rest, now }` (webhooks) / `{ env }` (browser POST routes), each defaulting to the real one.
- CSRF: the cookie-authenticated POST routes (`/api/voice/token`, `/api/voice/presence`, `/api/calls/outbound`) answer 403
  `{ error: 'forbidden' }` when an `Origin` header is present and is neither `APP_BASE_URL`'s origin nor the request's own origin.
- `/api/calls/outbound` bodies: an empty or non-JSON body → 400 `{ error: 'validation' }`. A JSON body that fails the schema (for example a
  malformed `leadId`) → 404 `{ error: 'not_found' }`, identical to an inaccessible id. Conflicts → 409 `{ error: 'conflict', reason }`.
- `/api/voicemail/[callId]` streams from Twilio when Twilio is configured and `DIALER_DRIVER` is not `mock`. Outside production it
  otherwise streams the WAV tone (8 kHz mono, 1.5 s, single `Range` supported). **In production the tone is never served**: an
  unconfigured production deployment answers 503 `{ error: 'unavailable' }`, so fabricated audio can never stand in for a real
  recording (D33). A stored SID must match `^RE[0-9a-fA-F]{32}$`, else 404.

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
- Calls against a daily target always derive from `dailyGoal()` (`lib/domain/daily-goal.ts`); a target of 0 is "no target" (D43).
- A state is never shown by color alone: the indeterminate checkbox shows a dash, the Skipped/attention items carry text, the
  consistency days show counts (D41, D43).

---

## 9. localbase contract

`startLocalbase({ port = 54321, dataDir?: string, silent? }) → { url, anonKey, serviceRoleKey, jwtSecret, stop() }`.
It boots PGlite (memory when no `dataDir`), loads `pg_trgm` + `pgcrypto`, runs `bootstrap.sql`, then applies
`supabase/migrations/*.sql` in order (tracked in `localbase.schema_migrations`).

**Kong-like gate:** every request needs an `apikey` header equal to the anon or service key (else 401).
The role comes from the verified `Authorization: Bearer` JWT (`role` claim ∈ anon/authenticated/service_role;
anything else → 401). As in PostgREST, a verified token without a `role` claim runs as `anon`, and an `authenticated`
token without `sub` runs with `auth.uid()` null.

**Per request:** `BEGIN; SET LOCAL ROLE <role>; select set_config('request.jwt.claims', $claims, true);`
run; `COMMIT` (or `ROLLBACK` on error). All work is serialized through one PGlite queue. **Never** run a
request's SQL as `postgres`.

**/rest/v1 (PostgREST subset):**
- `GET/HEAD/POST/PATCH/DELETE /rest/v1/:relation` on `public` tables/views only.
- `select=` columns with `alias:col`; `*` allowed; embeds are rejected (400 `PGRST100`).
- Filters `eq,neq,gt,gte,lt,lte,like,ilike,is(null|true|false),in.(…)`, `not.<op>`, `or=(…)`/`and=(…)`
  with nesting and quoted values. `order=col.asc|desc[.nullsfirst|.nullslast]`. `limit`, `offset`, `Range`.
- `Prefer: count=exact`, `return=representation|minimal`. `count=planned|estimated` → 400 `PGRST100`: PostgREST answers
  those from planner statistics of the whole table, which RLS does not scope, so the app uses only `count=exact` or an
  RPC's `total_count`. `Accept: application/vnd.pgrst.object+json`
  gives a single object or 406 `PGRST116`. `Content-Range` header.
- `POST /rest/v1/rpc/:fn` (named JSON args, looked up in `pg_proc`, each arg JSON→declared type in SQL).
  Returns set/table → JSON array, scalar/composite → JSON value, void → 204.
- Columns and functions are validated against the catalog. Values are always bound parameters.
- Errors use the PostgREST shape `{code,message,details,hint}` with PostgREST 12's HTTP status mapping
  (42501→403 for authenticated / 401 for anon, 23505/23503→409, 22P02/22023/23514/P0001→400, other P0xxx
  such as P0002→500, 25006→405, PGRST116→406). Unsupported syntax → 400, never silently ignored.

**/auth/v1 (GoTrue subset):** `POST /token?grant_type=password|refresh_token`, `GET/PUT /user`,
`POST /logout`, `GET /health`, `GET/POST /admin/users`, `GET/PUT/DELETE /admin/users/:id`
(`email_confirm`, `user_metadata`, `app_metadata`, `ban_duration` incl. `'none'`). bcrypt passwords
(bcryptjs). Banned users cannot sign in or refresh, and `/user` returns 403 `user_banned`. Access tokens
last 1h and carry Supabase claims (`aud, exp, iat, iss, sub, email, phone, app_metadata, user_metadata,
role:'authenticated', aal, amr, session_id, is_anonymous`). Signup (`POST /signup`) → 422
`signup_disabled`. `auth.users` and `auth.identities` columns mirror Supabase's so the same SQL works on both.

---

## Calendar booking (D46), the Google connection (D47) and a calendar per agent (D48)

Tables: `appointments` (lead, `booked_by`, 30-minute `starts_at`/`ends_at`, `status` pending|scheduled|cancelled,
`google_event_id`, `note` ≤ 500, `client_request_id`; unique index on `(booked_by, starts_at)` where live — D48: the
slot belongs to the agent who booked it, so two agents may hold one clock time and nobody holds two; RLS select:
booker or admin), `calendar_connection` (singleton, no API access — not even admin; `google_email`,
`refresh_token_ciphertext`, `app_calendar_id`, `connected_by`, `connected_at`, `broken_at`),
`profiles.google_calendar_id` (D48: that person's own secondary calendar on the connected account; null = not
provisioned, and booking is unavailable to them), and `bookable_hours` (D47: `weekday` 0-6,
`starts_minute`/`ends_minute` minutes from local midnight, both multiples of 30, `starts_minute < ends_minute`, no
overlap within a weekday; RLS select: any active user; seeded Mon-Fri 10:00-12:00 and 14:00-17:00, the shape the mock
calendar used). `leads.business_type` (enum, null = guess from name).

| RPC | Security | Who | Notes |
|---|---|---|---|
| `set_lead_business_type(p_lead_id, p_type)` | definer | active; admin any lead, agent own | null clears |
| `bulk_set_business_type(p_lead_ids, p_type)` | invoker | admin | 5,000 cap, `too_many_leads` |
| `begin_appointment(p_lead_id, p_starts_at, p_note, p_client_request_id)` | definer | active; lead access | replay, boundary, DNC, `book_appointment` 20/hour, stale-pending cleanup, `slot_taken` |
| `confirm_appointment(p_id, p_google_event_id)` | definer | booker | pending → scheduled, idempotent |
| `abandon_appointment(p_id)` | definer | booker | deletes own pending row |
| `cancel_appointment(p_id)` | definer | active; admin any, agent own | scheduled → cancelled. D48: an agent runs their own meetings, so an agent cancels their own; the Google event is then deleted from the calendar named by `booked_by`, not the caller's |
| `booked_intervals(p_from, p_to)` | definer | active | times only, range ≤ 31 days. D48: scoped to the caller, so another agent's meetings neither block a picker nor appear in it |
| `set_bookable_hours(p_rows)` | definer | admin | D47: replaces the whole week atomically; validates weekday/minute range, 30-minute granularity, ordering and overlap, else `invalid_hours` |
| `connect_calendar(p_email, p_ciphertext, p_app_calendar_id)` | definer | admin | D47: upserts the singleton, clears `broken_at` |
| `disconnect_calendar()` | definer | admin | D47: deletes the row |
| `mark_calendar_broken()` | definer | service role | D47: any active user's booking attempt can trigger the *call*, but the RPC itself is service-role only (grants are the guard, matching `revoke_user_sessions`) — an agent's own session cannot reach it directly; only ever sets `broken_at` |
| `get_calendar_status()` | definer | admin | returns `connected, google_email, hours_set, broken, app_calendar_id`, never the token. D47: `hours_set` now reflects whether any `bookable_hours` rows exist — previously a `bookable_calendar_id is not null` stand-in that was never populated |
| `set_agent_calendar_id(p_user_id, p_calendar_id)` | definer | service role | D48: stores one person's calendar id, refusing a deleted profile. Service-role only for `mark_calendar_broken`'s reasoning — an agent's own session must not create calendars on the owner's account as a side effect of booking |
| `clear_agent_calendars()` | definer | service role | D48: wipes every stored calendar id, called from the OAuth callback when the newly connected account cannot be proved to be the one those calendars were created on |

**Driver resolution** (`getCalendarDriver`, `src/server/env.ts`): an explicit `CALENDAR_DRIVER` wins; otherwise
`google` when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_ENCRYPTION_KEY` are all set (mirroring how
`DIALER_DRIVER` auto-detects `twilio` from the Twilio variables), else `mock` in development/test and `unavailable`
in production — a production deployment with no driver set and no Google configuration reports booking unavailable
rather than inventing availability. `CALENDAR_DRIVER=mock` with `NODE_ENV=production` is still refused at startup.
Whenever the driver resolves to `google` — `CALENDAR_DRIVER=google` explicit, or that auto-detect — `parseServerEnv`'s
`superRefine` additionally requires `APP_BASE_URL` (the OAuth redirect is built from it, exactly like Twilio's
webhook signature check) and validates `GOOGLE_TOKEN_ENCRYPTION_KEY` decodes to 32 bytes, mirroring the
`DIALER_DRIVER=twilio` checks; `isGoogleCalendarConfigured` includes `APP_BASE_URL` for the same reason
`isTwilioConfigured` does.

**Google modules (D47).** `src/server/google/http.ts` is the shared timeout+retry primitive both Google HTTP callers
use: an 8s timeout per attempt, one retry on a connection error or timeout only, never on an HTTP status Google
returned. `src/server/google/oauth.ts` is the PKCE authorization-code exchange and best-effort token revocation.
`src/server/google/api.ts` is every Calendar/OAuth2 REST call an access token can make (`accessTokenFor` refreshes
and caches an access token per refresh token in memory, `freeBusy`, `insertEvent`, `deleteEvent`,
`createAppCalendar`, `accountEmail`), and classifies every Google error as `invalid_grant` (access revoked — the
only kind that marks the connection broken), `transient` (429, 5xx, a rate-limit reason) or `permanent` (everything
else, `unauthorized_client` included: a bad or rotated client id/secret is not a revoked grant, and reconnecting
would not fix it). `src/server/google/crypto.ts` is AES-256-GCM for the refresh token, the only form it takes
outside memory. `src/server/calendar/google.ts` (`createGoogleCalendar`) implements `CalendarClient` against those
modules: `readAvailability` builds windows from `bookable_hours` and busy time from `freeBusy` on **the booking
agent's own calendar and nothing else** (D48 — the owner does not attend these meetings, so their primary calendar
is no longer read at all); `createMeeting` inserts a Meet-conferenced event with the booking agent as an attendee,
and the lead too when they have an email address; `cancelMeeting` deletes it. **It never creates a calendar
itself** — provisioning is `provisionAgentCalendar` (`src/server/services/calendar-connection.ts`), reached from
`createAgent`, the Settings card and the OAuth callback, never from a booking, and an agent with no calendar is
treated as booking-unavailable rather than triggering a lazy create (D47 amends the original design here — see
`docs/DEVIATIONS.md`).

`GET /api/google/callback` (`src/server/http/google-oauth.ts`) creates the connect-time calendar and stores its id
in `calendar_connection.app_calendar_id` in the same write that stores the connection. It creates one only when the
connection has none, or when the account being connected differs from the one already stored, so an ordinary
reconnect reuses the existing calendar while switching accounts starts a fresh one. D48: that calendar is also
assigned to the admin who connected (`set_agent_calendar_id`), since every meeting now goes to its own agent's
calendar and it would otherwise sit on the account empty; and unless the account is provably the same one as
before, `clear_agent_calendars` wipes every stored id first, because they name calendars the new token cannot
reach.

Environment: `CALENDAR_DRIVER` = `google` | `mock` (see driver resolution above); `mock` in production is refused at
startup. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) are
server-only and never `NEXT_PUBLIC_`. Code: `src/lib/domain/{business-type,lead-timezone,calendar-slots,business-rhythm,slot-phrase,meeting-description,bookable-hours}.ts`,
`src/server/calendar/*`, `src/server/google/*`, `src/server/http/google-oauth.ts`,
`src/server/services/{calendar-booking,calendar-connection}.ts`, `src/components/booking/*`,
`src/components/settings/{calendar-section,bookable-hours-form,agent-calendars-list}.tsx`.

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
- Helpers (`tests/helpers/`):
  - `global-setup.ts` (integration globalSetup): starts `startLocalbase({ port: 0 })` in memory, runs `seed()`,
    verifies the seeded row counts, and provides `supabaseUrl`, `supabaseAnonKey`, `supabaseServiceRoleKey`,
    `supabaseJwtSecret` (string | null), `supabaseStack` ('localbase' | 'external') and `seedCounts`
    (typed in `provided-context.d.ts`). Setting only some of the three `SUPABASE_TEST_*` vars is an error; an external
    stack must already be seeded (optional `SUPABASE_TEST_JWT_SECRET` enables `mintJwt`).
  - `env.ts`: `testStack()`, `isLocalbaseStack()`.
  - `clients.ts`: `anonClient()`, `serviceClient()`, `clientWithAccessToken(token)`,
    `signInAs(email, password = SEED_PASSWORD) → { client, userId, accessToken }`, `trySignIn()`, `mintJwt(claims, { secret?, expiresInSeconds? })`.
  - `seeded.ts`: `SEEDED_EMAILS`, `SEED_PASSWORD`, `seededUserId(key)`, `signInSeeded(key)`, `seededLeadId(ref)`,
    `seededLeadPhone(ref)`, `seededPhoneNumberId(key)`, `seededPhoneNumberE164(key)`.
  - `context.ts`: `contextFor(session) → RequestContext` (profile read through that session with `PROFILE_COLUMNS`) and
    `contextForUser(fixtureUser)` (signs in first), for calling services under RLS. Use these instead of per-folder copies.
  - `fixtures.ts`: `createUser({ role, active, timezone, inAppCallingEnabled, dailyCallTarget, name })`, `disableUser(id)`
    (profile inactive + Auth ban), `enableUser(id)`, `createLead`, `createCall`, `createFollowUp`, `createPhoneNumber`,
    `uniqueEmail`, `fictionalPhone` (per-worker partition of +1 NXX 555-01xx that avoids seed area codes), `fakeTwilioSid`.
  - `pglite.ts` (db project): `bootDb()`, `asUser(db, userId, fn)` / `asAnon` / `asService` (one transaction with
    `SET LOCAL ROLE` + claims), `userRows` / `anonRows` / `serviceRows` / `adminSqlRows`, `pgError(promise) → {code, message}`,
    `createAuthUser(db, { email, name, role, active, timezone, inAppCallingEnabled, dailyCallTarget })`, `insertRow`,
    `createLeadRow`, `createCallRow`, `createFollowUpRow`, `createPhoneNumberRow`, `nextPhone`.
  - PGlite does not serialize JS arrays for enum-array parameters: pass `$1::text[]::public.lead_status[]`.
- Seed users (password for all: `McQueen-dev-2026`):
  `admin@funnelmcqueen.test` (ADMIN, "Velo Admin"), `alex@funnelmcqueen.test` ("Alex Rivera", America/New_York),
  `blair@funnelmcqueen.test` ("Blair Chen", America/Chicago), `casey@funnelmcqueen.test`
  ("Casey Morgan", America/Los_Angeles), `dana@funnelmcqueen.test` ("Dana Brooks", **disabled** + banned).
- Fictional phones only: `+1 NXX 555-0100…0199`. Seed Twilio numbers: `+14155550150` (Alex),
  `+14155550151` (Blair), `+14155550152` (pool).
- Twilio webhook tests sign with `twilio.getExpectedTwilioSignature(testToken, url, params)`.
- Playwright: `channel: 'chrome'`, five projects — `mobile` (iPhone-sized viewport + iOS UA → tel:),
  `desktop`, `journey` (`voicemail-callback.spec.ts`, `dependencies: ['desktop']`), `import` and `workspace` — with
  `DIALER_DRIVER=mock`. A spec whose name matches no `testMatch` never runs and Playwright says nothing,
  so add new specs to a project deliberately. `tests/unit/docs/docs-drift.test.ts` fails when this list,
  the README or `docs/PLAN.md` falls behind `playwright.config.ts`.
  - Every spec shares one seeded database (`workers: 1`), so each spec owns a seeded user and only
    writes to that user's rows: Casey (mobile core loop, sign-out), Blair (desktop core loop), Alex
    (isolation, export, call mode, and the pipeline/follow-up writes), the admin (agents, import).
  - `import` runs `admin-import.spec.ts` alone. It inserts 97 leads, which would break every spec that
    asserts a seeded total (isolation's "45 leads in total", the agent export), so it declares
    `dependencies: ['mobile', 'desktop', 'journey']` to run last whatever the file order, and `retries: 0`
    because a second attempt would import into the database the first attempt already changed.
  - `workspace` runs `workspace-*.spec.ts` after `import` (`dependencies: ['import']`, `retries: 0`): bulk lead actions change
    only leads the import created (sources "Trade Show" and "LinkedIn" exist only in `samples/leads.csv`), and the Skipped queue
    spec resumes the lead it skips (Casey).
  - A spec that creates rows which outlive it (a new agent) uses a unique email, so re-running the
    suite against a fresh seed never collides. Specs assert only what they own, never global counts
    they do not control.
  - `pipeline-followups.spec.ts` runs in `desktop` and switches one `describe` to a phone viewport with
    `test.use`, because that flow has to work with both a drag and the "Move to…" menu.
