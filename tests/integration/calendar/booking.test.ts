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
