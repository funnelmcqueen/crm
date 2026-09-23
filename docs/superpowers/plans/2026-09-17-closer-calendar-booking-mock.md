# Closer Calendar Booking — Plan 1: Booking on the Mock Calendar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents book 30-minute meetings with leads into one closer calendar mid-call, see only free slots, their own bookings and anonymous busy time, and get three slots ranked by the lead's business rhythm — all working end to end on an in-memory mock calendar.

**Architecture:** Postgres owns isolation: an `appointments` table read under RLS and written only through guarded SECURITY DEFINER RPCs, with a unique index that lets one live booking hold a slot. Pure domain modules compute free slots, business-type guesses, rhythm scores and spoken phrases. A `CalendarClient` interface (mock now, Google in Plan 2) feeds a service that never forwards event details, and a side-panel UI books from the lead page or the in-call bar.

**Tech Stack:** Next.js 16 App Router (server actions, `refresh()` from `next/cache`), TypeScript strict, Supabase Postgres via localbase (PGlite), Zod v4, date-fns 4 + `@date-fns/tz`, shadcn/Radix UI, sonner, Vitest (unit/db/integration projects), Playwright (`workspace` project).

**Spec:** `docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md`. Plan 2 (Google OAuth, token encryption, live Google client) is written after this plan lands, against the `CalendarClient` interface defined in Task 8.

## Global Constraints

- Work only in the worktree `.worktrees/calendar-booking` (branch `calendar-booking`). Never touch the main checkout.
- Slot length 30 minutes; slot starts are UTC multiples of 30 minutes (`epoch % 1800 = 0`).
- Booking horizon 14 days; minimum notice 120 minutes; availability cache 60 seconds.
- Rate limit bucket `book_appointment`: 20 per user per hour.
- Appointment note: at most 500 characters.
- Suggestions: at most 3, no two starting within 60 minutes of each other. Scores: +2 entirely inside a best window, −3 overlapping an avoid window, −1 outside 08:00–19:00 lead-local; ties go to the earlier slot.
- All intervals are half-open `[start, end)`.
- Business types, exactly: `restaurant`, `cafe_bakery`, `hotel_motel`, `home_services`, `auto`, `retail`, `beauty`, `other`.
- Every SQL function: `set search_path = ''`, fully qualified names, `revoke execute ... from public, anon`, then explicit grants; every new table enables RLS.
- No Google event title, description or attendee may ever be serialized to an agent's browser.
- `CALENDAR_DRIVER=mock` with `NODE_ENV=production` is refused at startup.
- The deviation for this feature is **D46** (D45 belongs to the `pep-talk` branch).
- New migration file: `supabase/migrations/20260915001900_calendar_booking.sql`. Never edit earlier migrations.
- LF line endings; forward slashes in paths and scripts.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260915001900_calendar_booking.sql` | Enums, `leads.business_type`, `appointments`, `calendar_connection`, RLS, RPCs, rate-limit bucket |
| `src/lib/domain/business-type.ts` | Type list, labels, name guessing, import value mapping |
| `src/lib/domain/lead-timezone.ts` | Lead IANA zone from US state |
| `src/lib/domain/calendar-slots.ts` | Interval merge and free-slot computation |
| `src/lib/domain/business-rhythm.ts` | Rhythm profiles, slot scoring, suggestions |
| `src/lib/domain/slot-phrase.ts` | "Tomorrow at 5 pm", zone abbreviation, "your time" line |
| `src/lib/domain/meeting-description.ts` | Event title and description text |
| `src/server/env.ts` (modify) | `CALENDAR_DRIVER`, `getCalendarDriver` |
| `src/server/calendar/types.ts` | `CalendarClient` interface |
| `src/server/calendar/mock.ts` | In-memory calendar |
| `src/server/calendar/client.ts` | Resolve the client for the current driver |
| `src/server/errors.ts` (modify) | `slot_taken` conflict reason |
| `src/server/services/calendar-booking.ts` | Availability, booking, cancel, business type, next meeting |
| `src/server/actions/calendar-booking.ts` | Server actions for the above |
| `src/lib/domain/import-mapping.ts`, `src/components/import/import-model.ts`, `src/server/services/import.ts` (modify) | Business type import column |
| `src/lib/domain/bulk-leads.ts`, `src/server/services/bulk-leads.ts`, `src/server/actions/bulk-leads.ts`, `src/components/leads/bulk/bulk-dialogs.tsx`, `src/components/leads/bulk/bulk-action-bar.tsx` (modify) | Bulk "Set business type" |
| `src/lib/dialer/state.ts`, `src/components/dialer/dialer-context.tsx`, `src/components/dialer/dialer-provider.tsx` (modify) | `MEETING_BOOKED` |
| `src/components/booking/booking-model.ts` | Day grouping for the panel |
| `src/components/booking/booking-panel.tsx` | Panel body |
| `src/components/booking/book-meeting-button.tsx` | Trigger + sheet + loading |
| `src/components/booking/next-meeting.tsx`, `src/components/booking/cancel-appointment-button.tsx` | Lead page meeting line |
| `src/components/dialer/in-call-bar.tsx`, `src/app/(app)/leads/[id]/page.tsx` (modify) | Entry points |
| `scripts/e2e-server.ts` (modify), `e2e/workspace-calendar-booking.spec.ts` | End-to-end |
| `docs/DEVIATIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/PLAN.md`, `.env.example` (modify) | Docs |

## Before you start

- [ ] **Install dependencies in the worktree** (it has no `node_modules` yet):

```bash
cd .worktrees/calendar-booking && npm ci
```

Expected: completes without errors. Then confirm the baseline is green: `npm run typecheck`.

---

### Task 1: Business type in the database

**Files:**
- Create: `supabase/migrations/20260915001900_calendar_booking.sql`
- Create: `tests/db/business-type.test.ts`
- Modify: `tests/db/grants.test.ts` (MATRIX and INVOKER)
- Modify: `src/lib/database.types.ts` (regenerated)

**Interfaces:**
- Produces: enum `public.business_type`; column `public.leads.business_type` (nullable); `public.set_lead_business_type(p_lead_id uuid, p_type public.business_type default null) returns void` (definer); `public.bulk_set_business_type(p_lead_ids uuid[], p_type public.business_type default null) returns integer` (invoker, admin only).

- [ ] **Step 1: Write the failing DB test** — `tests/db/business-type.test.ts`:

```ts
// Business type on leads (migration 20260915001900_calendar_booking.sql, docs/DEVIATIONS.md D46): agents correct it
// on their own leads through set_lead_business_type; admins set it on any lead and in bulk.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, bootDb, createAuthUser, createLeadRow, pgError, userRows, type PGlite } from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', agent: '', other: '' };

const SET = 'select public.set_lead_business_type($1::uuid, $2::public.business_type)';
const BULK = 'select public.bulk_set_business_type($1::uuid[], $2::public.business_type) as n';

async function typeOf(leadId: string): Promise<string | null> {
  const [row] = await adminSqlRows<{ business_type: string | null }>(db, 'select business_type from public.leads where id = $1', [leadId]);
  return row.business_type;
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Type Admin' });
  u.agent = await createAuthUser(db, { name: 'Type Agent' });
  u.other = await createAuthUser(db, { name: 'Other Agent' });
});

afterAll(async () => {
  await db?.close();
});

describe('set_lead_business_type', () => {
  it('lets an agent set and clear the type on their own lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    await userRows(db, u.agent, SET, [lead.id, 'restaurant']);
    expect(await typeOf(lead.id)).toBe('restaurant');
    await userRows(db, u.agent, SET, [lead.id, null]);
    expect(await typeOf(lead.id)).toBeNull();
  });

  it("answers not_found for another agent's lead and lets an admin set any lead", async () => {
    const lead = await createLeadRow(db, { assigned_to: u.other });
    expect((await pgError(userRows(db, u.agent, SET, [lead.id, 'auto']))).code).toBe('P0002');
    await userRows(db, u.admin, SET, [lead.id, 'auto']);
    expect(await typeOf(lead.id)).toBe('auto');
  });

  it('rejects a value outside the enum', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(userRows(db, u.agent, SET, [lead.id, 'dentist']))).code).toBe('22P02');
  });
});

describe('bulk_set_business_type', () => {
  it('sets the type on many leads for an admin and counts only real changes', async () => {
    const a = await createLeadRow(db, { assigned_to: u.agent });
    const b = await createLeadRow(db, { assigned_to: u.other });
    const [first] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id, b.id, a.id], 'hotel_motel']);
    expect(first.n).toBe(2);
    const [again] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id, b.id], 'hotel_motel']);
    expect(again.n).toBe(0);
    const [cleared] = await userRows<{ n: number }>(db, u.admin, BULK, [[a.id], null]);
    expect(cleared.n).toBe(1);
    expect(await typeOf(a.id)).toBeNull();
  });

  it('is admin only and caps the selection at 5,000', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agent });
    expect((await pgError(userRows(db, u.agent, BULK, [[lead.id], 'retail']))).code).toBe('42501');
    const tooMany = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await pgError(userRows(db, u.admin, BULK, [tooMany, 'retail']))).message).toBe('too_many_leads');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project db tests/db/business-type.test.ts`
Expected: FAIL — `type "public.business_type" does not exist`.

- [ ] **Step 3: Create the migration with the business-type section** — `supabase/migrations/20260915001900_calendar_booking.sql`:

```sql
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
```

- [ ] **Step 4: Register the functions in the grants matrix** — in `tests/db/grants.test.ts`, inside `const MATRIX`, directly after the line `  my_caller_id_available: 'api',` add:

```ts
  // closer calendar booking (D46)
  set_lead_business_type: 'api',
  bulk_set_business_type: 'api',
```

and inside `const INVOKER = new Set([`, directly after `  'list_skipped_leads',` add:

```ts
  'bulk_set_business_type',
```

- [ ] **Step 5: Run the DB tests to verify they pass**

Run: `npx vitest run --project db tests/db/business-type.test.ts tests/db/grants.test.ts tests/db/schema-contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Regenerate database types**

Run: `npm run db:types`
Expected: `src/lib/database.types.ts` now contains `business_type: Database["public"]["Enums"]["business_type"] | null` on `leads` and the two functions. Then `npm run typecheck` passes.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260915001900_calendar_booking.sql tests/db/business-type.test.ts tests/db/grants.test.ts src/lib/database.types.ts
git commit -m "feat(db): business type on leads with guarded single and bulk setters" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Appointments and the calendar connection in the database

**Files:**
- Modify: `supabase/migrations/20260915001900_calendar_booking.sql` (append sections 2–5)
- Create: `tests/db/calendar-booking.test.ts`
- Modify: `tests/db/grants.test.ts`, `tests/db/schema-contract.test.ts`
- Modify: `src/lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `public.business_type` (Task 1); existing `public.is_admin()`, `public.is_active_user()`, `public.apply_rate_limit(uuid, text)`.
- Produces: enum `public.appointment_status` (`pending`, `scheduled`, `cancelled`); tables `public.appointments`, `public.calendar_connection`; RPCs
  - `begin_appointment(p_lead_id uuid, p_starts_at timestamptz, p_note text default null, p_client_request_id uuid default null) returns public.appointments`
  - `confirm_appointment(p_id uuid, p_google_event_id text) returns public.appointments`
  - `abandon_appointment(p_id uuid) returns void`
  - `cancel_appointment(p_id uuid) returns void`
  - `booked_intervals(p_from timestamptz, p_to timestamptz) returns table (starts_at timestamptz, ends_at timestamptz)`
  - `get_calendar_status() returns table (connected boolean, google_email text, bookable_calendar_set boolean, broken boolean)`
  - Errors: `P0002 not_found`, `P0001 do_not_contact`, `P0001 rate_limited`, `P0001 slot_taken`, `22023` validation, `42501` forbidden.

- [ ] **Step 1: Write the failing DB test** — `tests/db/calendar-booking.test.ts`:

```ts
// Appointments and the calendar connection (migration 20260915001900_calendar_booking.sql, docs/DEVIATIONS.md D46):
// bookings go through guarded RPCs, one live booking holds a slot, agents read only their own, and nobody reads the
// stored Google token through the API.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, anonRows, bootDb, createAuthUser, createLeadRow, pgError, userRows, type PGlite } from '../helpers/pglite';

let db: PGlite;
let admin = '';
const HALF_HOUR = 30 * 60_000;
let slotCursor = 0;

interface AppointmentRow {
  id: string;
  lead_id: string;
  booked_by: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  google_event_id: string | null;
  note: string | null;
  client_request_id: string;
}

const BEGIN = 'select * from public.begin_appointment($1::uuid, $2::timestamptz, $3, $4::uuid)';
const CONFIRM = 'select * from public.confirm_appointment($1::uuid, $2)';
const ABANDON = 'select public.abandon_appointment($1::uuid)';
const CANCEL = 'select public.cancel_appointment($1::uuid)';
const INTERVALS = 'select * from public.booked_intervals($1::timestamptz, $2::timestamptz)';

/** A fresh future slot on a :00/:30 boundary, never reused in this file (one live booking per slot). */
function nextSlot(): string {
  const base = Math.ceil((Date.now() + 3 * 86_400_000) / HALF_HOUR) * HALF_HOUR;
  slotCursor += 1;
  return new Date(base + slotCursor * HALF_HOUR).toISOString();
}

/** Each test books as its own agent, so the 20-an-hour limit only bites where a test means it to. */
async function agentWithLead(): Promise<{ agent: string; leadId: string }> {
  const agent = await createAuthUser(db, { name: `Booker ${randomUUID().slice(0, 6)}` });
  const lead = await createLeadRow(db, { assigned_to: agent });
  return { agent, leadId: lead.id };
}

async function begin(caller: string, leadId: string, startsAt: string, note: string | null = null, requestId: string = randomUUID()): Promise<AppointmentRow> {
  const [row] = await userRows<AppointmentRow>(db, caller, BEGIN, [leadId, startsAt, note, requestId]);
  return row;
}

async function confirm(caller: string, id: string, eventId: string): Promise<AppointmentRow> {
  const [row] = await userRows<AppointmentRow>(db, caller, CONFIRM, [id, eventId]);
  return row;
}

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Closer Admin' });
});

afterAll(async () => {
  await db?.close();
});

describe('begin_appointment and confirm_appointment', () => {
  it("books a pending slot on the agent's own lead, then confirms it idempotently", async () => {
    const { agent, leadId } = await agentWithLead();
    const row = await begin(agent, leadId, nextSlot(), '  bring the menu  ');
    expect(row).toMatchObject({ lead_id: leadId, booked_by: agent, status: 'pending', note: 'bring the menu', google_event_id: null });
    expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(HALF_HOUR);

    const confirmed = await confirm(agent, row.id, 'evt-1');
    expect(confirmed).toMatchObject({ id: row.id, status: 'scheduled', google_event_id: 'evt-1' });
    expect((await confirm(agent, row.id, 'evt-1')).id).toBe(row.id);
  });

  it('answers not_found for a lead the agent cannot see, and lets an admin book any lead', async () => {
    const owner = await agentWithLead();
    const stranger = await agentWithLead();
    expect((await pgError(begin(stranger.agent, owner.leadId, nextSlot()))).code).toBe('P0002');
    expect((await begin(admin, owner.leadId, nextSlot())).booked_by).toBe(admin);
  });

  it('refuses a Do Not Contact lead', async () => {
    const agent = await createAuthUser(db, { name: 'DNC Booker' });
    const lead = await createLeadRow(db, { assigned_to: agent, status: 'DO_NOT_CONTACT' });
    expect(await pgError(begin(agent, lead.id, nextSlot()))).toMatchObject({ code: 'P0001', message: 'do_not_contact' });
  });

  it('validates the slot boundary, the past and the note length', async () => {
    const { agent, leadId } = await agentWithLead();
    const offBoundary = new Date(new Date(nextSlot()).getTime() + 15 * 60_000).toISOString();
    expect((await pgError(begin(agent, leadId, offBoundary))).code).toBe('22023');
    const past = new Date(Math.floor((Date.now() - 86_400_000) / HALF_HOUR) * HALF_HOUR).toISOString();
    expect((await pgError(begin(agent, leadId, past))).code).toBe('22023');
    expect((await pgError(begin(agent, leadId, nextSlot(), 'x'.repeat(501)))).code).toBe('22023');
  });

  it('returns the same appointment for a replayed request id', async () => {
    const { agent, leadId } = await agentWithLead();
    const requestId = randomUUID();
    const start = nextSlot();
    const first = await begin(agent, leadId, start, null, requestId);
    const replay = await begin(agent, leadId, start, null, requestId);
    expect(replay.id).toBe(first.id);
    const [count] = await adminSqlRows<{ n: number }>(db, 'select count(*)::integer as n from public.appointments where client_request_id = $1', [requestId]);
    expect(count.n).toBe(1);
  });
});

describe('one live booking per slot', () => {
  it('refuses a second live booking of the same start with slot_taken, until the first is abandoned', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const start = nextSlot();
    const held = await begin(a.agent, a.leadId, start);
    expect(await pgError(begin(b.agent, b.leadId, start))).toMatchObject({ code: 'P0001', message: 'slot_taken' });

    await userRows(db, a.agent, ABANDON, [held.id]);
    expect((await begin(b.agent, b.leadId, start)).status).toBe('pending');
  });

  it('clears pending bookings older than ten minutes before inserting', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const start = nextSlot();
    const stale = await begin(a.agent, a.leadId, start);
    await adminSqlRows(db, "update public.appointments set created_at = now() - interval '11 minutes' where id = $1", [stale.id]);

    expect((await begin(b.agent, b.leadId, start)).booked_by).toBe(b.agent);
    expect(await adminSqlRows(db, 'select id from public.appointments where id = $1', [stale.id])).toHaveLength(0);
  });

  it('lets only the booker confirm or abandon, and only while pending', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const row = await begin(a.agent, a.leadId, nextSlot());
    expect((await pgError(confirm(b.agent, row.id, 'evt-x'))).code).toBe('P0002');
    await userRows(db, b.agent, ABANDON, [row.id]);
    await confirm(a.agent, row.id, 'evt-y');
    await userRows(db, a.agent, ABANDON, [row.id]);
    const [kept] = await adminSqlRows<{ status: string }>(db, 'select status from public.appointments where id = $1', [row.id]);
    expect(kept.status).toBe('scheduled');
  });

  it('cancel is admin only, and a cancelled meeting frees the slot', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const start = nextSlot();
    const row = await begin(a.agent, a.leadId, start);
    await confirm(a.agent, row.id, `evt-${randomUUID()}`);

    expect((await pgError(userRows(db, a.agent, CANCEL, [row.id]))).code).toBe('42501');
    await userRows(db, admin, CANCEL, [row.id]);
    expect((await pgError(userRows(db, admin, CANCEL, [row.id]))).code).toBe('P0002');
    expect((await begin(b.agent, b.leadId, start)).status).toBe('pending');
  });

  it('rate limits bookings at 20 an hour per user', async () => {
    const { agent, leadId } = await agentWithLead();
    for (let i = 0; i < 20; i += 1) await begin(agent, leadId, nextSlot());
    expect(await pgError(begin(agent, leadId, nextSlot()))).toMatchObject({ code: 'P0001', message: 'rate_limited' });
  });
});

describe('reading appointments', () => {
  it('shows an agent only their own appointments and an admin all of them', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const mine = await begin(a.agent, a.leadId, nextSlot());
    const theirs = await begin(b.agent, b.leadId, nextSlot());

    const seenByA = (await userRows<{ id: string }>(db, a.agent, 'select id from public.appointments')).map((r) => r.id);
    expect(seenByA).toContain(mine.id);
    expect(seenByA).not.toContain(theirs.id);
    const seenByAdmin = (await userRows<{ id: string }>(db, admin, 'select id from public.appointments')).map((r) => r.id);
    expect(seenByAdmin).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect((await pgError(anonRows(db, 'select id from public.appointments'))).code).toBe('42501');
  });

  it('booked_intervals gives any active user the times of live bookings, and nothing else', async () => {
    const a = await agentWithLead();
    const b = await agentWithLead();
    const start = nextSlot();
    const live = await begin(a.agent, a.leadId, start);
    const cancelled = await begin(a.agent, a.leadId, nextSlot());
    await confirm(a.agent, cancelled.id, `evt-${randomUUID()}`);
    await userRows(db, admin, CANCEL, [cancelled.id]);

    const from = new Date(new Date(start).getTime() - 3_600_000).toISOString();
    const to = new Date(new Date(start).getTime() + 86_400_000).toISOString();
    const rows = await userRows<Record<string, Date>>(db, b.agent, INTERVALS, [from, to]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['ends_at', 'starts_at']);
    const starts = rows.map((r) => r.starts_at.toISOString());
    expect(starts).toContain(live.starts_at.toISOString());
    expect(starts).not.toContain(cancelled.starts_at.toISOString());

    expect((await pgError(userRows(db, b.agent, INTERVALS, [to, from]))).code).toBe('22023');
    expect((await pgError(anonRows(db, INTERVALS, [from, to]))).code).toBe('42501');
  });
});

describe('calendar_connection', () => {
  it('is unreadable through the API, even for an admin, and get_calendar_status exposes no token', async () => {
    expect((await pgError(userRows(db, admin, 'select * from public.calendar_connection'))).code).toBe('42501');
    const [before] = await userRows<Record<string, unknown>>(db, admin, 'select * from public.get_calendar_status()');
    expect(before).toEqual({ connected: false, google_email: null, bookable_calendar_set: false, broken: false });

    await adminSqlRows(db, 'insert into public.calendar_connection (google_email, refresh_token_ciphertext, connected_by) values ($1, $2, $3)', ['closer@example.com', 'ciphertext', admin]);
    const [after] = await userRows<Record<string, unknown>>(db, admin, 'select * from public.get_calendar_status()');
    expect(after).toEqual({ connected: true, google_email: 'closer@example.com', bookable_calendar_set: false, broken: false });

    const { agent } = await agentWithLead();
    expect((await pgError(userRows(db, agent, 'select * from public.get_calendar_status()'))).code).toBe('42501');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project db tests/db/calendar-booking.test.ts`
Expected: FAIL — `function public.begin_appointment(...) does not exist`.

- [ ] **Step 3: Append sections 2–5 to the migration** — add to the end of `supabase/migrations/20260915001900_calendar_booking.sql`:

```sql

-- ---------------------------------------------------------------------------------------------
-- 2. Appointments
-- ---------------------------------------------------------------------------------------------
create type public.appointment_status as enum ('pending', 'scheduled', 'cancelled');

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  booked_by uuid not null references public.profiles (id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.appointment_status not null default 'pending',
  google_event_id text constraint appointments_google_event_id_key unique,
  note text constraint appointments_note_length check (char_length(note) <= 500),
  client_request_id uuid not null constraint appointments_client_request_id_key unique,
  created_at timestamptz not null default now(),
  constraint appointments_thirty_minutes check (ends_at = starts_at + interval '30 minutes')
);

create index appointments_starts_at_idx on public.appointments (starts_at);
-- Every appointment is 30 minutes on a :00/:30 boundary, so this makes two live bookings of one slot
-- impossible, whatever the timing between two agents.
create unique index appointments_live_start_key on public.appointments (starts_at)
  where status in ('pending', 'scheduled');

alter table public.appointments enable row level security;
revoke all on public.appointments from anon, authenticated;
grant select on public.appointments to authenticated;

-- An agent reads the appointments they booked; an admin reads all. Writes go through the RPCs below.
create policy appointments_select on public.appointments
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_active_user()) and appointments.booked_by = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------------------------
-- 3. Calendar connection (singleton). Service role only; Plan 2 writes it.
-- ---------------------------------------------------------------------------------------------
create table public.calendar_connection (
  id boolean primary key default true constraint calendar_connection_singleton check (id),
  google_email text not null,
  refresh_token_ciphertext text not null,
  bookable_calendar_id text,
  connected_by uuid not null references public.profiles (id) on delete restrict,
  connected_at timestamptz not null default now(),
  broken_at timestamptz
);

alter table public.calendar_connection enable row level security;
revoke all on public.calendar_connection from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Rate limit bucket for bookings (body of 20260915000300, plus book_appointment)
-- ---------------------------------------------------------------------------------------------
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
    when 'book_appointment' then
      v_max := 20;
      v_window := interval '1 hour';
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

-- ---------------------------------------------------------------------------------------------
-- 5. Booking RPCs
-- ---------------------------------------------------------------------------------------------
create or replace function public.begin_appointment(
  p_lead_id uuid,
  p_starts_at timestamptz,
  p_note text default null,
  p_client_request_id uuid default null
)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status public.lead_status;
  v_row public.appointments;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_lead_id is null or p_starts_at is null or p_client_request_id is null then
    raise exception 'invalid appointment' using errcode = '22023';
  end if;

  -- A replay of the same attempt returns what it created, before anything else can fail or count.
  select * into v_row
    from public.appointments a
   where a.client_request_id = p_client_request_id
     and a.booked_by = v_uid;
  if found then
    return v_row;
  end if;

  if (extract(epoch from p_starts_at)::bigint % 1800) <> 0 or p_starts_at < now() then
    raise exception 'invalid slot' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'note too long' using errcode = '22023';
  end if;

  select l.status into v_status
    from public.leads l
   where l.id = p_lead_id
     and (public.is_admin() or l.assigned_to = v_uid);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_status = 'DO_NOT_CONTACT' then
    raise exception 'do_not_contact' using errcode = 'P0001';
  end if;

  if not public.apply_rate_limit(v_uid, 'book_appointment') then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- A pending row older than ten minutes belongs to a booking that died between steps.
  delete from public.appointments a
   where a.status = 'pending'
     and a.created_at < now() - interval '10 minutes';

  begin
    insert into public.appointments (lead_id, booked_by, starts_at, ends_at, note, client_request_id)
    values (p_lead_id, v_uid, p_starts_at, p_starts_at + interval '30 minutes', v_note, p_client_request_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  return v_row;
end;
$$;

create or replace function public.confirm_appointment(p_id uuid, p_google_event_id text)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event text := nullif(btrim(coalesce(p_google_event_id, '')), '');
  v_row public.appointments;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_event is null or char_length(v_event) > 1024 then
    raise exception 'invalid event id' using errcode = '22023';
  end if;

  update public.appointments a
     set status = 'scheduled', google_event_id = v_event
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'pending'
  returning * into v_row;
  if found then
    return v_row;
  end if;

  select * into v_row
    from public.appointments a
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'scheduled'
     and a.google_event_id = v_event;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

create or replace function public.abandon_appointment(p_id uuid)
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
  delete from public.appointments a
   where a.id = p_id
     and a.booked_by = v_uid
     and a.status = 'pending';
end;
$$;

-- CRM only: the event stays in Google Calendar until the closer deletes it there.
create or replace function public.cancel_appointment(p_id uuid)
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
  update public.appointments a
     set status = 'cancelled'
   where a.id = p_id
     and a.status = 'scheduled';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- Times only, no lead and no agent: another agent's fresh booking leaves the picker before the
-- calendar is re-read. Stale pending rows (a booking that died) do not count.
create or replace function public.booked_intervals(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or not public.is_active_user() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  return query
    select a.starts_at, a.ends_at
      from public.appointments a
     where a.starts_at < p_to
       and a.ends_at > p_from
       and (a.status = 'scheduled' or (a.status = 'pending' and a.created_at >= now() - interval '10 minutes'))
     order by a.starts_at;
end;
$$;

create or replace function public.get_calendar_status()
returns table (connected boolean, google_email text, bookable_calendar_set boolean, broken boolean)
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
    select true, c.google_email, c.bookable_calendar_id is not null, c.broken_at is not null
      from public.calendar_connection c
    union all
    select false, null::text, false, false
     where not exists (select 1 from public.calendar_connection);
end;
$$;

revoke execute on function public.begin_appointment(uuid, timestamptz, text, uuid) from public, anon;
revoke execute on function public.confirm_appointment(uuid, text) from public, anon;
revoke execute on function public.abandon_appointment(uuid) from public, anon;
revoke execute on function public.cancel_appointment(uuid) from public, anon;
revoke execute on function public.booked_intervals(timestamptz, timestamptz) from public, anon;
revoke execute on function public.get_calendar_status() from public, anon;
grant execute on function public.begin_appointment(uuid, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function public.confirm_appointment(uuid, text) to authenticated, service_role;
grant execute on function public.abandon_appointment(uuid) to authenticated, service_role;
grant execute on function public.cancel_appointment(uuid) to authenticated, service_role;
grant execute on function public.booked_intervals(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.get_calendar_status() to authenticated, service_role;
```

- [ ] **Step 4: Register the functions and foreign keys**

In `tests/db/grants.test.ts`, directly after `  bulk_set_business_type: 'api',` (added in Task 1), add:

```ts
  begin_appointment: 'api',
  confirm_appointment: 'api',
  abandon_appointment: 'api',
  cancel_appointment: 'api',
  booked_intervals: 'api',
  get_calendar_status: 'api',
```

In `tests/db/schema-contract.test.ts`, directly after `      'public.lead_skips.user_id -> public.profiles': 'r',` add:

```ts
      // Closer calendar booking (D46): an appointment goes with its lead; a booker or connector is never deleted.
      'public.appointments.lead_id -> public.leads': 'c',
      'public.appointments.booked_by -> public.profiles': 'r',
      'public.calendar_connection.connected_by -> public.profiles': 'r',
```

- [ ] **Step 5: Run the DB project to verify it passes**

Run: `npx vitest run --project db`
Expected: PASS. If a catalog-wide test fails on a new object (for example one that lists every table's privileges), add the new table or function to that test's expectations with the access stated in this task, then rerun.

- [ ] **Step 6: Regenerate types and typecheck**

Run: `npm run db:types && npm run typecheck`
Expected: `appointments`, `calendar_connection`, both enums and the six RPCs appear in `src/lib/database.types.ts`; typecheck passes.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260915001900_calendar_booking.sql tests/db/calendar-booking.test.ts tests/db/grants.test.ts tests/db/schema-contract.test.ts src/lib/database.types.ts
git commit -m "feat(db): appointments with guarded booking RPCs, one live booking per slot, calendar connection" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Business type guessing and import values

**Files:**
- Create: `src/lib/domain/business-type.ts`
- Test: `tests/unit/domain/business-type.test.ts`

**Interfaces:**
- Produces:
  - `BUSINESS_TYPES: readonly ["restaurant", "cafe_bakery", "hotel_motel", "home_services", "auto", "retail", "beauty", "other"]`
  - `type BusinessType`
  - `BUSINESS_TYPE_LABELS: Record<BusinessType, string>`, `BUSINESS_TYPE_BEST_FOR: Record<BusinessType, string>`
  - `isBusinessType(value: unknown): value is BusinessType`
  - `guessBusinessType(name: string | null | undefined): BusinessType`
  - `businessTypeFromImportValue(value: string | null | undefined): BusinessType | null`
  - `resolveBusinessType(stored: BusinessType | null, name: string | null | undefined): { type: BusinessType; isGuess: boolean }`

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/business-type.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  businessTypeFromImportValue,
  guessBusinessType,
  isBusinessType,
  resolveBusinessType,
} from "@/lib/domain/business-type";

describe("guessBusinessType", () => {
  it.each([
    ["Swan Motel", "hotel_motel"],
    ["Kompose Hotel Sarasota", "hotel_motel"],
    ["Maria's Pizzeria & Restaurant", "restaurant"],
    ["Coco Bakery-Restaurant", "restaurant"],
    ["Mama's Soul Eatery", "restaurant"],
    ["Sea Maids Creamery (Icecream & a Li", "cafe_bakery"],
    ["The Café by Mise en Place", "cafe_bakery"],
    ["Windy City Heating & Cooling", "home_services"],
    ["Silver Oak Auto Repair", "auto"],
    ["Luxe Nail Salon", "beauty"],
    ["Corner Market", "retail"],
    ["Casa V. M. Ybor", "other"],
  ])("%s is %s", (name, type) => {
    expect(guessBusinessType(name)).toBe(type);
  });

  it.each(["Innovation Labs", "Spain Imports", "Pizzazz Events", "Shopify Pros"])(
    "does not match a keyword inside a longer word: %s",
    (name) => {
      expect(guessBusinessType(name)).toBe("other");
    },
  );

  it("treats a missing name as other", () => {
    expect(guessBusinessType(null)).toBe("other");
    expect(guessBusinessType("   ")).toBe("other");
  });
});

describe("businessTypeFromImportValue", () => {
  it.each([
    ["Restaurant", "restaurant"],
    ["café / bakery", "cafe_bakery"],
    ["Hotel/Motel", "hotel_motel"],
    ["home_services", "home_services"],
    ["OTHER", "other"],
    ["Pizzeria", "restaurant"],
  ])("maps %s to %s", (value, type) => {
    expect(businessTypeFromImportValue(value)).toBe(type);
  });

  it("returns null for blank or unrecognized values", () => {
    expect(businessTypeFromImportValue("Dentist")).toBeNull();
    expect(businessTypeFromImportValue("")).toBeNull();
    expect(businessTypeFromImportValue(null)).toBeNull();
  });
});

describe("resolveBusinessType", () => {
  it("prefers the stored type and guesses only when it is missing", () => {
    expect(resolveBusinessType("retail", "Swan Motel")).toEqual({ type: "retail", isGuess: false });
    expect(resolveBusinessType(null, "Swan Motel")).toEqual({ type: "hotel_motel", isGuess: true });
  });
});

it("labels every type and recognises only real types", () => {
  for (const type of BUSINESS_TYPES) expect(BUSINESS_TYPE_LABELS[type]).toBeTruthy();
  expect(isBusinessType("beauty")).toBe(true);
  expect(isBusinessType("dentist")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/business-type.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/business-type`.

- [ ] **Step 3: Implement** — `src/lib/domain/business-type.ts`:

```ts
// A lead's business type and the guess from its name (docs/DEVIATIONS.md D46). Pure.
//
// The stored type always wins; the guess covers leads nobody has categorized yet. Matching is on whole words
// after accents are stripped, so "Innovation" never reads as "inn" and "Spain" never as "spa".

export const BUSINESS_TYPES = [
  "restaurant",
  "cafe_bakery",
  "hotel_motel",
  "home_services",
  "auto",
  "retail",
  "beauty",
  "other",
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Readonly<Record<BusinessType, string>> = {
  restaurant: "Restaurant",
  cafe_bakery: "Café / bakery",
  hotel_motel: "Hotel / motel",
  home_services: "Home services",
  auto: "Auto",
  retail: "Retail",
  beauty: "Beauty",
  other: "Other",
};

/** Completes "Best for …" in the booking panel. */
export const BUSINESS_TYPE_BEST_FOR: Readonly<Record<BusinessType, string>> = {
  restaurant: "a restaurant",
  cafe_bakery: "a café or bakery",
  hotel_motel: "a hotel or motel",
  home_services: "home services",
  auto: "an auto shop",
  retail: "a store",
  beauty: "a salon",
  other: "this lead",
};

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (BUSINESS_TYPES as readonly string[]).includes(value);
}

/** Guessing order: the first type with a whole-word match wins (Coco Bakery-Restaurant is a restaurant). */
const KEYWORDS: ReadonlyArray<readonly [BusinessType, readonly string[]]> = [
  ["hotel_motel", ["hotel", "motel", "inn", "lodge", "suites", "resort", "hostel", "bed and breakfast", "b&b"]],
  [
    "restaurant",
    ["restaurant", "pizzeria", "pizza", "grill", "bistro", "eatery", "diner", "taqueria", "sushi", "bbq", "steakhouse", "tavern", "cantina", "trattoria"],
  ],
  ["cafe_bakery", ["cafe", "coffee", "bakery", "creamery", "ice cream", "icecream", "donut", "doughnut", "patisserie"]],
  ["auto", ["auto", "automotive", "tire", "tires", "collision", "body shop", "car wash", "mechanic", "transmission"]],
  [
    "home_services",
    ["heating", "cooling", "hvac", "plumbing", "plumber", "roofing", "landscaping", "lawn", "electric", "electrical", "pest", "cleaning", "painting", "construction", "contractor", "remodeling", "pool"],
  ],
  ["beauty", ["salon", "spa", "barber", "barbershop", "nails", "beauty", "lash", "brow", "hair", "tattoo"]],
  ["retail", ["store", "shop", "boutique", "market", "outlet", "supply", "mart"]],
];

/** " word word " form: lowercase, accents stripped, every run of other characters (except &) one space. */
function words(text: string): string {
  const plain = text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
  return ` ${plain.replace(/[^a-z0-9&]+/g, " ").trim()} `;
}

function matchKeywords(text: string): BusinessType | null {
  const haystack = words(text);
  for (const [type, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(` ${keyword} `))) return type;
  }
  return null;
}

export function guessBusinessType(name: string | null | undefined): BusinessType {
  return name ? (matchKeywords(name) ?? "other") : "other";
}

/** Each type by its label ("hotel motel") and by its key ("hotel motel" again for hotel_motel). */
const LABEL_FORMS: ReadonlyArray<readonly [string, BusinessType]> = BUSINESS_TYPES.flatMap(
  (type): Array<readonly [string, BusinessType]> => [
    [words(BUSINESS_TYPE_LABELS[type]).trim(), type],
    [words(type).trim(), type],
  ],
);

/**
 * A CSV "Business type" cell: a label or key ("Hotel / motel", "hotel_motel"), or any value containing a type's
 * keyword ("Pizzeria"). Anything else is null, and import keeps the original text in the notes.
 */
export function businessTypeFromImportValue(value: string | null | undefined): BusinessType | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = words(value).trim();
  const byLabel = LABEL_FORMS.find(([form]) => form === normalized);
  return byLabel ? byLabel[1] : matchKeywords(value);
}

export function resolveBusinessType(
  stored: BusinessType | null,
  name: string | null | undefined,
): { type: BusinessType; isGuess: boolean } {
  return stored ? { type: stored, isGuess: false } : { type: guessBusinessType(name), isGuess: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/domain/business-type.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/business-type.ts tests/unit/domain/business-type.test.ts
git commit -m "feat: guess a lead's business type from its name and map import values" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The lead's time zone

**Files:**
- Create: `src/lib/domain/lead-timezone.ts`
- Test: `tests/unit/domain/lead-timezone.test.ts`

**Interfaces:**
- Produces: `interface LeadTimeZone { timeZone: string; isGuess: boolean }`; `leadTimeZone(lead: { state: string | null; country: string | null }, fallback: string): LeadTimeZone`

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/lead-timezone.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leadTimeZone } from "@/lib/domain/lead-timezone";

const FALLBACK = "America/Los_Angeles";

describe("leadTimeZone", () => {
  it.each([
    [{ state: "FL", country: "US" }, "America/New_York"],
    [{ state: "Texas", country: "United States" }, "America/Chicago"],
    [{ state: "ca", country: "U.S.A." }, "America/Los_Angeles"],
    [{ state: "AZ", country: null }, "America/Phoenix"],
    [{ state: "new york", country: "" }, "America/New_York"],
  ])("maps %o to %s", (lead, zone) => {
    expect(leadTimeZone(lead, FALLBACK)).toEqual({ timeZone: zone, isGuess: false });
  });

  it.each([
    { state: "ON", country: "Canada" },
    { state: "ZZ", country: "US" },
    { state: null, country: "US" },
  ])("falls back to the agent's zone as a guess for %o", (lead) => {
    expect(leadTimeZone(lead, FALLBACK)).toEqual({ timeZone: FALLBACK, isGuess: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/lead-timezone.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/lead-timezone`.

- [ ] **Step 3: Implement** — `src/lib/domain/lead-timezone.ts`:

```ts
// A lead's local time zone from its address (docs/DEVIATIONS.md D46). The dominant zone per US state: split
// states (the Florida panhandle, El Paso) use their larger zone. Anything outside the US is a guess.

const STATE_ZONES: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};

const US_COUNTRY = new Set(["", "us", "usa", "united states", "united states of america"]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

export interface LeadTimeZone {
  timeZone: string;
  /** True when the address gave nothing to go on and `fallback` (the agent's zone) is shown instead. */
  isGuess: boolean;
}

export function leadTimeZone(lead: { state: string | null; country: string | null }, fallback: string): LeadTimeZone {
  if (US_COUNTRY.has(normalize(lead.country))) {
    const state = normalize(lead.state);
    const code = state.length === 2 ? state.toUpperCase() : STATE_NAMES[state];
    const zone = code ? STATE_ZONES[code] : undefined;
    if (zone) return { timeZone: zone, isGuess: false };
  }
  return { timeZone: fallback, isGuess: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/domain/lead-timezone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/lead-timezone.ts tests/unit/domain/lead-timezone.test.ts
git commit -m "feat: derive a lead's time zone from its US state" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Free slots

**Files:**
- Create: `src/lib/domain/calendar-slots.ts`
- Test: `tests/unit/domain/calendar-slots.test.ts`

**Interfaces:**
- Produces: `SLOT_MINUTES = 30`, `SLOT_MS`, `BOOKING_HORIZON_DAYS = 14`, `BOOKING_NOTICE_MINUTES = 120`; `interface Interval { start: Date; end: Date }`; `mergeIntervals(intervals: readonly Interval[]): Interval[]`; `interface FreeSlotsInput { windows: readonly Interval[]; busy: readonly Interval[]; now: Date; horizonDays?: number; noticeMinutes?: number }`; `freeSlots(input: FreeSlotsInput): Interval[]`

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/calendar-slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";

const at = (iso: string) => new Date(iso);
const span = (start: string, end: string): Interval => ({ start: at(start), end: at(end) });
const starts = (slots: Interval[]) => slots.map((slot) => slot.start.toISOString().slice(11, 16));
const NOW = at("2026-09-21T06:00:00Z");

describe("mergeIntervals", () => {
  it("sorts, joins overlapping and touching intervals, and drops empty ones", () => {
    const merged = mergeIntervals([
      span("2026-09-21T11:00:00Z", "2026-09-21T12:00:00Z"),
      span("2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z"),
      span("2026-09-21T11:30:00Z", "2026-09-21T11:45:00Z"),
      span("2026-09-21T14:00:00Z", "2026-09-21T14:00:00Z"),
    ]);
    expect(merged).toEqual([span("2026-09-21T10:00:00Z", "2026-09-21T12:00:00Z")]);
  });
});

describe("freeSlots", () => {
  it("aligns slots to :00 and :30 inside a window", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T12:10:00Z", "2026-09-21T14:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(starts(slots)).toEqual(["12:30", "13:00", "13:30"]);
  });

  it("treats intervals as half-open, so busy until 10:30 still leaves 10:30 free", () => {
    const slots = freeSlots({
      windows: [span("2026-09-21T10:00:00Z", "2026-09-21T11:00:00Z")],
      busy: [span("2026-09-21T10:00:00Z", "2026-09-21T10:30:00Z")],
      now: NOW,
      noticeMinutes: 0,
    });
    expect(starts(slots)).toEqual(["10:30"]);
  });

  it("skips anything overlapping busy time", () => {
    const slots = freeSlots({
      windows: [span("2026-09-21T10:00:00Z", "2026-09-21T12:00:00Z")],
      busy: [span("2026-09-21T10:45:00Z", "2026-09-21T11:15:00Z")],
      now: NOW,
      noticeMinutes: 0,
    });
    expect(starts(slots)).toEqual(["10:00", "11:30"]);
  });

  it("keeps two hours of notice by default", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T09:00:00Z", "2026-09-21T13:00:00Z")], busy: [], now: at("2026-09-21T09:05:00Z") });
    expect(starts(slots)).toEqual(["11:30", "12:00", "12:30"]);
  });

  it("offers nothing starting 14 days or more ahead", () => {
    const slots = freeSlots({ windows: [span("2026-10-05T05:00:00Z", "2026-10-05T07:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(starts(slots)).toEqual(["05:00", "05:30"]);
  });

  it("follows a window across midnight", () => {
    const slots = freeSlots({ windows: [span("2026-09-21T22:00:00Z", "2026-09-22T01:00:00Z")], busy: [], now: NOW, noticeMinutes: 0 });
    expect(slots).toHaveLength(6);
  });

  it("counts real time across a clock change (01:00 EDT to 03:00 EST is three hours)", () => {
    const slots = freeSlots({ windows: [span("2026-11-01T05:00:00Z", "2026-11-01T08:00:00Z")], busy: [], now: at("2026-10-31T00:00:00Z"), noticeMinutes: 0 });
    expect(slots).toHaveLength(6);
  });

  it("returns nothing without windows", () => {
    expect(freeSlots({ windows: [], busy: [], now: NOW })).toEqual([]);
  });
});
```

(The horizon test: `NOW` is 2026-09-21T06:00Z, so 14 days later is 2026-10-05T06:00Z; slots starting 05:00 and 05:30 are inside, 06:00 and 06:30 are not.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/calendar-slots.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/calendar-slots`.

- [ ] **Step 3: Implement** — `src/lib/domain/calendar-slots.ts`:

```ts
// Free 30-minute slots inside the closer's bookable windows (docs/DEVIATIONS.md D46). Pure and instant-based; all
// intervals are half-open [start, end).

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60_000;
export const BOOKING_HORIZON_DAYS = 14;
export const BOOKING_NOTICE_MINUTES = 120;

export interface Interval {
  start: Date;
  end: Date;
}

/** Sorted by start, with overlapping or touching intervals joined. Empty or inverted intervals are dropped. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

export interface FreeSlotsInput {
  windows: readonly Interval[];
  busy: readonly Interval[];
  now: Date;
  horizonDays?: number;
  noticeMinutes?: number;
}

/**
 * Every 30-minute slot that lies inside a window, overlaps nothing busy, starts at least the notice period from now
 * and starts before the horizon. Starts are UTC multiples of 30 minutes, which fall on :00/:30 in every time zone
 * whose offset is a whole or half hour — all of the US. `begin_appointment` checks the same boundary.
 */
export function freeSlots(input: FreeSlotsInput): Interval[] {
  const earliest = input.now.getTime() + (input.noticeMinutes ?? BOOKING_NOTICE_MINUTES) * 60_000;
  const latest = input.now.getTime() + (input.horizonDays ?? BOOKING_HORIZON_DAYS) * 86_400_000;
  const busy = mergeIntervals(input.busy);
  const slots: Interval[] = [];
  for (const window of mergeIntervals(input.windows)) {
    const first = Math.ceil(Math.max(window.start.getTime(), earliest) / SLOT_MS) * SLOT_MS;
    for (let start = first; start + SLOT_MS <= window.end.getTime() && start < latest; start += SLOT_MS) {
      const end = start + SLOT_MS;
      if (!busy.some((block) => block.start.getTime() < end && block.end.getTime() > start)) {
        slots.push({ start: new Date(start), end: new Date(end) });
      }
    }
  }
  return slots;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/domain/calendar-slots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/calendar-slots.ts tests/unit/domain/calendar-slots.test.ts
git commit -m "feat: compute free 30-minute slots inside bookable windows" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Business rhythm scoring and suggestions

**Files:**
- Create: `src/lib/domain/business-rhythm.ts`
- Test: `tests/unit/domain/business-rhythm.test.ts`

**Interfaces:**
- Consumes: `BusinessType` (Task 3), `Interval` (Task 5).
- Produces: `RHYTHMS: Record<BusinessType, { avoid: readonly (readonly [number, number])[]; best: readonly (readonly [number, number])[] }>` (minutes of the local day); `SUGGESTION_COUNT = 3`; `SUGGESTION_SPREAD_MS`; `scoreSlot(slot: Interval, type: BusinessType, timeZone: string): number`; `suggestSlots(slots: readonly Interval[], type: BusinessType, timeZone: string): Interval[]`

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/business-rhythm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreSlot, suggestSlots } from "@/lib/domain/business-rhythm";
import type { Interval } from "@/lib/domain/calendar-slots";

const NY = "America/New_York";
/** Tuesday 2026-09-22 in New York (UTC-4): local hh:mm -> a 30-minute slot. */
function local(hhmm: string): Interval {
  const [h, m] = hhmm.split(":").map(Number);
  const start = new Date(Date.UTC(2026, 8, 22, h + 4, m));
  return { start, end: new Date(start.getTime() + 30 * 60_000) };
}

describe("scoreSlot", () => {
  it("rewards a restaurant's quiet afternoon and punishes the rushes", () => {
    expect(scoreSlot(local("14:30"), "restaurant", NY)).toBe(2);
    expect(scoreSlot(local("12:00"), "restaurant", NY)).toBe(-3);
    expect(scoreSlot(local("19:30"), "restaurant", NY)).toBe(-4);
  });

  it("keeps hotels away from check-out and toward midday", () => {
    expect(scoreSlot(local("09:00"), "hotel_motel", NY)).toBe(-3);
    expect(scoreSlot(local("12:00"), "hotel_motel", NY)).toBe(2);
  });

  it("likes contractors before work even though it is early", () => {
    expect(scoreSlot(local("07:00"), "home_services", NY)).toBe(1);
  });

  it("scores in the lead's time zone, not UTC", () => {
    const slot = local("14:30");
    expect(scoreSlot(slot, "restaurant", "America/Los_Angeles")).toBe(-3);
  });
});

describe("suggestSlots", () => {
  const afternoon = ["10:00", "10:30", "14:30", "15:00", "15:30", "16:00", "16:30"].map(local);

  it("picks the best three, at least an hour apart, earliest first on ties", () => {
    const picked = suggestSlots(afternoon, "restaurant", NY).map((slot) => slot.start.toISOString().slice(11, 16));
    expect(picked).toEqual(["18:30", "19:30", "14:00"]);
  });

  it("returns fewer than three when that is all there is", () => {
    expect(suggestSlots([local("14:30"), local("15:00")], "restaurant", NY)).toHaveLength(1);
    expect(suggestSlots([], "other", NY)).toEqual([]);
  });
});
```

(How the expected picks arise, in UTC: 14:30, 15:00, 15:30 and 16:00 local all score +2. 14:30 local (18:30Z) is picked; 15:00 is within an hour of it; 15:30 local (19:30Z) is exactly an hour later and is picked; 16:00 is within an hour of that. The rest score 0 — including 16:30, whose half-open end at 17:00 does not overlap the 17:00 avoid window — and the earliest of them, 10:00 local (14:00Z), is picked third. In the second case the two slots are 30 minutes apart, so only one is kept.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/business-rhythm.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/business-rhythm`.

- [ ] **Step 3: Implement** — `src/lib/domain/business-rhythm.ts`:

```ts
// Which open slots suit the lead's day, by business type (docs/DEVIATIONS.md D46). Pure. Hours are minutes of the
// lead's local day, half-open.
import { TZDate } from "@date-fns/tz";
import type { BusinessType } from "./business-type";
import type { Interval } from "./calendar-slots";

type MinuteRange = readonly [number, number];

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

export interface Rhythm {
  avoid: readonly MinuteRange[];
  best: readonly MinuteRange[];
}

export const RHYTHMS: Readonly<Record<BusinessType, Rhythm>> = {
  restaurant: { avoid: [[at(11), at(14)], [at(17), at(21)]], best: [[at(14, 30), at(16, 30)]] },
  cafe_bakery: { avoid: [[at(6, 30), at(10, 30)], [at(11, 30), at(13, 30)]], best: [[at(14), at(16)]] },
  hotel_motel: { avoid: [[at(7), at(11)], [at(15), at(18)]], best: [[at(11), at(14, 30)]] },
  home_services: { avoid: [[at(8), at(16)]], best: [[at(7), at(8)], [at(16, 30), at(18)]] },
  auto: { avoid: [[at(8), at(10)], [at(16), at(18)]], best: [[at(12, 30), at(15)]] },
  retail: { avoid: [[at(12), at(14)]], best: [[at(9, 30), at(11, 30)]] },
  beauty: { avoid: [[at(10), at(16)]], best: [[at(9), at(10)], [at(16), at(17, 30)]] },
  other: { avoid: [[at(12), at(13)]], best: [[at(10), at(11, 30)], [at(14), at(16)]] },
};

/** Outside these local hours a business meeting is a stretch, whatever the type. */
export const REASONABLE_HOURS: MinuteRange = [at(8), at(19)];
export const SUGGESTION_COUNT = 3;
export const SUGGESTION_SPREAD_MS = 60 * 60_000;

function localMinutes(date: Date, timeZone: string): number {
  const zoned = new TZDate(date.getTime(), timeZone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/** +2 entirely inside a best window, -3 overlapping an avoid window, -1 partly outside reasonable hours. */
export function scoreSlot(slot: Interval, type: BusinessType, timeZone: string): number {
  const start = localMinutes(slot.start, timeZone);
  const end = start + Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000);
  const rhythm = RHYTHMS[type];
  let score = 0;
  if (rhythm.best.some(([from, to]) => from <= start && end <= to)) score += 2;
  if (rhythm.avoid.some(([from, to]) => start < to && from < end)) score -= 3;
  if (start < REASONABLE_HOURS[0] || end > REASONABLE_HOURS[1]) score -= 1;
  return score;
}

/** Highest score first, earliest first on ties, and no two picks starting within an hour of each other. */
export function suggestSlots(slots: readonly Interval[], type: BusinessType, timeZone: string): Interval[] {
  const ranked = slots
    .map((slot) => ({ slot, score: scoreSlot(slot, type, timeZone) }))
    .sort((a, b) => b.score - a.score || a.slot.start.getTime() - b.slot.start.getTime());
  const picked: Interval[] = [];
  for (const { slot } of ranked) {
    const farEnough = picked.every((other) => Math.abs(other.start.getTime() - slot.start.getTime()) >= SUGGESTION_SPREAD_MS);
    if (farEnough) picked.push(slot);
    if (picked.length === SUGGESTION_COUNT) break;
  }
  return picked;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/domain/business-rhythm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/business-rhythm.ts tests/unit/domain/business-rhythm.test.ts
git commit -m "feat: rank open slots by the lead's business rhythm" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Phrasing a slot the way an agent says it

**Files:**
- Create: `src/lib/domain/slot-phrase.ts`
- Test: `tests/unit/domain/slot-phrase.test.ts`

**Interfaces:**
- Produces: `phraseTime(date: Date, timeZone: string): string`; `phraseSlot(start: Date, timeZone: string, now: Date): string`; `zoneAbbreviation(date: Date, timeZone: string): string`; `yourTimeLine(start: Date, leadTimeZone: string, agentTimeZone: string): string | null`

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/slot-phrase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { phraseSlot, phraseTime, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";

const NY = "America/New_York";
const NOW = new Date("2026-09-17T14:00:00Z"); // Thursday 10:00 EDT

describe("phraseSlot", () => {
  it.each([
    ["2026-09-17T20:30:00Z", "Today at 4:30 pm"],
    ["2026-09-18T21:00:00Z", "Tomorrow at 5 pm"],
    ["2026-09-21T14:00:00Z", "Monday at 10 am"],
    ["2026-09-24T16:00:00Z", "Thu, Sep 24 at noon"],
    ["2026-09-19T04:00:00Z", "Saturday at midnight"],
  ])("%s reads as %s", (iso, phrase) => {
    expect(phraseSlot(new Date(iso), NY, NOW)).toBe(phrase);
  });

  it("counts days on the lead's calendar, not UTC", () => {
    const lateEvening = new Date("2026-09-18T03:30:00Z"); // 23:30 EDT on Sep 17
    expect(phraseSlot(new Date("2026-09-18T13:00:00Z"), NY, lateEvening)).toBe("Tomorrow at 9 am");
  });
});

describe("phraseTime", () => {
  it("drops :00 on the hour and keeps minutes otherwise", () => {
    expect(phraseTime(new Date("2026-09-17T13:00:00Z"), NY)).toBe("9 am");
    expect(phraseTime(new Date("2026-09-17T13:30:00Z"), NY)).toBe("9:30 am");
  });
});

describe("zoneAbbreviation", () => {
  it("names US zones and follows the clock change", () => {
    expect(zoneAbbreviation(new Date("2026-09-17T14:00:00Z"), NY)).toBe("EDT");
    expect(zoneAbbreviation(new Date("2026-09-17T14:00:00Z"), "America/Chicago")).toBe("CDT");
    expect(zoneAbbreviation(new Date("2026-11-02T14:00:00Z"), NY)).toBe("EST");
  });
});

describe("yourTimeLine", () => {
  const five = new Date("2026-09-18T21:00:00Z");

  it("is empty when agent and lead share the offset", () => {
    expect(yourTimeLine(five, NY, "America/Detroit")).toBeNull();
  });

  it("gives the agent's own clock otherwise", () => {
    expect(yourTimeLine(five, NY, "America/Los_Angeles")).toBe("(2 pm your time)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/slot-phrase.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/slot-phrase`.

- [ ] **Step 3: Implement** — `src/lib/domain/slot-phrase.ts`:

```ts
// A slot phrased the way an agent says it on the call — "Tomorrow at 5 pm" — in the lead's time zone
// (docs/DEVIATIONS.md D46). Pure.
import { TZDate, tzOffset } from "@date-fns/tz";
import { formatInTz } from "./time";

/** Days since the epoch for the calendar date `date` falls on in `timeZone`. */
function calendarDay(date: Date, timeZone: string): number {
  const zoned = new TZDate(date.getTime(), timeZone);
  return Math.floor(Date.UTC(zoned.getFullYear(), zoned.getMonth(), zoned.getDate()) / 86_400_000);
}

/** "5 pm", "4:30 pm", "noon", "midnight". */
export function phraseTime(date: Date, timeZone: string): string {
  const zoned = new TZDate(date.getTime(), timeZone);
  const hours = zoned.getHours();
  const minutes = zoned.getMinutes();
  if (minutes === 0 && hours === 12) return "noon";
  if (minutes === 0 && hours === 0) return "midnight";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? "am" : "pm";
  return minutes === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** Today / Tomorrow / weekday within six days / "Mon, Sep 29" beyond, all on the lead's calendar. */
export function phraseSlot(start: Date, timeZone: string, now: Date): string {
  const days = calendarDay(start, timeZone) - calendarDay(now, timeZone);
  const time = phraseTime(start, timeZone);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days >= 2 && days <= 6) return `${formatInTz(start, timeZone, "EEEE")} at ${time}`;
  return `${formatInTz(start, timeZone, "EEE, MMM d")} at ${time}`;
}

/** "EDT", "CST"; zones without a common abbreviation come back as "GMT+1" and similar. */
export function zoneAbbreviation(date: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((piece) => piece.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** "(2 pm your time)" when the agent's clock differs from the lead's at that moment, else null. */
export function yourTimeLine(start: Date, leadTimeZone: string, agentTimeZone: string): string | null {
  if (tzOffset(leadTimeZone, start) === tzOffset(agentTimeZone, start)) return null;
  return `(${phraseTime(start, agentTimeZone)} your time)`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/domain/slot-phrase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/slot-phrase.ts tests/unit/domain/slot-phrase.test.ts
git commit -m "feat: phrase a slot as the agent would say it, in the lead's time" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Calendar driver, client interface, mock calendar and event text

**Files:**
- Modify: `src/server/env.ts`
- Create: `src/server/calendar/types.ts`, `src/server/calendar/mock.ts`, `src/server/calendar/client.ts`
- Create: `src/lib/domain/meeting-description.ts`
- Test: `tests/unit/calendar/calendar-driver.test.ts`, `tests/unit/calendar/mock-calendar.test.ts`, `tests/unit/domain/meeting-description.test.ts`

**Interfaces:**
- Produces:
  - `CALENDAR_DRIVERS = ["google", "mock"]`, `type CalendarDriver`, `getCalendarDriver(env?: ServerEnv): CalendarDriver | "unavailable"` (explicit value wins; unset is `mock` outside production and `unavailable` in production)
  - `interface CalendarInterval { start: Date; end: Date }`
  - `interface CalendarAvailability { windows: CalendarInterval[]; busy: CalendarInterval[] }`
  - `interface CalendarClient { readAvailability(range: { from: Date; to: Date }): Promise<CalendarAvailability>; createMeeting(input: { start: Date; end: Date; title: string; description: string }): Promise<{ eventId: string }> }`
  - `createMockCalendar(timeZone: string): CalendarClient`, `resetMockCalendar(): void`
  - `resolveCalendarClient(timeZone: string, env?: ServerEnv): CalendarClient | null` (Plan 2 adds the Google branch)
  - `meetingTitle(businessName: string): string`, `buildMeetingDescription(input: MeetingDescriptionInput): string`

- [ ] **Step 1: Write the failing tests**

`tests/unit/calendar/calendar-driver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getCalendarDriver, parseServerEnv } from "@/server/env";

const BASE = {
  NODE_ENV: "development",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
};

describe("CALENDAR_DRIVER", () => {
  it("defaults to the mock calendar outside production and to unavailable in production", () => {
    expect(getCalendarDriver(parseServerEnv(BASE))).toBe("mock");
    expect(getCalendarDriver(parseServerEnv({ ...BASE, NODE_ENV: "production" }))).toBe("unavailable");
  });

  it("uses an explicit value, case-insensitively", () => {
    expect(getCalendarDriver(parseServerEnv({ ...BASE, CALENDAR_DRIVER: " Google " }))).toBe("google");
  });

  it("refuses the mock calendar in production", () => {
    expect(() => parseServerEnv({ ...BASE, NODE_ENV: "production", CALENDAR_DRIVER: "mock" })).toThrow(/CALENDAR_DRIVER must not be mock in production/);
  });

  it("rejects an unknown driver", () => {
    expect(() => parseServerEnv({ ...BASE, CALENDAR_DRIVER: "outlook" })).toThrow(/CALENDAR_DRIVER/);
  });
});
```

`tests/unit/calendar/mock-calendar.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createMockCalendar, resetMockCalendar } from "@/server/calendar/mock";

const NY = "America/New_York";
// Monday 2026-09-21 00:00 EDT to Sunday 2026-09-27 00:00 EDT.
const WEEK = { from: new Date("2026-09-21T04:00:00Z"), to: new Date("2026-09-27T04:00:00Z") };

beforeEach(() => resetMockCalendar());

describe("mock calendar", () => {
  it("offers 10-12 and 14-17 on weekdays only, in the closer's zone", async () => {
    const { windows } = await createMockCalendar(NY).readAvailability(WEEK);
    expect(windows).toHaveLength(10);
    expect(windows[0]).toEqual({ start: new Date("2026-09-21T14:00:00Z"), end: new Date("2026-09-21T16:00:00Z") });
    expect(windows[1]).toEqual({ start: new Date("2026-09-21T18:00:00Z"), end: new Date("2026-09-21T21:00:00Z") });
  });

  it("returns busy time as bare start and end, and counts meetings it created", async () => {
    const calendar = createMockCalendar(NY);
    const before = await calendar.readAvailability(WEEK);
    expect(before.busy).toHaveLength(10);
    for (const block of before.busy) expect(Object.keys(block).sort()).toEqual(["end", "start"]);

    const start = new Date("2026-09-22T14:30:00Z");
    const { eventId } = await calendar.createMeeting({ start, end: new Date("2026-09-22T15:00:00Z"), title: "Meeting: Swan Motel", description: "x" });
    expect(eventId).toMatch(/^mock-event-/);
    const after = await createMockCalendar(NY).readAvailability(WEEK);
    expect(after.busy).toHaveLength(11);
    expect(JSON.stringify(after)).not.toContain("SECRET");
    expect(JSON.stringify(after)).not.toContain("Swan Motel");
  });
});
```

`tests/unit/domain/meeting-description.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMeetingDescription, meetingTitle } from "@/lib/domain/meeting-description";

describe("meeting text", () => {
  it("titles the event after the business", () => {
    expect(meetingTitle("Swan Motel")).toBe("Meeting: Swan Motel");
  });

  it("puts everything the closer needs in the description", () => {
    expect(
      buildMeetingDescription({
        businessName: "Kompose Hotel Sarasota",
        contactName: "Erica",
        phone: "+19413301160",
        city: "Sarasota",
        state: "FL",
        bookedBy: "Casey Morgan",
        note: "Wants the OTA fix",
        leadUrl: "https://crm.example.com/leads/abc",
      }),
    ).toBe(
      [
        "Contact: Erica",
        "Phone: (941) 330-1160 (+19413301160)",
        "Location: Sarasota, FL",
        "Booked by Casey Morgan",
        "Note: Wants the OTA fix",
        "Lead: https://crm.example.com/leads/abc",
      ].join("\n"),
    );
  });

  it("leaves out what is missing", () => {
    expect(
      buildMeetingDescription({ businessName: "X", contactName: null, phone: "+19413301160", city: null, state: null, bookedBy: "Casey", note: null, leadUrl: null }),
    ).toBe("Phone: (941) 330-1160 (+19413301160)\nBooked by Casey");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/unit/calendar tests/unit/domain/meeting-description.test.ts`
Expected: FAIL — `getCalendarDriver` is not exported; the calendar and description modules do not exist.

- [ ] **Step 3: Add the driver to `src/server/env.ts`**

After the line `export type DialerDriver = (typeof DIALER_DRIVERS)[number];` add:

```ts
export const CALENDAR_DRIVERS = ["google", "mock"] as const;
export type CalendarDriver = (typeof CALENDAR_DRIVERS)[number];
```

In `serverEnvSchema`'s `.extend({ ... })`, directly after the closing `),` of the `DIALER_DRIVER: z.preprocess(` entry, add:

```ts
    CALENDAR_DRIVER: z.preprocess(
      (value) => (typeof value === "string" ? blankToUndefined(value.trim().toLowerCase()) : value),
      z.enum(CALENDAR_DRIVERS).optional(),
    ),
```

In `.superRefine`, directly before the line `    if (env.DIALER_DRIVER !== "twilio") return;` add:

```ts
    if (env.CALENDAR_DRIVER === "mock" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["CALENDAR_DRIVER"],
        message: "must not be mock in production (the mock calendar invents availability)",
      });
    }
```

In `readProcessEnv()`, directly after `    DIALER_DRIVER: process.env.DIALER_DRIVER,` add:

```ts
    CALENDAR_DRIVER: process.env.CALENDAR_DRIVER,
```

After the `getDialerDriver` function add:

```ts
/**
 * Which calendar booking uses (docs/DEVIATIONS.md D46): an explicit CALENDAR_DRIVER, else the mock calendar in
 * development and tests. Production without a driver has no calendar, so booking reports itself unavailable.
 */
export function getCalendarDriver(env: ServerEnv = getServerEnv()): CalendarDriver | "unavailable" {
  if (env.CALENDAR_DRIVER) return env.CALENDAR_DRIVER;
  return env.NODE_ENV === "production" ? "unavailable" : "mock";
}
```

- [ ] **Step 4: Create the client interface** — `src/server/calendar/types.ts`:

```ts
// The calendar booking reads and writes (docs/DEVIATIONS.md D46). Implementations: mock.ts now, Google in Plan 2.
//
// Contract: readAvailability returns start and end times only. An implementation must never pass through an
// event's title, description or attendees; the availability service rebuilds every interval regardless.

export interface CalendarInterval {
  start: Date;
  end: Date;
}

export interface CalendarAvailability {
  /** Bookable windows (events on the closer's bookable-hours calendar) overlapping the range. */
  windows: CalendarInterval[];
  /** Busy time on the closer's main calendar overlapping the range. */
  busy: CalendarInterval[];
}

export interface CalendarClient {
  readAvailability(range: { from: Date; to: Date }): Promise<CalendarAvailability>;
  createMeeting(input: { start: Date; end: Date; title: string; description: string }): Promise<{ eventId: string }>;
}
```

- [ ] **Step 5: Create the mock calendar** — `src/server/calendar/mock.ts`:

```ts
import "server-only";
import { endOfDayInTz, formatInTz, startOfDayInTz, zonedLocalInputToUtc } from "@/lib/domain/time";
import type { CalendarAvailability, CalendarClient, CalendarInterval } from "./types";

// In-memory calendar for development, tests and Playwright (CALENDAR_DRIVER=mock). Refused in production by
// src/server/env.ts. Meetings it creates live for the life of the server process.

interface MockEvent extends CalendarInterval {
  id: string;
  title: string;
}

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["10:00", "12:00"],
  ["14:00", "17:00"],
];

// Titled on purpose: the privacy tests prove these words never reach an agent.
const SEEDED_BUSY: ReadonlyArray<readonly [string, string, string]> = [
  ["11:00", "11:30", "SECRET: dentist"],
  ["15:00", "16:00", "SECRET: school run"],
];

const created: MockEvent[] = [];
let sequence = 0;

export function resetMockCalendar(): void {
  created.length = 0;
  sequence = 0;
}

function weekdays(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = [];
  for (let day = startOfDayInTz(timeZone, from); day < to; day = endOfDayInTz(timeZone, day)) {
    if (Number(formatInTz(day, timeZone, "i")) <= 5) days.push(formatInTz(day, timeZone, "yyyy-MM-dd"));
  }
  return days;
}

function overlaps(interval: CalendarInterval, from: Date, to: Date): boolean {
  return interval.start < to && interval.end > from;
}

export function createMockCalendar(timeZone: string): CalendarClient {
  const at = (date: string, time: string) => zonedLocalInputToUtc(`${date}T${time}`, timeZone);

  return {
    async readAvailability({ from, to }): Promise<CalendarAvailability> {
      const days = weekdays(from, to, timeZone);
      const windows = days.flatMap((date) => WINDOWS.map(([start, end]) => ({ start: at(date, start), end: at(date, end) })));
      const seeded: MockEvent[] = days.flatMap((date) =>
        SEEDED_BUSY.map(([start, end, title], index) => ({ id: `mock-busy-${date}-${index}`, title, start: at(date, start), end: at(date, end) })),
      );
      return {
        windows: windows.filter((window) => overlaps(window, from, to)),
        busy: [...seeded, ...created]
          .filter((event) => overlaps(event, from, to))
          .map((event) => ({ start: event.start, end: event.end })),
      };
    },

    async createMeeting({ start, end, title }) {
      sequence += 1;
      const id = `mock-event-${sequence}`;
      created.push({ id, title, start, end });
      return { eventId: id };
    },
  };
}
```

- [ ] **Step 6: Create the resolver** — `src/server/calendar/client.ts`:

```ts
import "server-only";
import { getCalendarDriver, type ServerEnv } from "@/server/env";
import { createMockCalendar } from "./mock";
import type { CalendarClient } from "./types";

/**
 * The calendar for the configured driver, or null when booking is unavailable (no driver in production, an invalid
 * environment, or the Google driver before Plan 2 adds it). `timeZone` is the closer's zone for the mock calendar.
 */
export function resolveCalendarClient(timeZone: string, env?: ServerEnv): CalendarClient | null {
  let driver: ReturnType<typeof getCalendarDriver>;
  try {
    driver = getCalendarDriver(env);
  } catch {
    return null;
  }
  return driver === "mock" ? createMockCalendar(timeZone) : null;
}
```

- [ ] **Step 7: Create the event text** — `src/lib/domain/meeting-description.ts`:

```ts
// Title and description of the meeting event on the closer's calendar (docs/DEVIATIONS.md D46). The closer confirms
// with the lead personally, so the phone number is always there.
import { formatPhoneDisplay } from "./phone";

export interface MeetingDescriptionInput {
  businessName: string;
  contactName: string | null;
  phone: string;
  city: string | null;
  state: string | null;
  bookedBy: string;
  note: string | null;
  leadUrl: string | null;
}

export function meetingTitle(businessName: string): string {
  return `Meeting: ${businessName}`;
}

export function buildMeetingDescription(input: MeetingDescriptionInput): string {
  const place = [input.city, input.state].filter((part): part is string => !!part && part.trim() !== "").join(", ");
  return [
    input.contactName ? `Contact: ${input.contactName}` : null,
    `Phone: ${formatPhoneDisplay(input.phone)} (${input.phone})`,
    place ? `Location: ${place}` : null,
    `Booked by ${input.bookedBy}`,
    input.note ? `Note: ${input.note}` : null,
    input.leadUrl ? `Lead: ${input.leadUrl}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
```

If `formatPhoneDisplay` in `src/lib/domain/phone.ts` formats `+19413301160` differently from `(941) 330-1160`, change the two expected strings in the test to that function's actual output rather than changing the function.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/unit/calendar tests/unit/domain/meeting-description.test.ts tests/unit/server/env.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/env.ts src/server/calendar src/lib/domain/meeting-description.ts tests/unit/calendar tests/unit/domain/meeting-description.test.ts
git commit -m "feat: calendar client interface, mock calendar and CALENDAR_DRIVER" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Availability service with the privacy boundary

**Files:**
- Create: `src/lib/domain/booking-messages.ts`
- Modify: `src/server/errors.ts`
- Create: `src/server/services/calendar-booking.ts` (availability half)
- Test: `tests/integration/calendar/availability.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces in `src/lib/domain/booking-messages.ts` (client-safe, shared by the service and the panel, compared by exact equality — never by prefix): `BOOKING_UNAVAILABLE_MESSAGE`, `CALENDAR_LOAD_FAILED_MESSAGE`, `SLOT_TAKEN_MESSAGE`, `BOOKING_FAILED_MESSAGE`, `STATUS_NOT_UPDATED_MESSAGE`.
- Produces (in `src/server/services/calendar-booking.ts`):
  - `interface CalendarDeps { calendar?: CalendarClient | null; now?: () => Date }` — `calendar: undefined` means "use the configured driver" (with the 60-second cache); `null` means "no calendar".
  - `interface SlotView { start: string; end: string; day: string; phrase: string; zone: string; yourTime: string | null }`
  - `interface IntervalView { start: string; end: string }`
  - `interface MyMeetingView extends IntervalView { id: string; leadId: string; businessName: string }`
  - `interface AgentAvailability { leadId; businessName; businessType: BusinessType; businessTypeIsGuess: boolean; leadTimeZone: string; leadTimeZoneIsGuess: boolean; zone: string; now: string; suggestions: SlotView[]; slots: SlotView[]; busy: IntervalView[]; mine: MyMeetingView[] }`
  - `getAgentAvailability(ctx: RequestContext | null, leadId: unknown, deps?: CalendarDeps): Promise<AgentAvailability>`
  - In `src/server/errors.ts`: `ConflictReason` gains `"slot_taken"`.

- [ ] **Step 1: Write the failing integration test** — `tests/integration/calendar/availability.test.ts`:

```ts
// Availability through the service layer with real sessions (docs/DEVIATIONS.md D46): slots and busy time come back
// as bare times, event titles never do, and another agent's booking vanishes from the picker at once.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CalendarClient, CalendarInterval } from '@/server/calendar/types';
import type { RequestContext } from '@/server/context';
import { getAgentAvailability } from '@/server/services/calendar-booking';
import { contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

const TAG = `AVL${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
// Monday 2032-03-01 13:00Z (08:00 EST). Far from any other suite's bookings.
const NOW = new Date(Date.UTC(2032, 2, 1, 13, 0));

/** A deliberately sloppy client: busy entries carry a summary, as a raw Google event would. */
function leakyCalendar(windows: CalendarInterval[], busy: Array<CalendarInterval & { summary: string }>): CalendarClient {
  return {
    async readAvailability() {
      return { windows, busy };
    },
    async createMeeting() {
      return { eventId: `evt-${randomUUID()}` };
    },
  };
}

const hours = (from: number, to: number): CalendarInterval => ({ start: new Date(NOW.getTime() + from * HOUR), end: new Date(NOW.getTime() + to * HOUR) });

let agent: FixtureUser;
let ctx: RequestContext;

beforeAll(async () => {
  agent = await createUser({ name: `Avail Agent ${TAG}` });
  ctx = await contextForUser(agent);
});

describe('getAgentAvailability', () => {
  it('returns slots and anonymous busy time, never an event title', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Pizzeria`, state: 'FL', country: 'US' });
    const calendar = leakyCalendar([hours(3, 8)], [{ ...hours(4, 5), summary: 'SECRET: dentist' }]);

    const availability = await getAgentAvailability(ctx, lead.id, { calendar, now: () => NOW });

    expect(JSON.stringify(availability)).not.toContain('SECRET');
    expect(availability.busy).toContainEqual({ start: hours(4, 5).start.toISOString(), end: hours(4, 5).end.toISOString() });
    const starts = availability.slots.map((slot) => slot.start);
    expect(starts).toContain(hours(3, 3.5).start.toISOString());
    expect(starts).not.toContain(hours(4, 4.5).start.toISOString());
    expect(availability).toMatchObject({ businessType: 'restaurant', businessTypeIsGuess: true, leadTimeZone: 'America/New_York', leadTimeZoneIsGuess: false });
    expect(availability.suggestions.length).toBeGreaterThan(0);
    expect(availability.suggestions.length).toBeLessThanOrEqual(3);
    expect(availability.slots[0].phrase).toMatch(/^Today at /);
  });

  it('answers not_found for a lead the agent cannot see, and unavailable without a calendar', async () => {
    const other = await createUser({ name: `Avail Other ${TAG}` });
    const theirs = await createLead({ assigned_to: other.id, business_name: `${TAG} Theirs` });
    await expect(getAgentAvailability(ctx, theirs.id, { calendar: leakyCalendar([], []), now: () => NOW })).rejects.toMatchObject({ code: 'not_found' });

    const mine = await createLead({ assigned_to: agent.id, business_name: `${TAG} Mine` });
    await expect(getAgentAvailability(ctx, mine.id, { calendar: null, now: () => NOW })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports a calendar that fails to load as unavailable', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Failing` });
    const broken: CalendarClient = {
      async readAvailability() {
        throw new Error('google down');
      },
      async createMeeting() {
        throw new Error('unused');
      },
    };
    await expect(getAgentAvailability(ctx, lead.id, { calendar: broken, now: () => NOW })).rejects.toMatchObject({ code: 'unavailable', message: "Couldn't load the calendar. Try again." });
  });
});
```

The cross-agent case ("another agent's booking vanishes at once") needs `bookAppointment` and is covered in Task 10.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project integration tests/integration/calendar/availability.test.ts`
Expected: FAIL — cannot resolve `@/server/services/calendar-booking`.

- [ ] **Step 3a: Create the shared messages** — `src/lib/domain/booking-messages.ts`:

```ts
// Messages the booking service raises and the booking panel recognises (docs/DEVIATIONS.md D46). Client-safe: no
// server imports, so the panel compares against these exact strings instead of matching text.

export const BOOKING_UNAVAILABLE_MESSAGE = "Booking isn't available right now. Schedule a follow-up instead.";
export const CALENDAR_LOAD_FAILED_MESSAGE = "Couldn't load the calendar. Try again.";
export const SLOT_TAKEN_MESSAGE = "That time was just taken. Pick another.";
export const BOOKING_FAILED_MESSAGE = "Couldn't book the meeting. Nothing was saved. Try again.";
export const STATUS_NOT_UPDATED_MESSAGE = "Booked, but the lead's status didn't change. Set it to Appointment by hand.";
```

- [ ] **Step 3b: Add the conflict reason** — in `src/server/errors.ts`, add the import

```ts
import { SLOT_TAKEN_MESSAGE } from "@/lib/domain/booking-messages";
```

and then:

Replace

```ts
export type ConflictReason = "do_not_contact" | "call_in_progress";
```

with

```ts
export type ConflictReason = "do_not_contact" | "call_in_progress" | "slot_taken";
```

In `CONFLICT_MESSAGES`, after `  call_in_progress: "You already have a call in progress.",` add:

```ts
  slot_taken: SLOT_TAKEN_MESSAGE,
```

In `mapPostgrestError`, replace

```ts
      if (message === "do_not_contact" || message === "call_in_progress") {
```

with

```ts
      if (message === "do_not_contact" || message === "call_in_progress" || message === "slot_taken") {
```

- [ ] **Step 4: Create the availability half of the service** — `src/server/services/calendar-booking.ts`:

```ts
// Closer calendar booking (docs/DEVIATIONS.md D46). Every query runs with the caller's session: appointments are read
// under RLS and written only through the guarded RPCs in 20260915001900_calendar_booking.sql.
//
// Privacy boundary: nothing from a calendar reaches the browser except start and end times. Intervals are rebuilt
// field by field below, so a client that hands back more (a title, attendees) still cannot leak it.
import { z } from "zod";
import { suggestSlots } from "@/lib/domain/business-rhythm";
import { BOOKING_UNAVAILABLE_MESSAGE, CALENDAR_LOAD_FAILED_MESSAGE } from "@/lib/domain/booking-messages";
import { resolveBusinessType, type BusinessType } from "@/lib/domain/business-type";
import { BOOKING_HORIZON_DAYS, freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { phraseSlot, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import { formatInTz } from "@/lib/domain/time";
import { resolveCalendarClient } from "@/server/calendar/client";
import type { CalendarClient } from "@/server/calendar/types";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";

const CACHE_TTL_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CalendarDeps {
  /** undefined: the configured driver (cached). null: no calendar. A client: that client, never cached. */
  calendar?: CalendarClient | null;
  now?: () => Date;
}

export interface SlotView {
  start: string;
  end: string;
  /** yyyy-MM-dd on the lead's calendar. */
  day: string;
  phrase: string;
  zone: string;
  yourTime: string | null;
}

export interface IntervalView {
  start: string;
  end: string;
}

export interface MyMeetingView extends IntervalView {
  id: string;
  leadId: string;
  businessName: string;
}

export interface AgentAvailability {
  leadId: string;
  businessName: string;
  businessType: BusinessType;
  businessTypeIsGuess: boolean;
  leadTimeZone: string;
  leadTimeZoneIsGuess: boolean;
  /** Abbreviation of the lead's zone right now, e.g. "EDT". */
  zone: string;
  now: string;
  suggestions: SlotView[];
  slots: SlotView[];
  busy: IntervalView[];
  mine: MyMeetingView[];
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

const uuidSchema = z.uuid();

/** Malformed ids get the same answer as ids that do not exist. */
function parseId(value: unknown): string {
  const parsed = uuidSchema.safeParse(typeof value === "string" ? value.trim().toLowerCase() : value);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

async function defaultCalendar(ctx: RequestContext): Promise<CalendarClient | null> {
  const { data } = await ctx.supabase.from("settings").select("default_timezone").limit(1).maybeSingle();
  return resolveCalendarClient(data?.default_timezone ?? "America/New_York");
}

export async function calendarFor(ctx: RequestContext, deps: CalendarDeps): Promise<CalendarClient> {
  const calendar = deps.calendar !== undefined ? deps.calendar : await defaultCalendar(ctx);
  if (!calendar) throw new AppError("unavailable", BOOKING_UNAVAILABLE_MESSAGE);
  return calendar;
}

// Best effort and per server instance: correctness comes from the re-check when booking.
let cache: { key: string; expires: number; windows: Interval[]; busy: Interval[] } | null = null;

export function clearAvailabilityCacheForTests(): void {
  cache = null;
}

export async function readCalendar(
  calendar: CalendarClient,
  from: Date,
  to: Date,
  useCache: boolean,
): Promise<{ windows: Interval[]; busy: Interval[] }> {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  if (useCache && cache && cache.key === key && cache.expires > Date.now()) {
    return { windows: cache.windows, busy: cache.busy };
  }
  let read: Awaited<ReturnType<CalendarClient["readAvailability"]>>;
  try {
    read = await calendar.readAvailability({ from, to });
  } catch (error) {
    throw new AppError("unavailable", CALENDAR_LOAD_FAILED_MESSAGE, { cause: error });
  }
  const windows = read.windows.map((window) => ({ start: new Date(window.start), end: new Date(window.end) }));
  const busy = read.busy.map((block) => ({ start: new Date(block.start), end: new Date(block.end) }));
  if (useCache) cache = { key, expires: Date.now() + CACHE_TTL_MS, windows, busy };
  return { windows, busy };
}

async function myMeetings(ctx: RequestContext, now: Date): Promise<MyMeetingView[]> {
  const { data, error } = await ctx.supabase
    .from("appointments")
    .select("id, lead_id, starts_at, ends_at")
    .eq("booked_by", ctx.userId)
    .eq("status", "scheduled")
    .gt("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(200);
  if (error) fail(error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: leads, error: leadsError } = await ctx.supabase
    .from("leads")
    .select("id, business_name")
    .in("id", [...new Set(rows.map((row) => row.lead_id))]);
  if (leadsError) fail(leadsError);
  const names = new Map((leads ?? []).map((lead) => [lead.id, lead.business_name]));
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    start: new Date(row.starts_at).toISOString(),
    end: new Date(row.ends_at).toISOString(),
    businessName: names.get(row.lead_id) ?? "A lead no longer assigned to you",
  }));
}

export async function getAgentAvailability(
  ctx: RequestContext | null,
  leadId: unknown,
  deps: CalendarDeps = {},
): Promise<AgentAvailability> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const { data: lead, error } = await active.supabase
    .from("leads")
    .select("id, business_name, state, country, business_type")
    .eq("id", id)
    .maybeSingle();
  if (error) fail(error);
  if (!lead) throw new AppError("not_found");

  const calendar = await calendarFor(active, deps);
  const now = deps.now?.() ?? new Date();
  // Whole-hour range: requests within the same hour share one cache entry.
  const from = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const to = new Date(from.getTime() + (BOOKING_HORIZON_DAYS + 1) * DAY_MS);
  const read = await readCalendar(calendar, from, to, deps.calendar === undefined);

  const { data: booked, error: bookedError } = await active.supabase.rpc("booked_intervals", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (bookedError) fail(bookedError);

  const busy = mergeIntervals([
    ...read.busy,
    ...(booked ?? []).map((row) => ({ start: new Date(row.starts_at), end: new Date(row.ends_at) })),
  ]);
  const slots = freeSlots({ windows: read.windows, busy, now });

  const { type, isGuess } = resolveBusinessType(lead.business_type, lead.business_name);
  const zone = leadTimeZone({ state: lead.state, country: lead.country }, active.profile.timezone);
  const view = (slot: Interval): SlotView => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    day: formatInTz(slot.start, zone.timeZone, "yyyy-MM-dd"),
    phrase: phraseSlot(slot.start, zone.timeZone, now),
    zone: zoneAbbreviation(slot.start, zone.timeZone),
    yourTime: yourTimeLine(slot.start, zone.timeZone, active.profile.timezone),
  });

  return {
    leadId: lead.id,
    businessName: lead.business_name,
    businessType: type,
    businessTypeIsGuess: isGuess,
    leadTimeZone: zone.timeZone,
    leadTimeZoneIsGuess: zone.isGuess,
    zone: zoneAbbreviation(now, zone.timeZone),
    now: now.toISOString(),
    suggestions: suggestSlots(slots, type, zone.timeZone).map(view),
    slots: slots.map(view),
    busy: busy.filter((block) => block.end > now).map((block) => ({ start: block.start.toISOString(), end: block.end.toISOString() })),
    mine: await myMeetings(active, now),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/calendar/availability.test.ts`
Expected: PASS. If the regenerated `database.types.ts` gives `booked_intervals` rows a different shape than `{ starts_at: string; ends_at: string }`, adjust only the mapping line, not the RPC.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/lib/domain/booking-messages.ts src/server/errors.ts src/server/services/calendar-booking.ts tests/integration/calendar/availability.test.ts
git commit -m "feat: agent availability from the closer calendar, with titles kept on the server" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Booking, cancelling, business type and next meeting — service and actions

**Files:**
- Modify: `src/server/services/calendar-booking.ts` (booking half)
- Create: `src/server/actions/calendar-booking.ts`
- Test: `tests/integration/calendar/booking.test.ts`

**Interfaces:**
- Consumes: Task 9's `calendarFor`, `readCalendar`, `CalendarDeps`, messages; `updateLeadStatus(ctx, id, status)` from `src/server/services/leads.ts`.
- Produces:
  - `interface BookedAppointment { id: string; leadId: string; start: string; end: string; phrase: string; zone: string; statusNeedsAttention: boolean }` — `statusNeedsAttention` is true only when a booking outside a call could not move the lead to Appointment; the panel then tells the agent to set it by hand.
  - `interface LeadMeeting { id: string; start: string; end: string; bookedByName: string | null }`
  - `bookAppointment(ctx, input: unknown, deps?: CalendarDeps): Promise<BookedAppointment>` where input is `{ leadId: string; start: string (ISO); note?: string | null; clientRequestId: string (uuid); inCall: boolean }`
  - `cancelAppointment(ctx, id: unknown): Promise<{ id: string }>` (admin)
  - `setLeadBusinessType(ctx, leadId: unknown, type: unknown): Promise<{ leadId: string; businessType: BusinessType | null }>`
  - `getNextMeeting(ctx, leadId: unknown, now?: Date): Promise<LeadMeeting | null>`
  - Actions: `getAvailabilityAction(leadId: string)`, `bookAppointmentAction(input: BookAppointmentActionInput)`, `cancelAppointmentAction(id: string)`, `setLeadBusinessTypeAction(leadId: string, type: BusinessType | null)`, each returning `ActionResult<…>`; the three writes call `refresh()` on success.

- [ ] **Step 1: Write the failing integration test** — `tests/integration/calendar/booking.test.ts`:

```ts
// Booking through the service layer with real sessions (docs/DEVIATIONS.md D46): the event is created and the
// appointment confirmed, a replay books once, a slot taken or turned busy is refused and leaves nothing behind, and
// another agent's booking leaves the picker at once without a trace of their lead.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CalendarClient, CalendarInterval } from '@/server/calendar/types';
import type { RequestContext } from '@/server/context';
import {
  bookAppointment,
  cancelAppointment,
  getAgentAvailability,
  getNextMeeting,
  setLeadBusinessType,
} from '@/server/services/calendar-booking';
import { contextFor, contextForUser } from '../../helpers/context';
import { createLead, createUser } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TAG = `BOOK${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const WEEK = 7 * 86_400_000;
// Mondays from 2032-04-12 13:00Z (09:00 EDT). Each test takes its own week, so one live booking per slot never
// collides between tests.
const BASE = Date.UTC(2032, 3, 5, 13, 0);
let week = 0;

function scenario() {
  week += 1;
  const now = new Date(BASE + week * WEEK);
  const at = (hours: number) => new Date(now.getTime() + hours * HOUR);
  const window: CalendarInterval = { start: at(3), end: at(8) };
  return { now, at, window };
}

function fakeCalendar(options: { windows: CalendarInterval[]; busy?: CalendarInterval[]; failCreate?: boolean }) {
  const created: CalendarInterval[] = [];
  const client: CalendarClient = {
    async readAvailability() {
      return { windows: options.windows, busy: [...(options.busy ?? []), ...created] };
    },
    async createMeeting({ start, end }) {
      if (options.failCreate) throw new Error('insert failed');
      created.push({ start, end });
      return { eventId: `evt-${randomUUID()}` };
    },
  };
  return { client, created };
}

async function agentAndLead(name: string, overrides: Parameters<typeof createLead>[0] = {}) {
  const agent = await createUser({ name: `${name} ${TAG}` });
  const ctx = await contextForUser(agent);
  const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} ${name} Motel`, state: 'FL', country: 'US', status: 'NEW', ...overrides });
  return { agent, ctx, lead };
}

async function statusOf(ctx: RequestContext, leadId: string): Promise<string> {
  const { data } = await ctx.supabase.from('leads').select('status').eq('id', leadId).maybeSingle();
  return data?.status ?? '';
}

const request = (leadId: string, start: Date, extra: { inCall?: boolean; clientRequestId?: string; note?: string } = {}) => ({
  leadId,
  start: start.toISOString(),
  note: extra.note ?? null,
  clientRequestId: extra.clientRequestId ?? randomUUID(),
  inCall: extra.inCall ?? false,
});

describe('bookAppointment', () => {
  it('creates the event, schedules the appointment and moves the lead to Appointment', async () => {
    const { ctx, lead } = await agentAndLead('Booker');
    const { now, at, window } = scenario();
    const calendar = fakeCalendar({ windows: [window] });

    const booked = await bookAppointment(ctx, request(lead.id, at(3), { note: 'bring the menu' }), { calendar: calendar.client, now: () => now });

    expect(booked).toMatchObject({ leadId: lead.id, start: at(3).toISOString(), phrase: 'Today at noon', zone: 'EDT', statusNeedsAttention: false });
    expect(calendar.created).toHaveLength(1);
    expect(await statusOf(ctx, lead.id)).toBe('APPOINTMENT');
    expect((await getNextMeeting(ctx, lead.id, now))?.start).toBe(at(3).toISOString());
  });

  it('leaves the status to the logged outcome when booked during a call', async () => {
    const { ctx, lead } = await agentAndLead('InCall');
    const { now, at, window } = scenario();
    await bookAppointment(ctx, request(lead.id, at(3), { inCall: true }), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now });
    expect(await statusOf(ctx, lead.id)).toBe('NEW');
  });

  it('books once for a replayed request', async () => {
    const { ctx, lead } = await agentAndLead('Replay');
    const { now, at, window } = scenario();
    const calendar = fakeCalendar({ windows: [window] });
    const clientRequestId = randomUUID();
    const first = await bookAppointment(ctx, request(lead.id, at(3), { clientRequestId }), { calendar: calendar.client, now: () => now });
    const again = await bookAppointment(ctx, request(lead.id, at(3), { clientRequestId }), { calendar: calendar.client, now: () => now });
    expect(again.id).toBe(first.id);
    expect(calendar.created).toHaveLength(1);
  });

  it("drops another agent's booking from the picker at once, with nothing of their lead", async () => {
    const a = await agentAndLead('First');
    const b = await agentAndLead('Second');
    const { now, at, window } = scenario();
    await bookAppointment(a.ctx, request(a.lead.id, at(3)), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now });

    // B's calendar has not seen the new event yet; booked_intervals covers the gap.
    const availability = await getAgentAvailability(b.ctx, b.lead.id, { calendar: fakeCalendar({ windows: [window] }).client, now: () => now });
    expect(availability.slots.map((slot) => slot.start)).not.toContain(at(3).toISOString());
    expect(JSON.stringify(availability)).not.toContain(a.lead.business_name);
    expect(availability.mine).toEqual([]);
  });

  it('refuses a slot another agent already holds', async () => {
    const a = await agentAndLead('Holder');
    const b = await agentAndLead('Latecomer');
    const { now, at, window } = scenario();
    await bookAppointment(a.ctx, request(a.lead.id, at(4)), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now });
    await expect(
      bookAppointment(b.ctx, request(b.lead.id, at(4)), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now }),
    ).rejects.toMatchObject({ code: 'conflict', message: 'That time was just taken. Pick another.' });
  });

  it('refuses a slot the calendar now shows as busy, and leaves nothing behind', async () => {
    const { ctx, lead } = await agentAndLead('Recheck');
    const { now, at, window } = scenario();
    const busyNow = fakeCalendar({ windows: [window], busy: [{ start: at(3), end: at(3.5) }] });
    await expect(bookAppointment(ctx, request(lead.id, at(3)), { calendar: busyNow.client, now: () => now })).rejects.toMatchObject({ code: 'conflict' });

    const freeAgain = fakeCalendar({ windows: [window] });
    await expect(bookAppointment(ctx, request(lead.id, at(3)), { calendar: freeAgain.client, now: () => now })).resolves.toMatchObject({ start: at(3).toISOString() });
  });

  it('leaves nothing behind when the calendar fails to create the event', async () => {
    const { ctx, lead } = await agentAndLead('Failure');
    const { now, at, window } = scenario();
    await expect(
      bookAppointment(ctx, request(lead.id, at(3)), { calendar: fakeCalendar({ windows: [window], failCreate: true }).client, now: () => now }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bookAppointment(ctx, request(lead.id, at(3)), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now })).resolves.toBeTruthy();
  });

  it('is unavailable without a calendar and validates its input', async () => {
    const { ctx, lead } = await agentAndLead('Checks');
    const { now, at } = scenario();
    await expect(bookAppointment(ctx, request(lead.id, at(3)), { calendar: null, now: () => now })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bookAppointment(ctx, { ...request(lead.id, at(3)), start: 'not a date' }, { calendar: null })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('business type and cancelling', () => {
  it('saves a correction so availability stops guessing, and clears it again', async () => {
    const { ctx, lead } = await agentAndLead('Typed');
    const { now, window } = scenario();
    const calendar = fakeCalendar({ windows: [window] }).client;

    await setLeadBusinessType(ctx, lead.id, 'restaurant');
    expect(await getAgentAvailability(ctx, lead.id, { calendar, now: () => now })).toMatchObject({ businessType: 'restaurant', businessTypeIsGuess: false });
    await setLeadBusinessType(ctx, lead.id, null);
    expect(await getAgentAvailability(ctx, lead.id, { calendar, now: () => now })).toMatchObject({ businessType: 'hotel_motel', businessTypeIsGuess: true });
    await expect(setLeadBusinessType(ctx, lead.id, 'dentist')).rejects.toMatchObject({ code: 'validation' });
  });

  it('lets an admin cancel a meeting, and not an agent', async () => {
    const { ctx, lead } = await agentAndLead('Cancel');
    const { now, at, window } = scenario();
    const booked = await bookAppointment(ctx, request(lead.id, at(5)), { calendar: fakeCalendar({ windows: [window] }).client, now: () => now });

    await expect(cancelAppointment(ctx, booked.id)).rejects.toMatchObject({ code: 'forbidden' });
    const admin = await signInSeeded('admin').then(contextFor);
    await cancelAppointment(admin, booked.id);
    expect(await getNextMeeting(ctx, lead.id, now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project integration tests/integration/calendar/booking.test.ts`
Expected: FAIL — `bookAppointment` is not exported.

- [ ] **Step 3: Extend the service** — in `src/server/services/calendar-booking.ts`, replace the import block at the top of the file with:

```ts
import { z } from "zod";
import { suggestSlots } from "@/lib/domain/business-rhythm";
import {
  BOOKING_FAILED_MESSAGE,
  BOOKING_UNAVAILABLE_MESSAGE,
  CALENDAR_LOAD_FAILED_MESSAGE,
  SLOT_TAKEN_MESSAGE,
} from "@/lib/domain/booking-messages";
import { isBusinessType, resolveBusinessType, type BusinessType } from "@/lib/domain/business-type";
import { BOOKING_HORIZON_DAYS, SLOT_MS, freeSlots, mergeIntervals, type Interval } from "@/lib/domain/calendar-slots";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { buildMeetingDescription, meetingTitle } from "@/lib/domain/meeting-description";
import { phraseSlot, yourTimeLine, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import type { LeadStatus } from "@/lib/domain/statuses";
import { formatInTz } from "@/lib/domain/time";
import { resolveCalendarClient } from "@/server/calendar/client";
import type { CalendarClient } from "@/server/calendar/types";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { getServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { updateLeadStatus } from "@/server/services/leads";
```

Then append to the end of the file:

```ts
// ---------------------------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------------------------

const MAX_NOTE_LENGTH = 500;
/** Booking never moves a lead backwards or out of Do Not Contact (compare NO_DOWNGRADE_STATUSES in outcomes.ts). */
const KEEP_STATUS_ON_BOOKING: readonly LeadStatus[] = ["APPOINTMENT", "PROPOSAL", "CLIENT", "DO_NOT_CONTACT"];

export interface BookedAppointment {
  id: string;
  leadId: string;
  start: string;
  end: string;
  phrase: string;
  zone: string;
  /** True when a booking outside a call could not move the lead to Appointment. */
  statusNeedsAttention: boolean;
}

export interface LeadMeeting {
  id: string;
  start: string;
  end: string;
  /** Admins only; null for agents. */
  bookedByName: string | null;
}

const bookSchema = z.object({
  leadId: z.string(),
  start: z.iso.datetime({ offset: true, message: "Pick a time from the calendar." }),
  note: z
    .string()
    .trim()
    .max(MAX_NOTE_LENGTH, `A note for the closer can be at most ${MAX_NOTE_LENGTH} characters.`)
    .nullish(),
  clientRequestId: z.uuid(),
  inCall: z.boolean(),
});

/**
 * Runs only on a path that is already failing, so the original error stays the one the agent sees. A failure here
 * is logged (ids and code only) and is harmless: begin_appointment clears a pending row once it is ten minutes old.
 */
async function abandon(ctx: RequestContext, appointmentId: string): Promise<void> {
  const { error } = await ctx.supabase.rpc("abandon_appointment", { p_id: appointmentId });
  if (error) console.error("[booking] abandon_appointment failed", { appointmentId, code: error.code });
}

async function ensureStillFree(ctx: RequestContext, calendar: CalendarClient, appointmentId: string, start: Date, now: Date): Promise<void> {
  let read: { windows: Interval[]; busy: Interval[] };
  try {
    read = await readCalendar(calendar, new Date(start.getTime() - SLOT_MS), new Date(start.getTime() + 2 * SLOT_MS), false);
  } catch (error) {
    await abandon(ctx, appointmentId);
    throw error;
  }
  const free = freeSlots({ windows: read.windows, busy: read.busy, now }).some((slot) => slot.start.getTime() === start.getTime());
  if (!free) {
    await abandon(ctx, appointmentId);
    throw new AppError("conflict", SLOT_TAKEN_MESSAGE, { reason: "slot_taken" });
  }
}

function appBaseUrl(): string | null {
  try {
    return getServerEnv().APP_BASE_URL ?? null;
  } catch {
    return null;
  }
}

async function createMeetingEvent(
  ctx: RequestContext,
  calendar: CalendarClient,
  appointmentId: string,
  leadId: string,
  start: Date,
  end: Date,
  note: string | null,
): Promise<string> {
  const { data: lead, error } = await ctx.supabase
    .from("leads")
    .select("business_name, contact_name, phone, city, state")
    .eq("id", leadId)
    .maybeSingle();
  if (error || !lead) {
    await abandon(ctx, appointmentId);
    if (error) fail(error);
    throw new AppError("not_found");
  }
  const baseUrl = appBaseUrl();
  try {
    const { eventId } = await calendar.createMeeting({
      start,
      end,
      title: meetingTitle(lead.business_name),
      description: buildMeetingDescription({
        businessName: lead.business_name,
        contactName: lead.contact_name,
        phone: lead.phone,
        city: lead.city,
        state: lead.state,
        bookedBy: ctx.profile.name || ctx.profile.email,
        note,
        leadUrl: baseUrl ? `${baseUrl}/leads/${leadId}` : null,
      }),
    });
    return eventId;
  } catch (cause) {
    await abandon(ctx, appointmentId);
    throw new AppError("unavailable", BOOKING_FAILED_MESSAGE, { cause });
  }
}

/** True when the lead's status is where a booking leaves it; false tells the agent to set Appointment by hand. */
async function moveToAppointment(ctx: RequestContext, leadId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase.from("leads").select("status").eq("id", leadId).maybeSingle();
  if (error || !data) return false;
  if (KEEP_STATUS_ON_BOOKING.includes(data.status)) return true;
  try {
    await updateLeadStatus(ctx, leadId, "APPOINTMENT");
    return true;
  } catch {
    // Not swallowed: the booking stands, and the result tells the agent to set the status by hand.
    return false;
  }
}

async function bookedView(
  ctx: RequestContext,
  id: string,
  leadId: string,
  start: Date,
  end: Date,
  now: Date,
): Promise<Omit<BookedAppointment, "statusNeedsAttention">> {
  const { data: lead } = await ctx.supabase.from("leads").select("state, country").eq("id", leadId).maybeSingle();
  const { timeZone } = leadTimeZone({ state: lead?.state ?? null, country: lead?.country ?? null }, ctx.profile.timezone);
  return {
    id,
    leadId,
    start: start.toISOString(),
    end: end.toISOString(),
    phrase: phraseSlot(start, timeZone, now),
    zone: zoneAbbreviation(start, timeZone),
  };
}

/**
 * begin_appointment (access, rate limit, replay, one live booking per slot) → re-check the calendar without the
 * cache → create the event → confirm_appointment. Any failure after the pending row exists abandons it.
 */
export async function bookAppointment(ctx: RequestContext | null, input: unknown, deps: CalendarDeps = {}): Promise<BookedAppointment> {
  const active = requireActive(ctx);
  const parsed = bookSchema.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0]?.message ?? "Pick a time and try again.");
  const leadId = parseId(parsed.data.leadId);
  const note = parsed.data.note ? parsed.data.note : null;
  const calendar = await calendarFor(active, deps);
  const now = deps.now?.() ?? new Date();

  const { data: row, error } = await active.supabase.rpc("begin_appointment", {
    p_lead_id: leadId,
    p_starts_at: new Date(parsed.data.start).toISOString(),
    p_note: note ?? undefined,
    p_client_request_id: parsed.data.clientRequestId,
  });
  if (error) fail(error);
  if (!row) throw new AppError("internal");

  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  let statusNeedsAttention = false;
  if (row.status === "pending") {
    await ensureStillFree(active, calendar, row.id, start, now);
    const eventId = await createMeetingEvent(active, calendar, row.id, leadId, start, end, note);
    const { error: confirmError } = await active.supabase.rpc("confirm_appointment", { p_id: row.id, p_google_event_id: eventId });
    if (confirmError) fail(confirmError);
    if (!parsed.data.inCall) statusNeedsAttention = !(await moveToAppointment(active, leadId));
  }
  return { ...(await bookedView(active, row.id, leadId, start, end, now)), statusNeedsAttention };
}

export async function cancelAppointment(ctx: RequestContext | null, id: unknown): Promise<{ id: string }> {
  const admin = requireAdmin(ctx);
  const appointmentId = parseId(id);
  const { error } = await admin.supabase.rpc("cancel_appointment", { p_id: appointmentId });
  if (error) fail(error);
  return { id: appointmentId };
}

export async function setLeadBusinessType(
  ctx: RequestContext | null,
  leadId: unknown,
  type: unknown,
): Promise<{ leadId: string; businessType: BusinessType | null }> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const businessType: BusinessType | null = isBusinessType(type) ? type : null;
  if (type !== null && businessType === null) throw new AppError("validation", "Choose a business type.");
  const { error } = await active.supabase.rpc("set_lead_business_type", { p_lead_id: id, p_type: businessType ?? undefined });
  if (error) fail(error);
  return { leadId: id, businessType };
}

export async function getNextMeeting(ctx: RequestContext | null, leadId: unknown, now: Date = new Date()): Promise<LeadMeeting | null> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const { data, error } = await active.supabase
    .from("appointments")
    .select("id, starts_at, ends_at, booked_by")
    .eq("lead_id", id)
    .eq("status", "scheduled")
    .gt("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) fail(error);
  if (!data) return null;

  let bookedByName: string | null = null;
  if (active.profile.role === "ADMIN") {
    const { data: profile } = await active.supabase.from("profiles").select("name, email").eq("id", data.booked_by).maybeSingle();
    bookedByName = profile ? profile.name || profile.email : null;
  }
  return { id: data.id, start: new Date(data.starts_at).toISOString(), end: new Date(data.ends_at).toISOString(), bookedByName };
}
```

- [ ] **Step 4: Create the actions** — `src/server/actions/calendar-booking.ts`:

```ts
"use server";

import { refresh } from "next/cache";
import type { BusinessType } from "@/lib/domain/business-type";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  bookAppointment,
  cancelAppointment,
  getAgentAvailability,
  setLeadBusinessType,
  type AgentAvailability,
  type BookedAppointment,
} from "@/server/services/calendar-booking";

export interface BookAppointmentActionInput {
  leadId: string;
  start: string;
  note: string | null;
  clientRequestId: string;
  inCall: boolean;
}

export async function getAvailabilityAction(leadId: string): Promise<ActionResult<AgentAvailability>> {
  return runAction(async () => getAgentAvailability(await getActionContext(), leadId));
}

export async function bookAppointmentAction(input: BookAppointmentActionInput): Promise<ActionResult<BookedAppointment>> {
  const result = await runAction(async () => bookAppointment(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function cancelAppointmentAction(id: string): Promise<ActionResult<{ id: string }>> {
  const result = await runAction(async () => cancelAppointment(await getActionContext(), id));
  if (result.ok) refresh();
  return result;
}

export async function setLeadBusinessTypeAction(
  leadId: string,
  type: BusinessType | null,
): Promise<ActionResult<{ leadId: string; businessType: BusinessType | null }>> {
  const result = await runAction(async () => setLeadBusinessType(await getActionContext(), leadId, type));
  if (result.ok) refresh();
  return result;
}
```

If the repo's other action files export an input `interface` from a `"use server"` module and the build rejects it, move `BookAppointmentActionInput` into `src/server/services/calendar-booking.ts` and import it as a type.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/calendar`
Expected: PASS (both calendar files).

- [ ] **Step 6: Typecheck, lint and commit**

Run: `npm run typecheck && npx eslint src/server/services/calendar-booking.ts src/server/actions/calendar-booking.ts tests/integration/calendar --max-warnings=0`
Expected: PASS.

```bash
git add src/server/services/calendar-booking.ts src/server/actions/calendar-booking.ts tests/integration/calendar/booking.test.ts
git commit -m "feat: book, cancel and categorize with a re-check and cleanup on every failure" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Business type as a CSV import column

**Files:**
- Modify: `src/lib/domain/import-mapping.ts`
- Modify: `src/components/import/import-model.ts`
- Modify: `src/server/services/import.ts`
- Modify: `tests/unit/domain/import-mapping.test.ts` (existing full-row expectation)
- Test: `tests/unit/domain/import-business-type.test.ts`

**Interfaces:**
- Consumes: `businessTypeFromImportValue`, `BusinessType` (Task 3).
- Produces: `ImportFieldKey` gains `'business_type'`; `NormalizedImportLead.business_type: BusinessType | null`; imported lead records carry `business_type`.

- [ ] **Step 1: Write the failing test** — `tests/unit/domain/import-business-type.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { guessMapping, validateImportRow } from "@/lib/domain/import-mapping";

describe("business type import column", () => {
  it.each(["Business Type", "Category", "Industry", "Type"])("auto-maps a %s header", (header) => {
    expect(guessMapping(["Business Name", "Phone", header])[header]).toBe("business_type");
  });

  it("stores a recognised type and keeps an unrecognised one in the notes", () => {
    const mapping = guessMapping(["Business Name", "Phone", "Category"]);
    const known = validateImportRow({ "Business Name": "Swan Motel", Phone: "(941) 555-0142", Category: "Hotel / motel" }, mapping, { appendUnmappedToNotes: true });
    expect(known).toMatchObject({ ok: true, lead: { business_type: "hotel_motel", notes: null } });

    const unknown = validateImportRow({ "Business Name": "Smile Co", Phone: "(941) 555-0143", Category: "Dentist" }, mapping, { appendUnmappedToNotes: true });
    expect(unknown).toMatchObject({ ok: true, lead: { business_type: null, notes: "Business type: Dentist" } });
  });

  it("leaves the type blank when the column is absent", () => {
    const mapping = guessMapping(["Business Name", "Phone"]);
    expect(validateImportRow({ "Business Name": "Swan Motel", Phone: "(941) 555-0142" }, mapping, { appendUnmappedToNotes: true })).toMatchObject({
      ok: true,
      lead: { business_type: null },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/domain/import-business-type.test.ts`
Expected: FAIL — the headers map to `null` and `business_type` is missing from the lead.

- [ ] **Step 3: Add the field** — in `src/lib/domain/import-mapping.ts`:

1. Add to the imports at the top:

```ts
import { businessTypeFromImportValue, type BusinessType } from './business-type';
```

2. In `IMPORT_FIELD_KEYS`, replace `  'source',` with:

```ts
  'source',
  'business_type',
```

3. In `CRM_IMPORT_FIELDS`, directly before the entry that starts `  {\n    key: 'notes',`, insert:

```ts
  {
    key: 'business_type',
    label: 'Business type',
    required: false,
    synonyms: ['Business Type', 'Category', 'Business Category', 'Industry', 'Type', 'Vertical', 'Niche'],
  },
```

4. In the `NormalizedImportLead` interface, replace

```ts
  source: string | null;
  notes: string | null;
```

with

```ts
  source: string | null;
  business_type: BusinessType | null;
  notes: string | null;
```

5. In `validateImportRow`, directly before `  const notes = [...noteParts, ...extraLines].join('\n');` insert:

```ts
  const businessTypeRaw = values.business_type;
  const businessType = businessTypeFromImportValue(businessTypeRaw);
  // An unrecognised category is kept, like any unmapped column, rather than silently dropped.
  if (businessTypeRaw !== undefined && businessType === null) extraLines.push(`Business type: ${businessTypeRaw}`);
```

6. In the returned `lead` object, replace `      source: values.source ?? null,` with:

```ts
      source: values.source ?? null,
      business_type: businessType,
```

- [ ] **Step 4: Update the length table and the insert**

In `src/components/import/import-model.ts`, in `IMPORT_FIELD_MAX_LENGTH`, replace `  source: 200,` with:

```ts
  source: 200,
  business_type: 100,
```

In `src/server/services/import.ts`, in the record built inside `pending.push({ ... record: { ... } })`, replace `        source: lead.source,` with:

```ts
        source: lead.source,
        business_type: lead.business_type,
```

- [ ] **Step 5: Update the existing full-row expectation**

Run: `npx vitest run --project unit tests/unit/domain/import-mapping.test.ts`
Expected: FAIL in the test near line 261 whose `toEqual` lists every lead field. Add `business_type: null,` directly after that expectation's `source:` line (and in any other full `lead` object the run reports), then rerun.
Expected: PASS.

- [ ] **Step 6: Run the import tests to verify they pass**

Run: `npx vitest run --project unit tests/unit/domain/import-business-type.test.ts tests/unit/domain/import-mapping.test.ts && npm run typecheck`
Expected: PASS. If typecheck reports another exhaustive `Record<ImportFieldKey, …>`, add a `business_type` entry that mirrors `source`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/domain/import-mapping.ts src/components/import/import-model.ts src/server/services/import.ts tests/unit/domain/import-business-type.test.ts tests/unit/domain/import-mapping.test.ts
git commit -m "feat(import): map a Business type column, keeping unknown values in the notes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Bulk "Set business type" on All Leads

**Files:**
- Modify: `src/lib/domain/bulk-leads.ts`, `src/server/services/bulk-leads.ts`, `src/server/actions/bulk-leads.ts`
- Modify: `src/components/leads/bulk/bulk-dialogs.tsx`, `src/components/leads/bulk/bulk-action-bar.tsx`
- Test: `tests/unit/domain/bulk-business-type-copy.test.ts`, `tests/integration/leads/bulk-business-type.test.ts`

**Interfaces:**
- Consumes: `bulk_set_business_type` (Task 1), `BUSINESS_TYPES`, `BUSINESS_TYPE_LABELS`, `isBusinessType` (Task 3); existing `leadCount`, `sentence`, `BulkCountResult`, `parseIds`, `fail`, `runAction`, `refresh`.
- Produces: `describeBusinessTypeResult(result: BulkCountResult, type: BusinessType | null): string`; `bulkSetBusinessType(ctx, leadIds: unknown, type: unknown): Promise<BulkCountResult & { businessType: BusinessType | null }>`; `bulkSetBusinessTypeAction(leadIds: string[], type: BusinessType | null)`; `BulkBusinessTypeDialog({ count, onClose, onSubmit(type: BusinessType | null) })`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/domain/bulk-business-type-copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeBusinessTypeResult } from "@/lib/domain/bulk-leads";

describe("describeBusinessTypeResult", () => {
  it("names the type and the count", () => {
    expect(describeBusinessTypeResult({ requested: 3, count: 3 }, "restaurant")).toBe("Set the business type to Restaurant on 3 leads.");
  });

  it("describes clearing as going back to guessing", () => {
    expect(describeBusinessTypeResult({ requested: 1, count: 1 }, null)).toBe("Cleared the business type on 1 lead, so its name decides again.");
  });

  it("says when nothing changed", () => {
    expect(describeBusinessTypeResult({ requested: 2, count: 0 }, "auto")).toBe("No business types changed.");
  });
});
```

`tests/integration/leads/bulk-business-type.test.ts`:

```ts
// Bulk business type from the Leads list (docs/DEVIATIONS.md D46): admins set or clear it on a selection; agents cannot.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { bulkSetBusinessType } from '@/server/services/bulk-leads';
import { contextFor, contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TAG = `BBT${randomUUID().slice(0, 8)}`;
let agent: FixtureUser;
let ctxAgent: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  agent = await createUser({ name: `Bulk Type Agent ${TAG}` });
  [ctxAgent, ctxAdmin] = await Promise.all([contextForUser(agent), signInSeeded('admin').then(contextFor)]);
});

describe('bulkSetBusinessType', () => {
  it('sets and clears the type for an admin', async () => {
    const leads = await Promise.all([1, 2].map((n) => createLead({ assigned_to: agent.id, business_name: `${TAG} Lead ${n}` })));
    const ids = leads.map((lead) => lead.id);

    expect(await bulkSetBusinessType(ctxAdmin, ids, 'beauty')).toEqual({ requested: 2, count: 2, businessType: 'beauty' });
    expect(await bulkSetBusinessType(ctxAdmin, ids, null)).toEqual({ requested: 2, count: 2, businessType: null });
  });

  it('refuses agents and unknown types', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Solo` });
    await expect(bulkSetBusinessType(ctxAgent, [lead.id], 'auto')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bulkSetBusinessType(ctxAdmin, [lead.id], 'dentist')).rejects.toMatchObject({ code: 'validation' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project unit tests/unit/domain/bulk-business-type-copy.test.ts` and `npx vitest run --project integration tests/integration/leads/bulk-business-type.test.ts`
Expected: FAIL — neither function exists.

- [ ] **Step 3: Add the copy** — in `src/lib/domain/bulk-leads.ts`, add to the imports:

```ts
import { BUSINESS_TYPE_LABELS, type BusinessType } from "./business-type";
```

and directly after the `describeSourceResult` function add:

```ts
export function describeBusinessTypeResult(result: BulkCountResult, type: BusinessType | null): string {
  if (result.count === 0) return "No business types changed.";
  if (type === null) {
    return `Cleared the business type on ${leadCount(result.count)}, so ${result.count === 1 ? "its name decides" : "their names decide"} again.`;
  }
  const head = `Set the business type to ${BUSINESS_TYPE_LABELS[type]} on ${leadCount(result.count)}.`;
  const same = result.requested - result.count;
  return sentence([head, same > 0 ? `${leadCount(same)} already had it or ${same === 1 ? "is" : "are"} no longer available.` : null]);
}
```

- [ ] **Step 4: Add the service and action**

In `src/server/services/bulk-leads.ts`, add to the imports:

```ts
import { isBusinessType, type BusinessType } from "@/lib/domain/business-type";
```

and directly after the `bulkSetSource` function add:

```ts
/** Admin: set or clear (null) the business type that ranks meeting times (docs/DEVIATIONS.md D46). */
export async function bulkSetBusinessType(
  ctx: RequestContext | null,
  leadIds: unknown,
  type: unknown,
): Promise<BulkCountResult & { businessType: BusinessType | null }> {
  const admin = requireAdmin(ctx);
  const ids = parseIds(leadIds);
  const businessType: BusinessType | null = isBusinessType(type) ? type : null;
  if (type !== null && businessType === null) throw new AppError("validation", "Choose a business type.");
  const { data, error } = await admin.supabase.rpc("bulk_set_business_type", { p_lead_ids: ids, p_type: businessType ?? undefined });
  if (error) fail(error);
  return { requested: ids.length, count: typeof data === "number" ? data : 0, businessType };
}
```

In `src/server/actions/bulk-leads.ts`, add `bulkSetBusinessType` to the import from `@/server/services/bulk-leads`, add `import type { BusinessType } from "@/lib/domain/business-type";`, and directly after `bulkSetSourceAction` add:

```ts
export async function bulkSetBusinessTypeAction(
  leadIds: string[],
  type: BusinessType | null,
): Promise<ActionResult<BulkCountResult & { businessType: BusinessType | null }>> {
  const result = await runAction(async () => bulkSetBusinessType(await getActionContext(), leadIds, type));
  if (result.ok) refresh();
  return result;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit tests/unit/domain/bulk-business-type-copy.test.ts` and `npx vitest run --project integration tests/integration/leads/bulk-business-type.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the dialog** — in `src/components/leads/bulk/bulk-dialogs.tsx`, make sure these imports exist (add any that are missing):

```tsx
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS, isBusinessType, type BusinessType } from "@/lib/domain/business-type";
```

and append:

```tsx
const GUESS_FROM_NAME = "guess";

export interface BulkBusinessTypeDialogProps {
  count: number;
  onClose(): void;
  onSubmit(type: BusinessType | null): void;
}

/** Pick one of the eight types, or go back to guessing from the name (clears the stored type). */
export function BulkBusinessTypeDialog({ count, onClose, onSubmit }: BulkBusinessTypeDialogProps) {
  const ids = useId();
  const [value, setValue] = useState("");
  const options = [...BUSINESS_TYPES, GUESS_FROM_NAME];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set the business type of {leadCount(count)}</DialogTitle>
          <DialogDescription>Meeting times are ranked by business type. Guess from name clears it, so the name decides again.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (value === GUESS_FROM_NAME) onSubmit(null);
            else if (isBusinessType(value)) onSubmit(value);
          }}
        >
          <RadioGroup value={value} onValueChange={setValue} aria-label="Business type" className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => {
              const id = `${ids}-${option}`;
              return (
                <Label
                  key={option}
                  htmlFor={id}
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/10"
                >
                  <RadioGroupItem id={id} value={option} />
                  {isBusinessType(option) ? BUSINESS_TYPE_LABELS[option] : "Guess from name"}
                </Label>
              );
            })}
          </RadioGroup>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-12" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="min-h-12" disabled={value === ""}>
              Set business type
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

(`useId`, `useState` and `leadCount` are already imported in this file for `BulkSourceDialog`.)

- [ ] **Step 7: Wire it into the bar** — in `src/components/leads/bulk/bulk-action-bar.tsx`:

1. Add `describeBusinessTypeResult` to the import from `@/lib/domain/bulk-leads`, `bulkSetBusinessTypeAction` to the import from `@/server/actions/bulk-leads`, `BulkBusinessTypeDialog` to the import from `./bulk-dialogs`, and `Store` to the `lucide-react` import.
2. Replace

```ts
type OpenDialog = "follow-up" | "source" | "delete" | "clear-follow-ups" | "do-not-contact" | null;
```

with

```ts
type OpenDialog = "follow-up" | "source" | "business-type" | "delete" | "clear-follow-ups" | "do-not-contact" | null;
```

3. Directly after the closing `</DropdownMenuItem>` of the item whose text is `Change source`, add:

```tsx
                <DropdownMenuItem className="min-h-12 gap-2" onSelect={() => setDialog("business-type")}>
                  <Store aria-hidden />
                  Set business type
                </DropdownMenuItem>
```

4. Directly before the line `      {dialog === "clear-follow-ups" ? (` add:

```tsx
      {dialog === "business-type" ? (
        <BulkBusinessTypeDialog
          count={count}
          onClose={() => setDialog(null)}
          onSubmit={(type) =>
            run(
              type === null ? `Clearing the business type on ${leadCount(count)}…` : `Setting the business type on ${leadCount(count)}…`,
              () => bulkSetBusinessTypeAction(selectedIds, type),
              (data) => confirmed(describeBusinessTypeResult(data, data.businessType), null),
            )
          }
        />
      ) : null}
```

- [ ] **Step 8: Typecheck, lint and commit**

Run: `npm run typecheck && npx eslint src/components/leads/bulk src/lib/domain/bulk-leads.ts src/server/services/bulk-leads.ts src/server/actions/bulk-leads.ts --max-warnings=0`
Expected: PASS.

```bash
git add src/lib/domain/bulk-leads.ts src/server/services/bulk-leads.ts src/server/actions/bulk-leads.ts src/components/leads/bulk tests/unit/domain/bulk-business-type-copy.test.ts tests/integration/leads/bulk-business-type.test.ts
git commit -m "feat: bulk Set business type on All Leads" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The dialer remembers a meeting booked during the call

**Files:**
- Modify: `src/lib/dialer/state.ts`
- Modify: `src/components/dialer/dialer-context.tsx`
- Modify: `src/components/dialer/dialer-provider.tsx`
- Test: `tests/unit/dialer/meeting-booked.test.ts`

**Interfaces:**
- Produces: `DialerAction` member `{ type: "MEETING_BOOKED"; leadId: string }`; optional `meetingBooked?: boolean` on the `ringing`, `in-call` and `tel-pending` states; `DialerContextValue.markMeetingBooked(leadId: string): void`.
- Behavior: a booking during `ringing`, `in-call` or `tel-pending` for the same lead makes the following wrap-up open with `preselectedOutcome: "APPOINTMENT"`; a booking during a matching `wrap-up` switches it to Appointment; anything else is ignored and returns the same state object.

- [ ] **Step 1: Write the failing test** — `tests/unit/dialer/meeting-booked.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INITIAL_DIALER_STATE, dialerReducer, type DialerAction, type DialerState } from "@/lib/dialer/state";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OTHER = "44444444-4444-4444-8444-444444444444";
const CALL = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const subject = { leadId: LEAD, label: "Acme Plumbing" };

function run(actions: DialerAction[], from: DialerState = INITIAL_DIALER_STATE): DialerState {
  return actions.reduce(dialerReducer, from);
}

const inCall = run([
  { type: "OUTBOUND_START", subject },
  { type: "OUTBOUND_CREATED", callId: CALL },
  { type: "RINGING" },
  { type: "CONNECTED", at: 1_000 },
]);

describe("MEETING_BOOKED", () => {
  it("opens the wrap-up with Appointment when a meeting was booked during the call", () => {
    const after = run([{ type: "MEETING_BOOKED", leadId: LEAD }, { type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(after).toMatchObject({ kind: "wrap-up", preselectedOutcome: "APPOINTMENT" });
  });

  it("ignores a booking for a different lead", () => {
    const before = run([{ type: "DISCONNECTED", reason: "completed" }], inCall);
    const after = run([{ type: "MEETING_BOOKED", leadId: OTHER }, { type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(after).toEqual(before);
  });

  it("switches an open wrap-up for that lead to Appointment", () => {
    const wrapUp = run([{ type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(dialerReducer(wrapUp, { type: "MEETING_BOOKED", leadId: LEAD })).toMatchObject({ kind: "wrap-up", preselectedOutcome: "APPOINTMENT" });
  });

  it("carries a booking made while dialling on the phone into the wrap-up", () => {
    const after = run([
      { type: "TEL_START", leadId: LEAD, label: "Acme Plumbing", clientRequestId: REQ, startedAt: 5 },
      { type: "MEETING_BOOKED", leadId: LEAD },
      { type: "TEL_RETURNED" },
    ]);
    expect(after).toMatchObject({ kind: "wrap-up", mode: "TEL", preselectedOutcome: "APPOINTMENT" });
  });

  it("returns the same state when there is nothing to remember", () => {
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "MEETING_BOOKED", leadId: LEAD })).toBe(INITIAL_DIALER_STATE);
    const booked = dialerReducer(inCall, { type: "MEETING_BOOKED", leadId: LEAD });
    expect(dialerReducer(booked, { type: "MEETING_BOOKED", leadId: LEAD })).toBe(booked);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/dialer/meeting-booked.test.ts`
Expected: FAIL — the reducer ignores the unknown action and the wrap-up has no Appointment preselected (and TypeScript reports the unknown action type).

- [ ] **Step 3: Extend the state** — in `src/lib/dialer/state.ts`:

1. In `DialerState`, replace

```ts
  | { kind: "ringing"; subject: CallSubject; callId: string; warning: string | null }
```

with

```ts
  | { kind: "ringing"; subject: CallSubject; callId: string; warning: string | null; meetingBooked?: boolean }
```

in the `in-call` member, directly after `      warning: string | null;` add `      meetingBooked?: boolean;`, and replace

```ts
  | { kind: "tel-pending"; subject: CallSubject & { leadId: string }; clientRequestId: string; startedAt: number };
```

with

```ts
  | { kind: "tel-pending"; subject: CallSubject & { leadId: string }; clientRequestId: string; startedAt: number; meetingBooked?: boolean };
```

2. In `DialerAction`, replace `  | { type: "WRAP_UP_DONE" };` with:

```ts
  | { type: "WRAP_UP_DONE" }
  /** A meeting was booked with this lead from the booking panel (docs/DEVIATIONS.md D46). */
  | { type: "MEETING_BOOKED"; leadId: string };
```

3. Directly after the `wrapUpFrom` function add:

```ts
/** A meeting booked during the call makes Appointment the outcome to confirm. */
function withMeeting(next: DialerState, meetingBooked: boolean | undefined): DialerState {
  return meetingBooked && next.kind === "wrap-up" ? { ...next, preselectedOutcome: "APPOINTMENT" } : next;
}
```

4. In the `DISCONNECTED` case, replace

```ts
      if (state.kind === "ringing") return wrapUpFrom(state.subject, state.callId, action.reason, false);
      if (state.kind === "in-call") return wrapUpFrom(state.subject, state.callId, action.reason, true);
```

with

```ts
      if (state.kind === "ringing") return withMeeting(wrapUpFrom(state.subject, state.callId, action.reason, false), state.meetingBooked);
      if (state.kind === "in-call") return withMeeting(wrapUpFrom(state.subject, state.callId, action.reason, true), state.meetingBooked);
```

5. In the `TEL_RETURNED` case, replace `        preselectedOutcome: null,` with:

```ts
        preselectedOutcome: state.meetingBooked ? "APPOINTMENT" : null,
```

6. Directly before `    case "PRESELECT_OUTCOME":` add:

```ts
    case "MEETING_BOOKED":
      if ((state.kind === "ringing" || state.kind === "in-call" || state.kind === "tel-pending") && state.subject.leadId === action.leadId) {
        return state.meetingBooked ? state : { ...state, meetingBooked: true };
      }
      if (state.kind === "wrap-up" && state.leadId === action.leadId && state.preselectedOutcome !== "APPOINTMENT") {
        return { ...state, preselectedOutcome: "APPOINTMENT" };
      }
      return state;

```

- [ ] **Step 4: Expose it on the context**

In `src/components/dialer/dialer-context.tsx`, inside `DialerContextValue`, directly after `  sendDigits(digits: string): void;` add:

```ts
  /** Remember a meeting booked with this lead, so the wrap-up opens on Appointment. */
  markMeetingBooked(leadId: string): void;
```

In `src/components/dialer/dialer-provider.tsx`, directly before `  const value = useMemo<DialerContextValue>(` add:

```ts
  const markMeetingBooked = useCallback((leadId: string) => dispatch({ type: "MEETING_BOOKED", leadId }), []);
```

then add `      markMeetingBooked,` directly after `      sendDigits,` in both the object literal and the dependency array of that `useMemo`. If `useCallback` is not yet imported from `react` in this file, add it to that import.

- [ ] **Step 5: Run the dialer tests to verify they pass**

Run: `npx vitest run --project unit tests/unit/dialer && npm run typecheck`
Expected: PASS (the new file and the existing `state.test.ts`). If typecheck flags a test that builds a full `DialerContextValue` literal without a cast, add `markMeetingBooked: () => undefined` to it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dialer/state.ts src/components/dialer/dialer-context.tsx src/components/dialer/dialer-provider.tsx tests/unit/dialer/meeting-booked.test.ts
git commit -m "feat(dialer): a meeting booked during the call preselects Appointment" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Day grouping for the booking panel

**Files:**
- Create: `src/components/booking/booking-model.ts`
- Test: `tests/unit/booking/booking-model.test.ts`

**Interfaces:**
- Consumes: `AgentAvailability`, `SlotView`, `MyMeetingView` types (Task 9); `startOfDayInTz`, `endOfDayInTz`, `formatInTz`.
- Produces:
  - `type BookingEntry = { kind: "slot"; start: string; slot: SlotView } | { kind: "busy"; start: string; label: string } | { kind: "mine"; start: string; label: string }`
  - `interface BookingDay { key: string; label: string; hasSlots: boolean; entries: BookingEntry[] }`
  - `buildBookingDays(availability: AgentAvailability, dayCount?: number): BookingDay[]` — 14 days on the lead's calendar starting today; busy blocks clipped to each day; a busy block identical to one of the agent's own meetings is shown only as that meeting.

- [ ] **Step 1: Write the failing test** — `tests/unit/booking/booking-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildBookingDays } from "@/components/booking/booking-model";
import type { AgentAvailability } from "@/server/services/calendar-booking";

const base: AgentAvailability = {
  leadId: "lead",
  businessName: "Swan Motel",
  businessType: "hotel_motel",
  businessTypeIsGuess: true,
  leadTimeZone: "America/New_York",
  leadTimeZoneIsGuess: false,
  zone: "EDT",
  now: "2026-09-21T13:00:00.000Z", // Monday 09:00 EDT
  suggestions: [],
  slots: [
    { start: "2026-09-21T15:00:00.000Z", end: "2026-09-21T15:30:00.000Z", day: "2026-09-21", phrase: "Today at 11 am", zone: "EDT", yourTime: null },
    { start: "2026-09-22T14:00:00.000Z", end: "2026-09-22T14:30:00.000Z", day: "2026-09-22", phrase: "Tomorrow at 10 am", zone: "EDT", yourTime: null },
  ],
  busy: [
    { start: "2026-09-22T02:00:00.000Z", end: "2026-09-22T05:00:00.000Z" }, // Mon 22:00 to Tue 01:00 EDT
    { start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T16:30:00.000Z" },
  ],
  mine: [{ id: "m1", leadId: "lead", businessName: "Swan Motel", start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T16:30:00.000Z" }],
};

describe("buildBookingDays", () => {
  it("lays out 14 days on the lead's calendar from today", () => {
    const days = buildBookingDays(base);
    expect(days).toHaveLength(14);
    expect(days[0]).toMatchObject({ key: "2026-09-21", label: "Mon 21", hasSlots: true });
    expect(days[2]).toMatchObject({ key: "2026-09-23", hasSlots: false, entries: [] });
  });

  it("orders slots, busy time and own meetings, showing an own meeting once", () => {
    const [monday] = buildBookingDays(base);
    expect(monday.entries.map((entry) => entry.kind)).toEqual(["slot", "mine", "busy"]);
    expect(monday.entries[1]).toMatchObject({ kind: "mine", label: "12:00 PM · Swan Motel" });
    expect(monday.entries[2]).toMatchObject({ kind: "busy", label: "10:00 PM – 12:00 AM" });
  });

  it("clips busy time that crosses midnight to each day", () => {
    const tuesday = buildBookingDays(base)[1];
    expect(tuesday.entries[0]).toMatchObject({ kind: "busy", label: "12:00 AM – 1:00 AM" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/booking/booking-model.test.ts`
Expected: FAIL — cannot resolve `@/components/booking/booking-model`.

- [ ] **Step 3: Implement** — `src/components/booking/booking-model.ts`:

```ts
// Groups availability into days on the lead's calendar for the booking panel (docs/DEVIATIONS.md D46). Pure.
import { endOfDayInTz, formatInTz, startOfDayInTz } from "@/lib/domain/time";
import type { AgentAvailability, IntervalView, SlotView } from "@/server/services/calendar-booking";

export type BookingEntry =
  | { kind: "slot"; start: string; slot: SlotView }
  | { kind: "busy"; start: string; label: string }
  | { kind: "mine"; start: string; label: string };

export interface BookingDay {
  /** yyyy-MM-dd on the lead's calendar. */
  key: string;
  label: string;
  hasSlots: boolean;
  entries: BookingEntry[];
}

export function buildBookingDays(availability: AgentAvailability, dayCount = 14): BookingDay[] {
  const tz = availability.leadTimeZone;
  const time = (date: Date) => formatInTz(date, tz, "h:mm a");
  const sameAsMine = (block: IntervalView) => availability.mine.some((meeting) => meeting.start === block.start && meeting.end === block.end);

  const days: BookingDay[] = [];
  let dayStart = startOfDayInTz(tz, new Date(availability.now));
  for (let index = 0; index < dayCount; index += 1) {
    const dayEnd = endOfDayInTz(tz, dayStart);
    const key = formatInTz(dayStart, tz, "yyyy-MM-dd");
    const overlapsDay = (view: IntervalView) => new Date(view.start) < dayEnd && new Date(view.end) > dayStart;

    const entries: BookingEntry[] = [
      ...availability.slots.filter((slot) => slot.day === key).map((slot): BookingEntry => ({ kind: "slot", start: slot.start, slot })),
      ...availability.busy
        .filter((block) => overlapsDay(block) && !sameAsMine(block))
        .map((block): BookingEntry => {
          const from = new Date(Math.max(new Date(block.start).getTime(), dayStart.getTime()));
          const to = new Date(Math.min(new Date(block.end).getTime(), dayEnd.getTime()));
          return { kind: "busy", start: from.toISOString(), label: `${time(from)} – ${time(to)}` };
        }),
      ...availability.mine
        .filter(overlapsDay)
        .map((meeting): BookingEntry => ({ kind: "mine", start: meeting.start, label: `${time(new Date(meeting.start))} · ${meeting.businessName}` })),
    ].sort((a, b) => a.start.localeCompare(b.start));

    days.push({ key, label: formatInTz(dayStart, tz, "EEE d"), hasSlots: entries.some((entry) => entry.kind === "slot"), entries });
    dayStart = dayEnd;
  }
  return days;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/booking/booking-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/booking/booking-model.ts tests/unit/booking/booking-model.test.ts
git commit -m "feat(booking): group open slots, busy time and own meetings by the lead's day" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: Booking panel, entry points and the next-meeting line

**Files:**
- Create: `src/components/booking/booking-panel.tsx`, `src/components/booking/book-meeting-button.tsx`, `src/components/booking/next-meeting.tsx`, `src/components/booking/cancel-appointment-button.tsx`
- Modify: `src/components/dialer/in-call-bar.tsx`, `src/app/(app)/leads/[id]/page.tsx`
- Test: `tests/unit/booking/next-meeting.test.tsx`

**Interfaces:**
- Consumes: actions (Task 10), `buildBookingDays` (Task 14), `useDialer().markMeetingBooked` (Task 13), `getNextMeeting` (Task 10), `leadTimeZone` (Task 4), `phraseSlot`/`zoneAbbreviation` (Task 7), `BUSINESS_TYPES`/`BUSINESS_TYPE_LABELS`/`BUSINESS_TYPE_BEST_FOR`/`isBusinessType` (Task 3).
- Produces:
  - `BookMeetingButton({ leadId: string; businessName: string; triggerClassName?: string })` — renders the trigger and a right-hand sheet titled `Book a meeting with {businessName}`; loads availability each time it opens.
  - `BookingPanel({ leadId; state: BookingLoadState; onReload(): void; onBooked(): void })`
  - `type BookingLoadState = { kind: "loading" } | { kind: "error"; message: string; unavailable: boolean } | { kind: "ready"; availability: AgentAvailability }`
  - `NextMeeting({ meeting: LeadMeeting; timeZone: string; now: Date; isAdmin: boolean })`, `CancelAppointmentButton({ appointmentId: string })`
  - DOM hooks used by Playwright: `data-suggestion` and `data-slot-start` on slot buttons, `data-day` on day buttons, `data-time-zone` on the panel root.

- [ ] **Step 1: Write the failing test for the server-rendered line** — `tests/unit/booking/next-meeting.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextMeeting } from "@/components/booking/next-meeting";

// The cancel button imports a server action; rendering markup needs none of the server code behind it.
vi.mock("@/server/actions/calendar-booking", () => ({ cancelAppointmentAction: vi.fn() }));

const meeting = { id: "m1", start: "2026-09-18T21:00:00.000Z", end: "2026-09-18T21:30:00.000Z", bookedByName: "Casey Morgan" };
const now = new Date("2026-09-17T14:00:00Z");

describe("NextMeeting", () => {
  it("phrases the meeting in the lead's time for an agent, without who booked it", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: false }));
    expect(html).toContain("Next meeting:");
    expect(html).toContain("Tomorrow at 5 pm EDT");
    expect(html).not.toContain("Casey Morgan");
    expect(html).not.toContain("Mark cancelled");
  });

  it("shows the booker and the cancel control to an admin", () => {
    const html = renderToStaticMarkup(createElement(NextMeeting, { meeting, timeZone: "America/New_York", now, isAdmin: true }));
    expect(html).toContain("Booked by Casey Morgan");
    expect(html).toContain("Mark cancelled");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/booking/next-meeting.test.tsx`
Expected: FAIL — cannot resolve `@/components/booking/next-meeting`.

- [ ] **Step 3: Create the cancel button** — `src/components/booking/cancel-appointment-button.tsx`:

```tsx
"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelAppointmentAction } from "@/server/actions/calendar-booking";

/** Admin only. Updates the CRM; the event stays in Google Calendar until the closer deletes it there. */
export function CancelAppointmentButton({ appointmentId }: { appointmentId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-12" disabled={pending}>
          Mark cancelled
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark this meeting cancelled?</AlertDialogTitle>
          <AlertDialogDescription>
            This only updates the CRM. The event stays in your Google Calendar, and that time stays busy, until you delete
            it there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12">Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-12"
            onClick={() =>
              startTransition(async () => {
                const result = await cancelAppointmentAction(appointmentId).catch(() => null);
                if (!result) toast.error("The connection dropped before the server answered. Check the lead, then try again.");
                else if (!result.ok) toast.error(result.error.message);
                else toast.success("Meeting marked cancelled.");
              })
            }
          >
            Mark cancelled
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

- [ ] **Step 4: Create the next-meeting line** — `src/components/booking/next-meeting.tsx`:

```tsx
import { CalendarCheck } from "lucide-react";
import { phraseSlot, zoneAbbreviation } from "@/lib/domain/slot-phrase";
import type { LeadMeeting } from "@/server/services/calendar-booking";
import { CancelAppointmentButton } from "./cancel-appointment-button";

export interface NextMeetingProps {
  meeting: LeadMeeting;
  /** The lead's time zone. */
  timeZone: string;
  now: Date;
  isAdmin: boolean;
}

/** The next scheduled meeting on a lead, as the viewer may see it (agents: only meetings they booked, via RLS). */
export function NextMeeting({ meeting, timeZone, now, isAdmin }: NextMeetingProps) {
  const start = new Date(meeting.start);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 text-sm">
      <CalendarCheck aria-hidden className="size-5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1">
        <span className="font-bold">Next meeting:</span> {phraseSlot(start, timeZone, now)} {zoneAbbreviation(start, timeZone)}
        {isAdmin && meeting.bookedByName ? <span className="text-muted-foreground"> · Booked by {meeting.bookedByName}</span> : null}
      </p>
      {isAdmin ? <CancelAppointmentButton appointmentId={meeting.id} /> : null}
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/booking/next-meeting.test.tsx`
Expected: PASS. (The `Mark cancelled` trigger renders statically; the dialog content does not, so the markup check is on the trigger text.)

- [ ] **Step 6: Create the panel** — `src/components/booking/booking-panel.tsx`:

```tsx
"use client";

import { Loader2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useDialer } from "@/components/dialer/dialer-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CALENDAR_LOAD_FAILED_MESSAGE, STATUS_NOT_UPDATED_MESSAGE } from "@/lib/domain/booking-messages";
import { BUSINESS_TYPES, BUSINESS_TYPE_BEST_FOR, BUSINESS_TYPE_LABELS, isBusinessType } from "@/lib/domain/business-type";
import { cn } from "@/lib/utils";
import { bookAppointmentAction, setLeadBusinessTypeAction } from "@/server/actions/calendar-booking";
import type { AgentAvailability, SlotView } from "@/server/services/calendar-booking";
import { buildBookingDays } from "./booking-model";

export type BookingLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; unavailable: boolean }
  | { kind: "ready"; availability: AgentAvailability };

export interface BookingPanelProps {
  leadId: string;
  state: BookingLoadState;
  onReload(): void;
  onBooked(): void;
}

function SlotButton({ slot, suggested, onChoose }: { slot: SlotView; suggested: boolean; onChoose(slot: SlotView): void }) {
  return (
    <Button
      type="button"
      variant={suggested ? "default" : "outline"}
      data-slot-start={slot.start}
      data-suggestion={suggested ? "" : undefined}
      className={cn("h-auto min-h-12 flex-col items-start gap-0 whitespace-normal py-2 text-left", suggested && "w-full")}
      onClick={() => onChoose(slot)}
    >
      <span className="font-bold">
        {suggested ? `${slot.phrase} ${slot.zone}` : slot.phrase.replace(/^.* at /, "")}
      </span>
      {slot.yourTime ? <span className="text-xs font-normal opacity-80">{slot.yourTime}</span> : null}
    </Button>
  );
}

export function BookingPanel({ leadId, state, onReload, onBooked }: BookingPanelProps) {
  const dialer = useDialer();
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<SlotView | null>(null);
  const [requestId, setRequestId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [booking, startBooking] = useTransition();
  const [saving, startSaving] = useTransition();

  const availability = state.kind === "ready" ? state.availability : null;
  const days = useMemo(() => (availability ? buildBookingDays(availability) : []), [availability]);

  if (state.kind === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Loading the calendar…
      </p>
    );
  }

  if (state.kind === "error" || !availability) {
    return (
      <div role="alert" className="flex flex-col gap-3 p-4 text-sm">
        <p>{state.kind === "error" ? state.message : CALENDAR_LOAD_FAILED_MESSAGE}</p>
        {state.kind === "error" && state.unavailable ? null : (
          <Button type="button" variant="outline" className="min-h-12 self-start" onClick={onReload}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const live = dialer?.state;
  const inCall =
    !!live &&
    (live.kind === "ringing" || live.kind === "in-call" || live.kind === "tel-pending") &&
    live.subject.leadId === leadId;
  const selectedDay = days.find((day) => day.key === dayKey) ?? days.find((day) => day.hasSlots) ?? days[0];

  function choose(slot: SlotView) {
    setChosen(slot);
    setRequestId(crypto.randomUUID());
    setMessage("");
  }

  function changeType(value: string) {
    if (!isBusinessType(value)) return;
    startSaving(async () => {
      const result = await setLeadBusinessTypeAction(leadId, value).catch(() => null);
      if (!result || !result.ok) {
        setMessage(result ? result.error.message : "The connection dropped. Try again.");
        return;
      }
      onReload();
    });
  }

  function book() {
    if (!chosen) return;
    const slot = chosen;
    startBooking(async () => {
      const result = await bookAppointmentAction({ leadId, start: slot.start, note: note.trim() === "" ? null : note, clientRequestId: requestId, inCall }).catch(() => null);
      if (!result) {
        setMessage("The connection dropped before the server answered. Try again; it will not book twice.");
        return;
      }
      if (!result.ok) {
        setMessage(result.error.message);
        if (result.error.code === "conflict") {
          setChosen(null);
          onReload();
        }
        return;
      }
      toast.success(`Booked: ${result.data.phrase} ${result.data.zone}`);
      if (result.data.statusNeedsAttention) toast.warning(STATUS_NOT_UPDATED_MESSAGE);
      if (inCall) dialer?.markMeetingBooked(leadId);
      onBooked();
    });
  }

  return (
    <div className="flex flex-col gap-5 p-4" data-time-zone={availability.leadTimeZone}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`booking-type-${leadId}`}>Business type</Label>
        <Select value={availability.businessType} onValueChange={changeType} disabled={saving}>
          <SelectTrigger id={`booking-type-${leadId}`} className="min-h-12 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUSINESS_TYPES.map((type) => (
              <SelectItem key={type} value={type} className="min-h-12">
                {BUSINESS_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {availability.businessTypeIsGuess ? "Guessed from the name. " : ""}
          Their time: {availability.zone}
          {availability.leadTimeZoneIsGuess ? " (their time zone is unknown, so this is yours)" : ""}
        </p>
      </div>

      {availability.suggestions.length > 0 ? (
        <section aria-labelledby={`booking-best-${leadId}`} className="flex flex-col gap-2">
          <h3 id={`booking-best-${leadId}`} className="text-sm font-bold">
            Best for {BUSINESS_TYPE_BEST_FOR[availability.businessType]}
          </h3>
          {availability.suggestions.map((slot) => (
            <SlotButton key={slot.start} slot={slot} suggested onChoose={choose} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby={`booking-all-${leadId}`} className="flex flex-col gap-3">
        <h3 id={`booking-all-${leadId}`} className="text-sm font-bold">
          All open times
        </h3>
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Days">
          {days.map((day) => (
            <Button
              key={day.key}
              type="button"
              variant={day.key === selectedDay?.key ? "default" : "outline"}
              aria-pressed={day.key === selectedDay?.key}
              disabled={!day.hasSlots}
              data-day={day.key}
              className="min-h-12 shrink-0"
              onClick={() => setDayKey(day.key)}
            >
              {day.label}
            </Button>
          ))}
        </div>
        {selectedDay && selectedDay.entries.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {selectedDay.entries.map((entry) => (
              <li key={`${entry.kind}-${entry.start}`}>
                {entry.kind === "slot" ? (
                  <SlotButton slot={entry.slot} suggested={false} onChoose={choose} />
                ) : entry.kind === "busy" ? (
                  <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <span className="font-semibold">Busy</span> {entry.label}
                  </p>
                ) : (
                  <p className="rounded-lg border px-3 py-2 text-sm">
                    <span className="font-semibold">Your meeting</span> {entry.label}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No open times on this day.</p>
        )}
      </section>

      {chosen ? (
        <section aria-label="Confirm the meeting" className="flex flex-col gap-3 rounded-xl border p-4">
          <p className="font-bold">
            Book {chosen.phrase} {chosen.zone} with {availability.businessName}?
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`booking-note-${leadId}`}>Note for the closer (optional)</Label>
            <Textarea id={`booking-note-${leadId}`} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-12" disabled={booking} onClick={book}>
              {booking ? "Booking…" : "Book"}
            </Button>
            <Button type="button" variant="outline" className="min-h-12" disabled={booking} onClick={() => setChosen(null)}>
              Pick another time
            </Button>
          </div>
        </section>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </div>
  );
}
```

- [ ] **Step 7: Create the trigger** — `src/components/booking/book-meeting-button.tsx`:

```tsx
"use client";

import { CalendarPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { BOOKING_UNAVAILABLE_MESSAGE, CALENDAR_LOAD_FAILED_MESSAGE } from "@/lib/domain/booking-messages";
import { getAvailabilityAction } from "@/server/actions/calendar-booking";
import { BookingPanel, type BookingLoadState } from "./booking-panel";

export interface BookMeetingButtonProps {
  leadId: string;
  businessName: string;
  /** When set, a plain button with these classes (the in-call bar's look) replaces the default outline button. */
  triggerClassName?: string;
}

export function BookMeetingButton({ leadId, businessName, triggerClassName }: BookMeetingButtonProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BookingLoadState>({ kind: "loading" });
  const [, startTransition] = useTransition();

  function load() {
    setState({ kind: "loading" });
    startTransition(async () => {
      const result = await getAvailabilityAction(leadId).catch(() => null);
      if (!result) setState({ kind: "error", message: CALENDAR_LOAD_FAILED_MESSAGE, unavailable: false });
      // No calendar at all: retrying cannot help, so the panel offers none. A failed load can be retried.
      else if (!result.ok) setState({ kind: "error", message: result.error.message, unavailable: result.error.message === BOOKING_UNAVAILABLE_MESSAGE });
      else setState({ kind: "ready", availability: result.data });
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
    >
      <SheetTrigger asChild>
        {triggerClassName ? (
          <button type="button" aria-label="Book meeting" className={triggerClassName}>
            <CalendarPlus aria-hidden />
            <span className="hidden md:inline">Book meeting</span>
          </button>
        ) : (
          <Button type="button" variant="outline" className="min-h-12 gap-2">
            <CalendarPlus aria-hidden />
            Book meeting
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Book a meeting with {businessName}</SheetTitle>
          <SheetDescription>30 minutes with the closer. Times are shown in the lead's time zone.</SheetDescription>
        </SheetHeader>
        <BookingPanel leadId={leadId} state={state} onReload={load} onBooked={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 8: Add the in-call entry point** — in `src/components/dialer/in-call-bar.tsx`, add the import

```tsx
import { BookMeetingButton } from "@/components/booking/book-meeting-button";
```

and directly before the mute button (the `<button` whose next lines are `type="button"` and `aria-label={muted ? "Unmute" : "Mute"}`) insert:

```tsx
        {state.subject.leadId ? (
          <BookMeetingButton
            leadId={state.subject.leadId}
            businessName={state.subject.label}
            triggerClassName={cn(controlClass, "bg-black/20 hover:bg-black/30")}
          />
        ) : null}
```

- [ ] **Step 9: Add the lead page entry point** — in `src/app/(app)/leads/[id]/page.tsx`:

1. Add the imports:

```tsx
import { BookMeetingButton } from "@/components/booking/book-meeting-button";
import { NextMeeting } from "@/components/booking/next-meeting";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { getNextMeeting } from "@/server/services/calendar-booking";
```

2. Replace

```tsx
  const [agents, skips] = await Promise.all([
    isAdmin ? listAgentsForFilter(ctx).then((all) => all.filter((agent) => agent.active)) : Promise.resolve([]),
    getLeadSkipHistory(ctx, lead.id),
  ]);
```

with

```tsx
  const [agents, skips, nextMeeting] = await Promise.all([
    isAdmin ? listAgentsForFilter(ctx).then((all) => all.filter((agent) => agent.active)) : Promise.resolve([]),
    getLeadSkipHistory(ctx, lead.id),
    getNextMeeting(ctx, lead.id),
  ]);
```

3. Directly after the closing `</header>` of the page header add:

```tsx
      {lead.status !== "DO_NOT_CONTACT" || nextMeeting ? (
        <div className="mb-4 flex flex-col gap-3">
          {lead.status !== "DO_NOT_CONTACT" ? (
            <div>
              <BookMeetingButton leadId={lead.id} businessName={lead.businessName} />
            </div>
          ) : null}
          {nextMeeting ? (
            <NextMeeting
              meeting={nextMeeting}
              timeZone={leadTimeZone({ state: lead.state, country: lead.country }, tz).timeZone}
              now={now}
              isAdmin={isAdmin}
            />
          ) : null}
        </div>
      ) : null}
```

- [ ] **Step 10: Typecheck, lint and run the unit project**

Run: `npm run typecheck && npx eslint src/components/booking src/components/dialer/in-call-bar.tsx "src/app/(app)/leads/[id]/page.tsx" --max-warnings=0 && npx vitest run --project unit`
Expected: PASS. If `currentTime()` on the lead page returns something other than a `Date`, pass `new Date(now)` to `NextMeeting`.

- [ ] **Step 11: See it work locally**

Run `npm run dev:local`, sign in with a seeded agent, open a lead, press **Book meeting**. Expected: the sheet lists up to three *Best for …* buttons phrased like *Tomorrow at 11 am EDT*, weekday 10:00–12:00 and 14:00–17:00 slots with **Busy** bars at 11:00 and 15:00, and booking one closes the sheet, shows *Booked: …* and a *Next meeting:* line. Start a mock call, book from the in-call bar, hang up: the outcome sheet opens with Appointment selected.

- [ ] **Step 12: Commit**

```bash
git add src/components/booking src/components/dialer/in-call-bar.tsx "src/app/(app)/leads/[id]/page.tsx" tests/unit/booking/next-meeting.test.tsx
git commit -m "feat(booking): book-meeting panel from the lead page and the in-call bar, and the next-meeting line" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: End to end on the mock calendar

**Files:**
- Modify: `scripts/e2e-server.ts`
- Create: `e2e/workspace-calendar-booking.spec.ts`

**Interfaces:**
- Consumes: the `data-suggestion`, `data-slot-start`, `data-day` and `data-time-zone` hooks and the sheet title from Task 15; `signIn(page, key)` from `e2e/helpers.ts`; seeded agents `casey` and `blair`.

- [ ] **Step 1: Pin the e2e server to the mock calendar** — in `scripts/e2e-server.ts`, directly after `    DIALER_DRIVER: 'mock',` add:

```ts
    CALENDAR_DRIVER: 'mock',
```

- [ ] **Step 2: Write the spec** — `e2e/workspace-calendar-booking.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Closer calendar booking on the mock calendar (docs/DEVIATIONS.md D46), in the `workspace` project. Casey books a
 * suggested slot; Blair then finds that time gone from their own panel and nothing of Casey's lead anywhere in it.
 */
test.describe.configure({ mode: 'serial' });

let bookedStart = '';
let bookedLead = '';

async function openFirstCallableLead(page: Page): Promise<string> {
  await page.goto('/leads');
  const row = page.locator('main table tbody tr').filter({ visible: true }).filter({ hasNot: page.getByText('Do Not Contact', { exact: true }) }).first();
  const link = row.locator('td:nth-child(2) a');
  const name = (await link.innerText()).trim();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return name;
}

test('an agent books a suggested slot and the lead shows the next meeting', async ({ page }) => {
  await signIn(page, 'casey');
  bookedLead = await openFirstCallableLead(page);

  await page.getByRole('button', { name: 'Book meeting' }).first().click();
  const panel = page.getByRole('dialog', { name: `Book a meeting with ${bookedLead}` });
  const suggestion = panel.locator('[data-suggestion]').first();
  await expect(suggestion).toBeVisible();
  bookedStart = (await suggestion.getAttribute('data-slot-start')) ?? '';
  expect(bookedStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  await suggestion.click();
  await panel.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /^Booked: / })).toBeVisible();
  await expect(page.getByText('Next meeting:', { exact: true })).toBeVisible();
});

test("another agent finds that time taken, with nothing of the first agent's lead", async ({ page }) => {
  test.skip(bookedStart === '', 'depends on the booking above');
  await signIn(page, 'blair');
  const name = await openFirstCallableLead(page);

  await page.getByRole('button', { name: 'Book meeting' }).first().click();
  const panel = page.getByRole('dialog', { name: `Book a meeting with ${name}` });
  await expect(panel.getByRole('heading', { name: /^Best for / })).toBeVisible();

  const timeZone = (await panel.locator('[data-time-zone]').getAttribute('data-time-zone')) ?? 'America/New_York';
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(bookedStart));
  const day = panel.locator(`[data-day="${dayKey}"]`);
  if (await day.isEnabled()) await day.click();

  await expect(panel.locator(`[data-slot-start="${bookedStart}"]`)).toHaveCount(0);
  await expect(panel).not.toContainText(bookedLead);
});
```

- [ ] **Step 3: Run it**

Run: `npx playwright test --project=workspace e2e/workspace-calendar-booking.spec.ts`
Expected: the `import` dependency runs first, then 2 passed. If `Do Not Contact` is rendered differently in the leads table, adjust only the row filter text to what the table shows.

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-server.ts e2e/workspace-calendar-booking.spec.ts
git commit -m "test(e2e): book on the mock calendar and prove the slot is gone for another agent" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 17: Documentation

**Files:**
- Modify: `docs/DEVIATIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/PLAN.md`, `.env.example`

- [ ] **Step 1: Deviation D46** — in `docs/DEVIATIONS.md`, directly after the index row that starts `| [D44](#d44-pipeline-stage-navigation-and-bounded-columns)` add:

```markdown
| [D46](#d46-closer-calendar-booking) | Closer calendar booking |
```

and append to the end of the file:

```markdown

## D46. Closer calendar booking
**Spec:** §15 lists Google Calendar under "Future-ready, not built".
**Built:** agents book 30-minute meetings with a lead into one closer calendar from the lead page or the in-call bar.
The panel shows open slots inside the closer's bookable windows, plain **Busy** blocks for everything else, full
details only of meetings the agent booked, and the three best slots for the lead's business type phrased in the lead's
local time ("Tomorrow at 5 pm EDT"). Booking writes go through guarded SECURITY DEFINER RPCs; a unique index on live
start times makes a double booking impossible; every failure after the pending row exists abandons it. A booking during
a call preselects Appointment; otherwise the lead moves to Appointment unless it is already further along. Business
type is set in bulk, through CSV import or corrected in the panel, and guessed from the name when blank. This release
runs on an in-memory mock calendar (`CALENDAR_DRIVER=mock`, refused in production); the Google connection is the second
milestone. Design: `docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md`.
**Why:** the closer confirms meetings personally, agents need to offer concrete times mid-call, and the closer's calendar
details are none of the agents' business.
**Not built:** texts or emails to the lead, rescheduling or cancelling by agents, reminders, several closers. States
spanning two time zones use their larger zone. Marking a meeting cancelled in the CRM leaves the Google event in place.
```

(D45 is reserved by the `pep-talk` branch; when both merge, the index keeps both rows.)

- [ ] **Step 2: Architecture** — in `docs/ARCHITECTURE.md`, append a section:

```markdown

## Closer calendar booking (D46)

Tables: `appointments` (lead, `booked_by`, 30-minute `starts_at`/`ends_at`, `status` pending|scheduled|cancelled,
`google_event_id`, `note` ≤ 500, `client_request_id`; unique index on `starts_at` where live; RLS select: booker or
admin) and `calendar_connection` (singleton, no API access). `leads.business_type` (enum, null = guess from name).

| RPC | Security | Who | Notes |
|---|---|---|---|
| `set_lead_business_type(p_lead_id, p_type)` | definer | active; admin any lead, agent own | null clears |
| `bulk_set_business_type(p_lead_ids, p_type)` | invoker | admin | 5,000 cap, `too_many_leads` |
| `begin_appointment(p_lead_id, p_starts_at, p_note, p_client_request_id)` | definer | active; lead access | replay, boundary, DNC, `book_appointment` 20/hour, stale-pending cleanup, `slot_taken` |
| `confirm_appointment(p_id, p_google_event_id)` | definer | booker | pending → scheduled, idempotent |
| `abandon_appointment(p_id)` | definer | booker | deletes own pending row |
| `cancel_appointment(p_id)` | definer | admin | scheduled → cancelled, CRM only |
| `booked_intervals(p_from, p_to)` | definer | active | times only, range ≤ 31 days |
| `get_calendar_status()` | definer | admin | never returns the token |

Environment: `CALENDAR_DRIVER` = `google` | `mock`; unset is `mock` outside production and unavailable in production;
`mock` in production is refused at startup. Code: `src/lib/domain/{business-type,lead-timezone,calendar-slots,business-rhythm,slot-phrase,meeting-description}.ts`,
`src/server/calendar/*`, `src/server/services/calendar-booking.ts`, `src/components/booking/*`.
```

- [ ] **Step 3: Migration counts** — the docs-drift test compares every "N migrations" claim with `supabase/migrations/`. Run:

```bash
grep -n "migrations" README.md docs/ARCHITECTURE.md docs/PLAN.md | grep -E "[0-9]+ migrations|001800"
```

and in each reported line change `17 migrations` to `18 migrations` and `001800` to `001900`.

- [ ] **Step 4: README and env template**

In `README.md`, in the agent feature list, directly after the bullet that starts `- Skip with a reason:` add:

```markdown
- Book a meeting mid-call: a panel of the closer's open 30-minute slots, the best three for the lead's kind of business
  phrased in their local time ("Tomorrow at 5 pm EDT"), plain Busy blocks for everything else, and Appointment
  preselected when the call ends.
```

In `.env.example`, directly after the `DIALER_DRIVER=` line add:

```bash

# [optional] Which calendar meeting booking uses: google | mock. SERVER-ONLY.
#   mock    an in-memory closer calendar (weekdays 10-12 and 14-17) for development and tests
#   google  the connected Google Calendar (second milestone; unavailable until then)
# Unset resolves to mock in development/test and to "booking unavailable" in production.
# CALENDAR_DRIVER=mock with NODE_ENV=production is refused at startup (docs/DEVIATIONS.md D46).
CALENDAR_DRIVER=
```

- [ ] **Step 5: Run the docs tests and commit**

Run: `npx vitest run --project unit tests/unit/docs`
Expected: PASS.

```bash
git add docs/DEVIATIONS.md docs/ARCHITECTURE.md README.md docs/PLAN.md .env.example
git commit -m "docs: closer calendar booking (D46), RPCs, driver and migration counts" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 18: Full verification

- [ ] **Step 1: Run the whole suite**

Run: `npm run verify`
Expected: typecheck, lint, and the unit, db and integration projects all pass.

- [ ] **Step 2: Run every Playwright project**

Run: `npm run test:e2e`
Expected: all projects pass, including `workspace-calendar-booking.spec.ts`.

- [ ] **Step 3: Fix, never skip** — if anything fails, reproduce it with the narrowest test command, fix the cause, rerun that command, then rerun Steps 1–2. Commit each fix separately with the trailer.
