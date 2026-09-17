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
