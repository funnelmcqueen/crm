// get_next_lead ordering across all five buckets, exclusions, the 4-hour rule and the skip list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  fakeTwilioSid,
  type PGlite,
} from '../helpers/pglite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: PGlite;
let admin = '';

interface NextLead {
  lead_id: string;
  business_name: string;
  reason: string;
}

async function nextLead(userId: string, exclude: string[] = []): Promise<NextLead | undefined> {
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<NextLead>('select lead_id, business_name, reason from public.get_next_lead($1::uuid[])', [exclude]);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0];
  });
}

/** Walks the queue with a growing skip list: the order an agent would see pressing Skip. */
async function queue(userId: string): Promise<Array<[string, string]>> {
  const seen: string[] = [];
  const order: Array<[string, string]> = [];
  for (let i = 0; i < 50; i += 1) {
    const next = await nextLead(userId, seen);
    if (!next) break;
    seen.push(next.lead_id);
    order.push([next.business_name, next.reason]);
  }
  return order;
}

/** A zone where it is currently between 02:00 and 20:59, so "now + 1h" is still today there. */
function zoneWithDaytime(): string {
  const candidates = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Honolulu'];
  for (const zone of candidates) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour >= 2 && hour <= 20) return zone;
  }
  throw new Error('no daytime zone found');
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const ahead = (ms: number): Date => new Date(Date.now() + ms);

async function voicemailOn(leadId: string, userId: string, at: Date, handled = false): Promise<void> {
  await createCallRow(db, {
    lead_id: leadId,
    user_id: userId,
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    voicemail_recording_sid: fakeTwilioSid('RE'),
    created_at: at,
    handled_at: handled ? new Date() : null,
  });
}

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN' });
});

afterAll(async () => {
  await db?.close();
});

describe('get_next_lead', () => {
  it('orders VOICEMAIL > OVERDUE > DUE_TODAY > NEW > RETRY with the documented tie-breaks', async () => {
    const agent = await createAuthUser(db, { timezone: zoneWithDaytime() });
    const other = await createAuthUser(db);
    const lead = (name: string, values: Record<string, string | number | Date | null> = {}) =>
      createLeadRow(db, { assigned_to: agent, business_name: name, ...values });

    const vmNew = await lead('vm-new', { status: 'NEW', created_at: ago(30 * DAY), last_contacted_at: ago(1 * HOUR) });
    await voicemailOn(vmNew.id, agent, ago(2 * HOUR));
    const vmOld = await lead('vm-old', { status: 'CONNECTED', created_at: ago(1 * DAY) });
    await voicemailOn(vmOld.id, agent, ago(5 * HOUR));

    const overdueOld = await lead('overdue-old', { status: 'FOLLOW_UP', last_contacted_at: ago(1 * HOUR) });
    await createFollowUpRow(db, { lead_id: overdueOld.id, user_id: agent, due_at: ago(2 * DAY) });
    await createFollowUpRow(db, { lead_id: overdueOld.id, user_id: agent, due_at: ahead(3 * DAY) });
    const overdueNew = await lead('overdue-new', { status: 'CONNECTED' });
    await createFollowUpRow(db, { lead_id: overdueNew.id, user_id: agent, due_at: ago(1 * HOUR) });

    const dueToday = await lead('due-today', { status: 'INTERESTED' });
    await createFollowUpRow(db, { lead_id: dueToday.id, user_id: agent, due_at: ahead(1 * HOUR) });

    await lead('new-oldest', { status: 'NEW', created_at: ago(10 * DAY) });
    await lead('to-call-newer', { status: 'TO_CALL', created_at: ago(5 * DAY) });
    const dueTomorrow = await lead('new-with-future-follow-up', { status: 'NEW', created_at: ago(1 * DAY) });
    await createFollowUpRow(db, { lead_id: dueTomorrow.id, user_id: agent, due_at: ahead(30 * HOUR) });

    const sameContact = ago(2 * DAY);
    await lead('retry-more-calls', { status: 'NO_ANSWER', last_contacted_at: sameContact, call_count: 3 });
    await lead('retry-fewer-calls', { status: 'VOICEMAIL', last_contacted_at: sameContact, call_count: 1 });
    await lead('retry-never-contacted', { status: 'NO_ANSWER', last_contacted_at: null, call_count: 0 });
    await lead('retry-contacted-earlier', { status: 'NO_ANSWER', last_contacted_at: ago(3 * DAY), call_count: 9 });

    // Never suggested.
    const client = await lead('x-client', { status: 'CLIENT' });
    await createFollowUpRow(db, { lead_id: client.id, user_id: agent, due_at: ago(1 * DAY) });
    await lead('x-not-interested', { status: 'NOT_INTERESTED' });
    const dnc = await lead('x-dnc', { status: 'DO_NOT_CONTACT' });
    await voicemailOn(dnc.id, agent, ago(1 * HOUR));
    await lead('x-called-recently', { status: 'NEW', last_contacted_at: ago(1 * HOUR) });
    await lead('x-connected-no-follow-up', { status: 'CONNECTED' });
    const handled = await lead('x-appointment-heard-voicemail', { status: 'APPOINTMENT' });
    await voicemailOn(handled.id, agent, ago(1 * HOUR), true);
    const othersLead = await createLeadRow(db, { assigned_to: other, business_name: 'x-other-agent', status: 'NEW' });
    await voicemailOn(othersLead.id, other, ago(9 * HOUR));
    await createLeadRow(db, { business_name: 'x-unassigned', status: 'NEW', created_at: ago(90 * DAY) });

    expect(await queue(agent)).toEqual([
      ['vm-old', 'VOICEMAIL'],
      ['vm-new', 'VOICEMAIL'],
      ['overdue-old', 'OVERDUE'],
      ['overdue-new', 'OVERDUE'],
      ['due-today', 'DUE_TODAY'],
      ['new-oldest', 'NEW'],
      ['to-call-newer', 'NEW'],
      ['new-with-future-follow-up', 'NEW'],
      ['retry-never-contacted', 'RETRY'],
      ['retry-contacted-earlier', 'RETRY'],
      ['retry-fewer-calls', 'RETRY'],
      ['retry-more-calls', 'RETRY'],
    ]);
    expect(await queue(other)).toEqual([['x-other-agent', 'VOICEMAIL']]);
  });

  it('excludes leads called in the last 4 hours unless a follow-up is due or a voicemail is unheard', async () => {
    const agent = await createAuthUser(db);
    await createLeadRow(db, { assigned_to: agent, business_name: 'called-3h59m-ago', status: 'NO_ANSWER', last_contacted_at: ago(4 * HOUR - MINUTE) });
    await createLeadRow(db, { assigned_to: agent, business_name: 'called-4h01m-ago', status: 'NO_ANSWER', last_contacted_at: ago(4 * HOUR + MINUTE) });
    const due = await createLeadRow(db, { assigned_to: agent, business_name: 'recent-but-due', status: 'CONNECTED', last_contacted_at: ago(10 * MINUTE) });
    await createFollowUpRow(db, { lead_id: due.id, user_id: agent, due_at: ago(5 * MINUTE) });
    const notYet = await createLeadRow(db, { assigned_to: agent, business_name: 'recent-follow-up-later', status: 'NEW', last_contacted_at: ago(10 * MINUTE) });
    await createFollowUpRow(db, { lead_id: notYet.id, user_id: agent, due_at: ahead(10 * MINUTE) });

    expect(await queue(agent)).toEqual([
      ['recent-but-due', 'OVERDUE'],
      ['called-4h01m-ago', 'RETRY'],
    ]);
  });

  it('honours the skip list and ignores null arrays and null elements', async () => {
    const agent = await createAuthUser(db);
    const first = await createLeadRow(db, { assigned_to: agent, business_name: 'first', created_at: ago(2 * DAY) });
    const second = await createLeadRow(db, { assigned_to: agent, business_name: 'second', created_at: ago(1 * DAY) });
    expect((await nextLead(agent))?.lead_id).toBe(first.id);
    expect((await nextLead(agent, [first.id]))?.lead_id).toBe(second.id);
    expect(await nextLead(agent, [first.id, second.id])).toBeUndefined();

    const viaNulls = await asUser(db, agent, async (tx) => {
      const nullArray = await tx.query<NextLead>('select lead_id from public.get_next_lead(null)');
      const nullElement = await tx.query<NextLead>('select lead_id from public.get_next_lead(array[null::uuid, $1::uuid])', [first.id]);
      return [nullArray.rows[0]?.lead_id, nullElement.rows[0]?.lead_id];
    });
    expect(viaNulls).toEqual([first.id, second.id]);
  });

  it("uses only the caller's own assigned leads, for admins too, and returns nothing for inactive users", async () => {
    const agent = await createAuthUser(db);
    await createLeadRow(db, { assigned_to: agent, business_name: 'agent-lead' });
    expect(await nextLead(admin)).toBeUndefined();
    const mine = await createLeadRow(db, { assigned_to: admin, business_name: 'admin-lead' });
    expect((await nextLead(admin))?.lead_id).toBe(mine.id);

    await db.query('update public.profiles set active = false where id = $1', [agent]);
    expect(await nextLead(agent)).toBeUndefined();
  });
});
