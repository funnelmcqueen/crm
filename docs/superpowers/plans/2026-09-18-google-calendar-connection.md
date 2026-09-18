# Google Calendar connection — implementation plan (milestone 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Book into the closer's real Google Calendar — bookable hours set in the CRM, busy time read from Google free/busy, meetings written to an app-created calendar with a Meet link and the lead invited, and cancelling in the CRM cancelling in Google.

**Architecture:** Milestone 1's slot engine, ranking, phrasing, panel and RPCs are untouched. A `GoogleCalendarClient` implements the existing `CalendarClient` interface; windows come from a new `bookable_hours` table instead of a calendar, and busy times from `freebusy.query`. An admin connects the account once through an OAuth round trip; only an encrypted refresh token is stored.

**Tech Stack:** Next.js 16 App Router (route handlers, server actions), TypeScript strict, Supabase Postgres (RLS + guarded SECURITY DEFINER RPCs), PGlite localbase, Vitest (unit/db/integration), Playwright, Zod v4, date-fns 4 + `@date-fns/tz`, node:crypto, shadcn/Radix, sonner.

**Design:** `docs/superpowers/specs/2026-09-18-google-calendar-connection-design.md`. Read §3 (scopes) and §4 (hours) before starting.

## Global Constraints

- Work only in the worktree `.worktrees/google-calendar` (branch `google-calendar`, forked from `calendar-booking`). Never touch the main checkout.
- New migration file: `supabase/migrations/20260915002000_google_calendar.sql`. Never edit an earlier migration.
- Scopes, exactly: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.freebusy`, `https://www.googleapis.com/auth/calendar.app.created`. No broader scope without the human's ruling.
- No Google event title, description or attendee may ever be serialized to an agent's browser. The app never calls `events.list` or `events.get`.
- The refresh token is stored only as AES-256-GCM ciphertext; access tokens live in memory only. No token, ciphertext or client secret may reach a log, a cookie, an error message or the browser.
- Environment variables, server-only, never `NEXT_PUBLIC_`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 bytes, base64).
- Bookable hours: minutes from local midnight, both multiples of 30, `0 <= starts < ends <= 1440`, no overlap within a weekday, weekday 0 = Sunday. Interpreted in `settings.default_timezone`.
- Slot length stays 30 minutes, slot starts stay UTC multiples of 30 minutes, intervals stay half-open `[start, end)`, horizon 14 days, notice 120 minutes, availability cache 60 seconds.
- Every Google HTTP call: 8-second timeout, one retry on a connection error only, never on a 4xx.
- Every SQL function: `set search_path = ''`, fully qualified names, `revoke execute ... from public, anon`, then explicit grants; every new table enables RLS.
- `CALENDAR_DRIVER=mock` with `NODE_ENV=production` stays refused at startup.
- The deviation for this milestone is **D47** (D45 is the pep-talk branch, D46 milestone 1).
- No test may reach the network. Google's HTTP surface is stubbed at the `fetch` layer.
- LF line endings; forward slashes in paths and scripts.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260915002000_google_calendar.sql` | `bookable_hours`, connection columns, `set_bookable_hours`, `connect_calendar`, `disconnect_calendar`, `mark_calendar_broken`, new `get_calendar_status` |
| `src/lib/domain/bookable-hours.ts` | Hours rows → windows for a date range in a time zone; validation shared with the UI |
| `src/server/google/crypto.ts` | AES-256-GCM encrypt/decrypt of the refresh token |
| `src/server/google/api.ts` | Google HTTP: access token, free/busy, event insert/delete, calendar create, userinfo; timeout, retry, error classification |
| `src/server/google/oauth.ts` | Consent URL, PKCE, state, code exchange, revoke |
| `src/server/calendar/google.ts` | `GoogleCalendarClient` implementing `CalendarClient` |
| `src/server/calendar/client.ts` (modify) | Resolve the Google client when the driver is `google` |
| `src/server/env.ts` (modify) | `GOOGLE_*` variables, driver auto-detect |
| `src/server/http/google-oauth.ts` | Route handlers for start and callback |
| `src/app/api/google/start/route.ts`, `src/app/api/google/callback/route.ts` | Thin route files |
| `src/server/services/calendar-connection.ts` | Connection status, hours read/save, disconnect |
| `src/server/actions/calendar-connection.ts` | Server actions for the above |
| `src/server/services/calendar-booking.ts` (modify) | Mark broken on `invalid_grant`; cancel deletes the Google event |
| `src/components/settings/calendar-section.tsx`, `src/components/settings/bookable-hours-form.tsx` | Settings card and hours editor |
| `src/app/(app)/settings/page.tsx` (modify) | Render the card for admins |
| `docs/DEVIATIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/RUNBOOK.md`, `.env.example` (modify) | Docs |

## Before you start

- [ ] **Install dependencies in the worktree** (already done by the controller if `node_modules` exists):

```bash
cd .worktrees/google-calendar && npm ci
```

Then confirm the baseline is green: `npm run typecheck && npx vitest run --project unit`.

---

### Task 1: Hours and connection in the database

**Files:**
- Create: `supabase/migrations/20260915002000_google_calendar.sql`
- Create: `tests/db/google-calendar.test.ts`
- Modify: `src/lib/database.types.ts`, `tests/db/grants.test.ts`, `tests/db/schema-contract.test.ts`

**Interfaces:**
- Produces: table `public.bookable_hours (id uuid, weekday smallint, starts_minute int, ends_minute int)`; `set_bookable_hours(p_rows jsonb)`; `connect_calendar(p_email text, p_ciphertext text, p_app_calendar_id text)`; `disconnect_calendar()`; `mark_calendar_broken()`; `get_calendar_status()` now returning `(connected boolean, google_email text, hours_set boolean, broken boolean, app_calendar_id text)`.
- Consumes: `public.is_admin()`, `public.is_active_user()` from earlier migrations.

- [ ] **Step 1: Write the failing database test** — `tests/db/google-calendar.test.ts`. Model it on `tests/db/calendar-booking.test.ts` (same helpers: `bootDb`, `adminSqlRows`, `anonRows`, `userRows`, `createAuthUser`, `pgError`). Cover exactly:

1. the migration seeds Monday–Friday 10:00–12:00 and 14:00–17:00, i.e. 10 rows, `select count(*) from public.bookable_hours` = 10, and every row has `starts_minute % 30 = 0` and `ends_minute % 30 = 0`;
2. `set_bookable_hours` as an agent raises `42501`, and as `anon` raises `42501`;
3. `set_bookable_hours` as admin with `[{"weekday":1,"starts_minute":540,"ends_minute":660}]` replaces the whole week: afterwards exactly one row exists;
4. each invalid input raises `invalid_hours` (`P0001`) and changes nothing: weekday 7, `starts_minute` 545 (not a multiple of 30), `ends_minute` 1500, `starts_minute >= ends_minute`, and two overlapping ranges on one weekday (`[{"weekday":2,"starts_minute":540,"ends_minute":660},{"weekday":2,"starts_minute":600,"ends_minute":720}]`);
5. two ranges on one weekday that only touch (`540–660` and `660–780`) are accepted;
6. `connect_calendar('a@b.test','cipher','cal-1')` as agent raises `42501`; as admin it inserts the singleton, and calling it again updates in place (still one row) and clears `broken_at`;
7. `mark_calendar_broken()` sets `broken_at`, and `get_calendar_status()` then returns `broken = true`, `connected = true`, `google_email = 'a@b.test'`, `hours_set = true`, `app_calendar_id = 'cal-1'`;
8. `get_calendar_status()` as an agent raises `42501`, and with no connection row returns `connected = false` with a null email;
9. `disconnect_calendar()` as admin removes the row; `get_calendar_status()` then returns `connected = false`;
10. no API role can read the ciphertext: `anonRows('select * from public.calendar_connection')` and the same as an authenticated agent both fail, and `select refresh_token_ciphertext from public.calendar_connection` through `get_calendar_status` is impossible by construction (assert the returned column list).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project db tests/db/google-calendar.test.ts`
Expected: FAIL — `relation "public.bookable_hours" does not exist`.

- [ ] **Step 3: Write the migration** — `supabase/migrations/20260915002000_google_calendar.sql`:

```sql
-- Google Calendar connection (docs/DEVIATIONS.md D47,
-- docs/superpowers/specs/2026-09-18-google-calendar-connection-design.md).

-- ---------------------------------------------------------------------------------------------
-- 1. Bookable hours, set in the CRM and read in settings.default_timezone
-- ---------------------------------------------------------------------------------------------
create table public.bookable_hours (
  id uuid primary key default gen_random_uuid(),
  weekday smallint not null constraint bookable_hours_weekday_range check (weekday between 0 and 6),
  starts_minute integer not null
    constraint bookable_hours_starts_range check (starts_minute between 0 and 1410)
    constraint bookable_hours_starts_granularity check (starts_minute % 30 = 0),
  ends_minute integer not null
    constraint bookable_hours_ends_range check (ends_minute between 30 and 1440)
    constraint bookable_hours_ends_granularity check (ends_minute % 30 = 0),
  constraint bookable_hours_order check (starts_minute < ends_minute)
);

alter table public.bookable_hours enable row level security;

-- Every active user may read them: the booking panel needs the windows. Writes go through the RPC.
create policy bookable_hours_select on public.bookable_hours
  for select to authenticated
  using (public.is_active_user());

grant select on public.bookable_hours to authenticated;

insert into public.bookable_hours (weekday, starts_minute, ends_minute)
select d, s.starts_minute, s.ends_minute
  from generate_series(1, 5) as d,
       (values (600, 720), (840, 1020)) as s(starts_minute, ends_minute);

-- Replaces the whole week atomically. p_rows: [{"weekday":1,"starts_minute":600,"ends_minute":720}, ...]
create or replace function public.set_bookable_hours(p_rows jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  create temporary table tmp_hours on commit drop as
  select (r ->> 'weekday')::smallint as weekday,
         (r ->> 'starts_minute')::integer as starts_minute,
         (r ->> 'ends_minute')::integer as ends_minute
    from jsonb_array_elements(p_rows) as r;

  select count(*) into v_count
    from tmp_hours t
   where t.weekday is null or t.weekday < 0 or t.weekday > 6
      or t.starts_minute is null or t.ends_minute is null
      or t.starts_minute < 0 or t.ends_minute > 1440
      or t.starts_minute >= t.ends_minute
      or t.starts_minute % 30 <> 0 or t.ends_minute % 30 <> 0;
  if v_count > 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  select count(*) into v_count
    from tmp_hours a
    join tmp_hours b
      on a.weekday = b.weekday
     and a.ctid <> b.ctid
     and a.starts_minute < b.ends_minute
     and b.starts_minute < a.ends_minute;
  if v_count > 0 then
    raise exception 'invalid_hours' using errcode = 'P0001';
  end if;

  delete from public.bookable_hours;
  insert into public.bookable_hours (weekday, starts_minute, ends_minute)
  select t.weekday, t.starts_minute, t.ends_minute from tmp_hours t;
end;
$$;
revoke execute on function public.set_bookable_hours(jsonb) from public, anon;
grant execute on function public.set_bookable_hours(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The connection: the app's own calendar replaces milestone 1's bookable calendar
-- ---------------------------------------------------------------------------------------------
alter table public.calendar_connection rename column bookable_calendar_id to app_calendar_id;

create or replace function public.connect_calendar(p_email text, p_ciphertext text, p_app_calendar_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_email), '') = '' or coalesce(btrim(p_ciphertext), '') = '' then
    raise exception 'invalid_connection' using errcode = 'P0001';
  end if;

  insert into public.calendar_connection (id, google_email, refresh_token_ciphertext, app_calendar_id, connected_by, connected_at, broken_at)
  values (true, btrim(p_email), p_ciphertext, nullif(btrim(p_app_calendar_id), ''), auth.uid(), now(), null)
  on conflict (id) do update
     set google_email = excluded.google_email,
         refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         app_calendar_id = excluded.app_calendar_id,
         connected_by = excluded.connected_by,
         connected_at = excluded.connected_at,
         broken_at = null;
end;
$$;
revoke execute on function public.connect_calendar(text, text, text) from public, anon;
grant execute on function public.connect_calendar(text, text, text) to authenticated, service_role;

create or replace function public.disconnect_calendar()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.calendar_connection;
end;
$$;
revoke execute on function public.disconnect_calendar() from public, anon;
grant execute on function public.disconnect_calendar() to authenticated, service_role;

-- Called by the server when Google refuses the refresh token. Any active user's booking attempt can
-- discover it, so this is not admin-only; it only ever sets a flag.
create or replace function public.mark_calendar_broken()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.calendar_connection set broken_at = now() where broken_at is null;
end;
$$;
revoke execute on function public.mark_calendar_broken() from public, anon;
grant execute on function public.mark_calendar_broken() to authenticated, service_role;

-- Replaces milestone 1's version: reports the hours and the app calendar, never the token.
drop function if exists public.get_calendar_status();
create or replace function public.get_calendar_status()
returns table (connected boolean, google_email text, hours_set boolean, broken boolean, app_calendar_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select true, c.google_email, exists (select 1 from public.bookable_hours), c.broken_at is not null, c.app_calendar_id
      from public.calendar_connection c
    union all
    select false, null::text, exists (select 1 from public.bookable_hours), false, null::text
     where not exists (select 1 from public.calendar_connection);
end;
$$;
revoke execute on function public.get_calendar_status() from public, anon;
grant execute on function public.get_calendar_status() to authenticated, service_role;
```

- [ ] **Step 4: Regenerate types and update the contract tests**

Run: `npm run db:types`
Then add to `tests/db/grants.test.ts` the five new functions (`set_bookable_hours`, `connect_calendar`, `disconnect_calendar`, `mark_calendar_broken`, and the replaced `get_calendar_status` signature) and the `bookable_hours` table in the same shape as the existing entries, and add `bookable_hours` to `tests/db/schema-contract.test.ts` beside `appointments`. Follow whatever those files' existing entries look like — read them first; if an entry's shape differs from what you expect, match the file, not this plan.

- [ ] **Step 5: Run the database tests**

Run: `npx vitest run --project db`
Expected: PASS, including the milestone 1 suites (`get_calendar_status`'s columns changed, so fix any milestone 1 assertion that named the old `bookable_calendar_set` column — the change is deliberate).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260915002000_google_calendar.sql tests/db src/lib/database.types.ts
git commit -m "feat(db): bookable hours and a guarded Google connection" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Bookable hours to windows

**Files:**
- Create: `src/lib/domain/bookable-hours.ts`
- Test: `tests/unit/domain/bookable-hours.test.ts`

**Interfaces:**
- Consumes: `Interval` from `src/lib/domain/calendar-slots.ts`; `TZDate` from `@date-fns/tz` (see `src/lib/domain/time.ts` for the pattern already used in this codebase).
- Produces:
  - `interface BookableRange { weekday: number; startsMinute: number; endsMinute: number }`
  - `HOURS_GRANULARITY_MINUTES = 30`
  - `bookableWindows(ranges: readonly BookableRange[], timeZone: string, from: Date, to: Date): Interval[]` — every range materialised for each local day the `[from, to)` span touches, clipped to `[from, to)`, sorted by start, skipping empty results.
  - `validateBookableRanges(ranges: readonly BookableRange[]): string | null` — the same rules the RPC enforces, returning a human-readable message for the first problem or `null` when valid. Messages, exactly: `"Times must be on the hour or the half hour."`, `"A start time must come before its end time."`, `"Times must be between 00:00 and 24:00."`, `"Two ranges on the same day overlap."`
  - `formatMinutes(minute: number): string` — `"10:00"`, `"14:30"`, `"24:00"`.

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/bookable-hours.test.ts`. Cover:

1. a Monday-only range 10:00–12:00 in `America/New_York` over a `from`/`to` spanning one week yields exactly one window, starting at the instant that is 10:00 local that Monday (assert the ISO string);
2. two ranges on the same weekday yield two windows in start order;
3. a window is clipped when `from` falls inside it (start becomes `from`), and dropped when it ends before `from`;
4. **daylight saving:** ranges 10:00–12:00 on the Saturday and Sunday of the US spring-forward weekend (2027-03-13/14) both start at 10:00 local — that is 15:00Z on the Saturday and 14:00Z on the Sunday. This is the test that proves the local-time interpretation;
5. an empty ranges array yields no windows;
6. `validateBookableRanges` returns `null` for touching ranges (`540–660`, `660–780`) and each exact message above for: 545 minutes, `starts >= ends`, `ends 1500`, and an overlap;
7. `formatMinutes(0) === "00:00"`, `formatMinutes(870) === "14:30"`, `formatMinutes(1440) === "24:00"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/bookable-hours.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/domain/bookable-hours.ts`. Requirements, in the codebase's existing style (pure module, no I/O, a header comment naming `docs/DEVIATIONS.md D47`):

- Walk local calendar days from the day containing `from` in `timeZone` up to the day containing `to`, inclusive. For each day, take every range whose `weekday` matches that local day's weekday, and turn `startsMinute`/`endsMinute` into instants with `TZDate` — construct the local midnight for that day in the zone and add the minutes, the same way `src/lib/domain/time.ts` builds zoned instants; do not add milliseconds to a UTC midnight, which breaks across a DST boundary.
- Clip each window to `[from, to)`; drop it when the clipped span is empty.
- Sort by start; do not merge (the slot engine merges busy, not windows).
- `validateBookableRanges` checks, in this order: granularity, ordering, bounds, overlap — returning the first failure's message.

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project unit tests/unit/domain/bookable-hours.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/bookable-hours.ts tests/unit/domain/bookable-hours.test.ts
git commit -m "feat: turn the CRM's bookable hours into calendar windows" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Encryption and the Google environment

**Files:**
- Create: `src/server/google/crypto.ts`
- Modify: `src/server/env.ts`
- Test: `tests/unit/google/crypto.test.ts`, `tests/unit/env/calendar-driver.test.ts` (extend the existing driver test file if one exists — search `tests/unit` for `getCalendarDriver` first and add to that file instead of creating a second one)

**Interfaces:**
- Produces:
  - `encryptRefreshToken(plain: string, key?: string): string` and `decryptRefreshToken(payload: string, key?: string): string` — AES-256-GCM, output `v1.<iv-base64>.<tag-base64>.<ciphertext-base64>`; `key` defaults to `GOOGLE_TOKEN_ENCRYPTION_KEY` from the server env.
  - In `src/server/env.ts`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` on `ServerEnv`; `isGoogleCalendarConfigured(env?: ServerEnv): boolean` (all three present and non-blank); `getCalendarDriver` gains the auto-detect branch below.

- [ ] **Step 1: Write the failing tests**

`tests/unit/google/crypto.test.ts`:
1. a round trip returns the original string, for an ASCII token and for one with non-ASCII characters;
2. two encryptions of the same plaintext differ (random IV) and both decrypt back;
3. decrypting with a different key throws, and the thrown message contains neither the plaintext nor either key;
4. a payload with a flipped byte in the ciphertext throws (GCM authentication), as does one with a wrong prefix or too few parts;
5. a key that is not 32 bytes when base64-decoded throws a clear configuration error.

Driver test additions:
6. `getCalendarDriver` returns `"google"` when `CALENDAR_DRIVER` is unset and all three `GOOGLE_*` variables are present, in production and outside it;
7. with `CALENDAR_DRIVER` unset and the Google variables absent, the milestone 1 behaviour is unchanged: `"mock"` outside production, `"unavailable"` in production;
8. an explicit `CALENDAR_DRIVER` still wins over auto-detection, and `mock` in production is still refused at startup.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/unit/google tests/unit/env`
Expected: FAIL.

- [ ] **Step 3: Implement the crypto module** — `src/server/google/crypto.ts`:

```ts
// AES-256-GCM for the Google refresh token (docs/DEVIATIONS.md D47). The ciphertext is the only form the
// token takes outside memory; the key never leaves the server environment.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getServerEnv } from "@/server/env";

const VERSION = "v1";
const IV_BYTES = 12;

function keyBytes(key: string | undefined): Buffer {
  const raw = key ?? getServerEnv().GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not set");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return bytes;
}

export function encryptRefreshToken(plain: string, key?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptRefreshToken(payload: string, key?: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("stored calendar token is not readable");
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("stored calendar token is not readable");
  }
}
```

- [ ] **Step 4: Extend the environment** — in `src/server/env.ts`, following exactly how the Twilio variables and `DIALER_DRIVER` are declared:

- add the three `GOOGLE_*` variables as optional trimmed strings to the schema and to `readProcessEnv`;
- add `isGoogleCalendarConfigured(env)`, mirroring the existing `isTwilioConfigured`;
- in `getCalendarDriver`, when `CALENDAR_DRIVER` is unset: return `"google"` if `isGoogleCalendarConfigured(env)`, otherwise keep milestone 1's behaviour (`"mock"` outside production, `"unavailable"` in production). An explicit value still wins, and the `mock` + production refusal in `superRefine` is untouched.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run --project unit` (the whole unit project — the env schema is widely used)
Expected: PASS.

```bash
git add src/server/google/crypto.ts src/server/env.ts tests/unit
git commit -m "feat: encrypt the Google refresh token and resolve the driver from the Google config" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The Google HTTP layer

**Files:**
- Create: `src/server/google/api.ts`
- Test: `tests/unit/google/api.test.ts`

**Interfaces:**
- Produces:
  - `interface GoogleTokens { accessToken: string; expiresAt: number }`
  - `class GoogleApiError extends Error { kind: "invalid_grant" | "transient" | "permanent"; status: number; reason: string }`
  - `accessTokenFor(refreshToken: string, now?: () => number): Promise<string>` — refreshes, caches per refresh token in a module map until 60 seconds before expiry.
  - `freeBusy(accessToken: string, calendarIds: readonly string[], from: Date, to: Date): Promise<Array<{ start: Date; end: Date }>>`
  - `insertEvent(accessToken: string, calendarId: string, event: GoogleEventInput): Promise<{ id: string }>` where `GoogleEventInput` is `{ summary; description; start: Date; end: Date; timeZone: string; attendeeEmail: string | null; conferenceRequestId: string }`
  - `deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>` — treats 404 and 410 as success.
  - `createAppCalendar(accessToken: string, summary: string, timeZone: string): Promise<{ id: string }>`
  - `accountEmail(accessToken: string): Promise<string>`
  - `GOOGLE_TIMEOUT_MS = 8000`
- Consumes: nothing from the CRM except `GoogleApiError`; the module takes an access token and never reads the database.

- [ ] **Step 1: Write the failing test** — `tests/unit/google/api.test.ts`. Stub `globalThis.fetch` with `vi.fn()` (restore it in `afterEach`); assert on the request the code makes as well as on what it returns. Cover:

1. `accessTokenFor` posts form-encoded `grant_type=refresh_token` with the client id and secret to `https://oauth2.googleapis.com/token`, returns the `access_token`, and a second call within the expiry window makes no further request; after the cached expiry, it requests again;
2. a token response of `{"error":"invalid_grant"}` with status 400 throws `GoogleApiError` with `kind === "invalid_grant"`;
3. a 503 throws `kind === "transient"`; a 403 with reason `rateLimitExceeded` is `"transient"`; a 403 with reason `insufficientPermissions` is `"permanent"`;
4. `freeBusy` posts `{ timeMin, timeMax, items: [{ id }] }` to the free/busy endpoint and maps every calendar's `busy` entries into `Date` pairs, merged across calendars in start order; a calendar whose entry carries an `errors` array is reported as a `GoogleApiError` (kind `permanent`);
5. `insertEvent` posts to `/calendars/{id}/events` with `conferenceDataVersion=1` and `sendUpdates=all` in the query, a body containing `conferenceData.createRequest.requestId` equal to the passed id and `conferenceData.createRequest.conferenceSolutionKey.type === "hangoutsMeet"`, `attendees` present only when an email was given, and `start.dateTime`/`end.dateTime` with the given `timeZone`; it returns the created id;
6. `deleteEvent` returns normally on 204, on 404 and on 410, and throws on 500;
7. every call aborts after `GOOGLE_TIMEOUT_MS` (drive it with fake timers and an unresolved fetch) and throws `kind === "transient"`;
8. a connection error (fetch rejects with a `TypeError`) is retried exactly once, and a 400 is never retried;
9. no function ever logs or returns a request body containing the client secret or the refresh token — assert by spying on `console.error` and checking the thrown messages.

- [ ] **Step 2: Run it to verify it fails, then implement** — `src/server/google/api.ts`:

- one private `request()` helper doing: `AbortSignal.timeout(GOOGLE_TIMEOUT_MS)`, JSON parsing, and error classification into `GoogleApiError` (`invalid_grant` when the body's `error` is `invalid_grant` or `unauthorized_client`; `transient` for 429, 5xx, a timeout, a connection error and 403 `rateLimitExceeded`/`userRateLimitExceeded`; `permanent` otherwise). Retry once only for a connection error or a timeout.
- the token cache is a module-level `Map<string, GoogleTokens>` keyed by the refresh token, cleared for a key when Google rejects it.
- `insertEvent` sends: `summary`, `description`, `start`/`end` as `{ dateTime, timeZone }`, `attendees` (one entry, `{ email }`) when given, `conferenceData.createRequest` with `requestId` and `conferenceSolutionKey: { type: "hangoutsMeet" }`, and query `conferenceDataVersion=1&sendUpdates=all`.
- `createAppCalendar` posts `{ summary, timeZone }` to `/calendars`.
- `accountEmail` reads `https://www.googleapis.com/oauth2/v3/userinfo` and returns `email`.
- Never log a token, a secret or a ciphertext; error messages carry status and reason only.

- [ ] **Step 3: Run the tests and commit**

Run: `npx vitest run --project unit tests/unit/google`
Expected: PASS, output pristine.

```bash
git add src/server/google/api.ts tests/unit/google/api.test.ts
git commit -m "feat: Google Calendar HTTP layer with timeouts and classified failures" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The Google calendar client

**Files:**
- Create: `src/server/calendar/google.ts`
- Modify: `src/server/calendar/client.ts`
- Test: `tests/unit/calendar/google-calendar.test.ts`

**Interfaces:**
- Consumes: `CalendarClient`, `CalendarAvailability`, `CalendarInterval` from `src/server/calendar/types.ts`; `bookableWindows` (Task 2); `accessTokenFor`, `freeBusy`, `insertEvent`, `deleteEvent`, `GoogleApiError` (Task 4); `decryptRefreshToken` (Task 3).
- Produces:
  - `interface GoogleCalendarConnection { refreshTokenCiphertext: string; googleEmail: string; appCalendarId: string | null }`
  - `interface GoogleCalendarDeps { connection: GoogleCalendarConnection; ranges: readonly BookableRange[]; timeZone: string; onInvalidGrant: () => Promise<void>; ensureAppCalendar: (id: string) => Promise<void> }`
  - `createGoogleCalendar(deps: GoogleCalendarDeps): CalendarClient & { cancelMeeting(eventId: string): Promise<void> }`
  - In `client.ts`: `resolveCalendarClient` keeps its signature, and gains an optional second path for the `google` driver — it is given an already-loaded connection and ranges by the service (the resolver must not query the database itself; `src/server/services/calendar-connection.ts` in Task 6 does that and passes them in). Add `resolveGoogleCalendar(deps: GoogleCalendarDeps): CalendarClient` and leave the mock path untouched.

- [ ] **Step 1: Write the failing test** — `tests/unit/calendar/google-calendar.test.ts`, stubbing the Task 4 module with `vi.mock("@/server/google/api", …)` so no HTTP happens. Cover:

1. `readAvailability` returns windows built from the ranges (assert one exact ISO start) and busy intervals exactly as `freeBusy` returned them, with **no other fields** on either — assert `Object.keys(busy[0])` is exactly `["start", "end"]`;
2. it queries free/busy for both the account email and the app calendar id, and for the app calendar id only when it is set;
3. `createMeeting` calls `insertEvent` with the app calendar id, the title and description it was given, the closer's time zone, and the attendee only when the input carries a lead email; it returns the event id;
4. when the connection has no app calendar id, `createMeeting` calls `ensureAppCalendar` first and uses the id that comes back;
5. a `GoogleApiError` with `kind === "invalid_grant"` from any call invokes `onInvalidGrant()` once and then rethrows;
6. a `transient` error is rethrown without calling `onInvalidGrant`;
7. `cancelMeeting` delegates to `deleteEvent` with the app calendar id.

- [ ] **Step 2: Implement.** The client decrypts the refresh token once per call chain, gets an access token through `accessTokenFor`, and maps errors as above. It never constructs windows itself — `bookableWindows` does that — and it never reads or returns anything from Google beyond busy times and the created event id.

- [ ] **Step 3: Run the tests and commit**

Run: `npx vitest run --project unit tests/unit/calendar`
Expected: PASS.

```bash
git add src/server/calendar/google.ts src/server/calendar/client.ts tests/unit/calendar/google-calendar.test.ts
git commit -m "feat: a Google calendar client behind the existing interface" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Connecting the account

**Files:**
- Create: `src/server/google/oauth.ts`, `src/server/http/google-oauth.ts`, `src/app/api/google/start/route.ts`, `src/app/api/google/callback/route.ts`
- Test: `tests/integration/google/oauth.test.ts`

**Interfaces:**
- Consumes: `getRouteContext`, `requireAdmin` from `src/server/context.ts` (read how `src/server/http/voice.ts` uses them and follow it); `encryptRefreshToken` (Task 3); `accountEmail`, `createAppCalendar`, `GoogleApiError` (Task 4); the `connect_calendar` RPC (Task 1).
- Produces in `src/server/google/oauth.ts`:
  - `GOOGLE_SCOPES: readonly string[]` — exactly `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/calendar.freebusy`, `https://www.googleapis.com/auth/calendar.app.created`
  - `consentUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string`
  - `newPkcePair(): { verifier: string; challenge: string }` — S256
  - `exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string }>`
  - `revokeToken(refreshToken: string): Promise<void>` — best effort, never throws
- Produces in `src/server/http/google-oauth.ts`: `handleGoogleStart(req: Request): Promise<Response>`, `handleGoogleCallback(req: Request): Promise<Response>`

- [ ] **Step 1: Write the failing integration test** — `tests/integration/google/oauth.test.ts`, stubbing `globalThis.fetch` for Google's endpoints and using the integration project's session helpers (`tests/helpers/context.ts`, `tests/helpers/fixtures.ts`, as `tests/integration/calendar/*.test.ts` does). Cover:

1. an agent calling `handleGoogleStart` gets a 403 or a redirect to a refusal — whichever the codebase's other admin-only routes do (match `src/server/http/leads-export.ts`); nothing is written;
2. an admin gets a 302 whose `Location` is Google's consent URL carrying `client_id`, the redirect URI, `response_type=code`, `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, a `code_challenge`, a `state`, and exactly the four scopes — and a `Set-Cookie` holding the state and verifier, `HttpOnly`, `SameSite=Lax`, `Secure` outside development, short `Max-Age`;
3. the callback with a `state` that does not match the cookie writes nothing and redirects to `/settings?calendar=error`;
4. the callback with `error=access_denied` redirects to `/settings?calendar=denied` and writes nothing;
5. a happy callback exchanges the code, creates the app calendar, stores the connection, and redirects to `/settings?calendar=connected`; afterwards `get_calendar_status()` reports connected with that email, and the stored `refresh_token_ciphertext` is **not** the raw token (assert it does not contain the token string and that `decryptRefreshToken` returns it);
6. a callback whose token response has no `refresh_token` redirects to `/settings?calendar=error` and writes nothing;
7. the state cookie is cleared by the callback in every branch.

- [ ] **Step 2: Implement.** Notes that matter:

- The redirect URI is `${APP_BASE_URL}/api/google/callback`, built from the existing `APP_BASE_URL` env variable.
- State and verifier travel in one httpOnly cookie (JSON, base64), `Max-Age` 600, cleared on every callback branch. The callback compares the `state` query parameter with the cookie's value in constant time (`node:crypto`'s `timingSafeEqual` over equal-length buffers).
- The callback re-checks the admin session before writing; a signed-out or non-admin caller is refused.
- The app calendar is created once, at connect time: `createAppCalendar(accessToken, "Funnel McQueen meetings", <settings.default_timezone>)`, and its id is passed to `connect_calendar`.
- Route files stay thin, exactly like `src/app/api/voice/token/route.ts`: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` and a one-line delegation.
- Never log the code, the tokens or the secret. On an unexpected failure, log `{ step, status, reason }` only.

- [ ] **Step 3: Run the tests and commit**

Run: `npx vitest run --project integration tests/integration/google`
Expected: PASS.

```bash
git add src/server/google/oauth.ts src/server/http/google-oauth.ts "src/app/api/google" tests/integration/google
git commit -m "feat: connect a Google account from Settings over OAuth with PKCE" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Wiring the connection into booking

**Files:**
- Create: `src/server/services/calendar-connection.ts`, `src/server/actions/calendar-connection.ts`
- Modify: `src/server/services/calendar-booking.ts`
- Test: `tests/integration/calendar/google-booking.test.ts`

**Interfaces:**
- Produces:
  - `interface CalendarConnectionStatus { connected: boolean; googleEmail: string | null; hoursSet: boolean; broken: boolean }`
  - `getCalendarConnectionStatus(ctx): Promise<CalendarConnectionStatus>` (admin)
  - `getBookableHours(ctx): Promise<BookableRange[]>` (active user), `saveBookableHours(ctx, ranges: unknown): Promise<BookableRange[]>` (admin, validates with `validateBookableRanges` before the RPC and maps `invalid_hours` to that message)
  - `disconnectCalendar(ctx): Promise<void>` (admin; revokes with Google, best effort, then the RPC)
  - Actions: `saveBookableHoursAction`, `disconnectCalendarAction`, each returning `ActionResult<…>` and calling `refresh()` on success, in the shape of `src/server/actions/calendar-booking.ts`.
- Modifies in `calendar-booking.ts`: `calendarFor` resolves the Google client when the driver is `google` — reading the connection row and the hours with the **service role or the caller's context as the existing code does**, passing them into `resolveGoogleCalendar`, and supplying `onInvalidGrant` = call `mark_calendar_broken()` then treat the calendar as unavailable. `cancelAppointment` additionally deletes the Google event when the appointment has a `google_event_id` and the driver is `google`; a failure there is logged with `{ appointmentId, eventId, code }` and does not fail the cancellation.

- [ ] **Step 1: Write the failing integration test** — `tests/integration/calendar/google-booking.test.ts`, with `globalThis.fetch` stubbed for Google. Cover:

1. with a connection row and hours, `getAgentAvailability` returns slots inside the hours and busy blocks from the stubbed free/busy, and nothing but times (assert the key list, as in `availability.test.ts`);
2. booking calls Google once and stores the returned event id on the appointment (read the row back);
3. a lead with an email produces an `attendees` entry in the request body; a lead without one produces no `attendees` key;
4. `invalid_grant` during availability marks the connection broken (`get_calendar_status()` reports `broken`) and the agent gets the "booking isn't available" message;
5. a transient Google failure during booking leaves no appointment row behind and does **not** mark the connection broken;
6. an admin cancelling an appointment deletes the Google event (assert the stubbed call) and still marks the row cancelled when that delete fails;
7. with the connection row absent, availability is "unavailable" and nothing calls Google.

- [ ] **Step 2: Implement**, keeping milestone 1's error messages (`src/lib/domain/booking-messages.ts`) exactly as they are — the agent-facing copy does not change in this milestone.

- [ ] **Step 3: Run the calendar suites and commit**

Run: `npx vitest run --project integration tests/integration/calendar`
Expected: PASS, including milestone 1's two suites unchanged.

```bash
git add src/server/services/calendar-connection.ts src/server/actions/calendar-connection.ts src/server/services/calendar-booking.ts tests/integration/calendar/google-booking.test.ts
git commit -m "feat: book against Google, mark a broken connection, cancel the event too" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The Settings card

**Files:**
- Create: `src/components/settings/calendar-section.tsx`, `src/components/settings/bookable-hours-form.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Test: `tests/unit/settings/calendar-section.test.tsx`

**Interfaces:**
- Consumes: `CalendarConnectionStatus`, `BookableRange`, `validateBookableRanges`, `formatMinutes`, the two actions from Task 7.
- Produces: `CalendarSection({ status, hours }: { status: CalendarConnectionStatus; hours: BookableRange[] })` — a client component rendered by the admin half of the Settings page, above the company settings card.

- [ ] **Step 1: Write the failing test** — `tests/unit/settings/calendar-section.test.tsx`, rendering to static markup the way `tests/unit/booking/next-meeting.test.tsx` does (mock the actions module). Cover:
1. not connected: the card says **Not connected** and shows a **Connect Google Calendar** link pointing at `/api/google/start`;
2. connected: it shows the account email and a **Disconnect** control, and the markup contains no token-looking string;
3. broken: it shows the reconnect banner with the word **Reconnect** and still shows the email;
4. the hours list renders each range as `10:00 – 12:00` under its weekday name, and a weekday with no ranges reads **Closed**.

- [ ] **Step 2: Build the card.** Requirements:

- Connection block: status line, a Connect/Reconnect link (an ordinary `<a href="/api/google/start">` — it is a redirect, not an action), Disconnect behind a confirmation dialog in the style of the existing settings dialogs. Never render a token or the ciphertext.
- The `?calendar=` query values from Task 6 (`connected`, `denied`, `error`) surface as a sonner toast on load: "Google Calendar connected.", "Google sign-in was cancelled.", "Couldn't connect Google Calendar. Try again."
- Hours editor: one row per weekday (Sunday first, matching weekday 0), each with its ranges as two `<select>`s of half-hour times plus a Remove button, an **Add a range** button per day, and one **Save hours** button for the whole week. Validate with `validateBookableRanges` before submitting and show the returned message inline; show the server's message when the action fails.
- Times are shown in the company time zone, named in the card's description line: "Times are in {zone}."
- Every control keeps the project's 48px touch target (`min-h-12`) and works by keyboard.

- [ ] **Step 3: Render it on the Settings page** — in `src/app/(app)/settings/page.tsx`, fetch the status and hours for admins (reusing the page's existing data-loading shape) and render `<CalendarSection />` above the company settings card. Non-admins see nothing new.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npx eslint src/components/settings src/app/\(app\)/settings --max-warnings=0 && npx vitest run --project unit tests/unit/settings`
Expected: PASS.

```bash
git add src/components/settings "src/app/(app)/settings/page.tsx" tests/unit/settings
git commit -m "feat(settings): connect Google Calendar and set the bookable hours" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: End to end

**Files:**
- Create: `e2e/workspace-calendar-settings.spec.ts`

The e2e server stays on `CALENDAR_DRIVER=mock`, so this spec covers the Settings card with no connection, which is what an operator sees before connecting.

- [ ] **Step 1: Write the spec** — in the `workspace` project's style (see `e2e/workspace-calendar-booking.spec.ts`), signed in as the seeded admin:
1. `/settings` shows the calendar card with **Not connected** and a Connect link whose `href` ends with `/api/google/start` (do not click it — it leaves the app);
2. the hours editor shows Monday with `10:00 – 12:00` and `14:00 – 17:00`;
3. changing Monday's first range to `11:00` and saving shows the success toast, and the value survives a reload;
4. setting a start later than its end shows the inline message and saves nothing.
Restore Monday to `10:00 – 12:00` at the end of the spec so the other specs' expectations hold.

- [ ] **Step 2: Run it**

Run: `npx playwright test --project=workspace --no-deps e2e/workspace-calendar-settings.spec.ts`
Expected: 4 passed. (`--no-deps` because the `workspace` project's dependency chain runs the whole suite; the full run happens in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add e2e/workspace-calendar-settings.spec.ts
git commit -m "test(e2e): the calendar settings card before a connection exists" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/DEVIATIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/RUNBOOK.md`, `.env.example`, `docs/PLAN.md`

- [ ] **Step 1: Deviation D47** — add the index row after D46's and append a section titled `## D47. Google Calendar connection` covering: the four scopes and what each permits; that meetings live on an app-created calendar because of `calendar.app.created`; bookable hours living in the CRM rather than a Google calendar (a change from D46's design, which must be stated); the Meet link and the invited lead, with Google sending that invitation; cancelling in the CRM deleting the Google event; the encrypted refresh token; and under "Not built" the items in §12 of the design, including that busy time on the owner's other secondary calendars is invisible.

- [ ] **Step 2: Architecture** — extend the "Closer calendar booking (D46)" section with the new tables and RPCs (`bookable_hours`, `set_bookable_hours`, `connect_calendar`, `disconnect_calendar`, `mark_calendar_broken`, the new `get_calendar_status` columns), the driver resolution including auto-detect, and the Google modules. Add the three `GOOGLE_*` variables to the environment table in the same style as `CALENDAR_DRIVER`.

- [ ] **Step 3: README** — add the Google setup steps (design §2, verbatim in substance: project and API, consent screen External and published, OAuth client with both redirect URIs, the three variables and the key-generation command) and the three variables to its environment table. State plainly that leaving the consent screen in testing makes Google expire the connection every seven days.

- [ ] **Step 4: RUNBOOK** — add "The calendar connection broke": what the agent sees, that `broken_at` is set, and the fix (Settings → Reconnect; if Google refuses, check the three variables and that the consent screen is published).

- [ ] **Step 5: `.env.example` and migration counts** — add the three variables with comments in the file's existing style, and update every "N migrations" claim and the `001900` reference the docs-drift test checks:

```bash
grep -rn "migrations" README.md docs/ARCHITECTURE.md docs/PLAN.md | grep -E "[0-9]+ migrations|001900"
```

- [ ] **Step 6: Run the docs tests and commit**

Run: `npx vitest run --project unit tests/unit/docs`
Expected: PASS.

```bash
git add docs README.md .env.example
git commit -m "docs: the Google Calendar connection (D47), scopes, setup and runbook" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification

- [ ] **Step 1:** `npm run verify` — typecheck, lint, and the unit, db and integration projects all pass.
- [ ] **Step 2:** `npm run test:e2e` — every Playwright project passes. If a worker dies with a Windows resource error (`code=3221225794`) or `e2e/desktop-pipeline-stages.spec.ts` fails on its enabled-then-click race, both are known pre-existing environment flakes: re-run once and say so in the report rather than changing app code.
- [ ] **Step 3: Fix, never skip** — if anything else fails, reproduce it with the narrowest command, fix the cause, rerun that command, then rerun Steps 1–2. Commit each fix separately with the trailer.
- [ ] **Step 4: Report what only a human can finish** — the connection cannot be proven end to end without the owner's Google account. Write the exact steps for them in the final report: set the three variables locally, run `npm run dev:local`, open Settings, press Connect, approve, then book a meeting from a lead and confirm the event, the Meet link and the invitation in Google Calendar.
