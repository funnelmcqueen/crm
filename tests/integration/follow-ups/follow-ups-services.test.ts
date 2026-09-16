// Follow-up services (SPEC 8 Follow-ups, SPEC 3 "manage their own follow-ups", SPEC 7c voicemails, SPEC 1
// isolation) through real user sessions: lists, counts, complete, reschedule and the voicemails tab.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { followUpQuickPicks } from '@/lib/domain/time';
import type { RequestContext } from '@/server/context';
import {
  completeFollowUp,
  followUpCounts,
  listFollowUps,
  listVoicemails,
  rescheduleFollowUp,
  rescheduleFollowUpTo,
  type VoicemailRow,
} from '@/server/services/follow-ups';
import { serviceClient } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import {
  createCall,
  createFollowUp,
  createLead,
  createUser,
  disableUser,
  fakeTwilioSid,
  fictionalPhone,
  type FixtureUser,
  type Lead,
} from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TAG = `FU${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = 'America/New_York';
const AKL = 'Pacific/Auckland';

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxB: RequestContext;
let ctxAdmin: RequestContext;
let leadA: Lead;
let leadB: Lead;

const f = { aAncient: '', aOverdue: '', aUpcoming: '', aCompleted: '', bAncient: '', bOpen: '', bCompleted: '' };
const vm = { aLead: '', aRouted: '', aHeard: '', b: '', adminOnly: '' };
let adminOnlyPhone = '';

const iso = (time: number) => new Date(time).toISOString();

async function followUpRow(id: string) {
  const { data } = await serviceClient().from('follow_ups').select('id, user_id, lead_id, due_at, completed_at, note').eq('id', id).maybeSingle();
  return data;
}

async function inboundVoicemail(values: { lead_id: string | null; user_id: string | null; handled?: boolean; remote?: string }) {
  const call = await createCall({
    lead_id: values.lead_id,
    user_id: values.user_id,
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    voicemail_recording_sid: fakeTwilioSid('RE'),
    voicemail_duration_seconds: 17,
    remote_e164: values.remote ?? fictionalPhone(),
    handled_at: values.handled ? new Date().toISOString() : null,
  });
  return call.id;
}

/** Wall-clock `yyyy-MM-ddTHH:mm` of an instant in `tz`, computed with Intl only (independent of the app helpers). */
function wallClock(value: string | Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Finds rows by id across every page of an admin list (other test files add rows concurrently). */
async function findVoicemails(ctx: RequestContext, callIds: string[]): Promise<Map<string, VoicemailRow>> {
  const found = new Map<string, VoicemailRow>();
  for (let page = 1; page <= 200; page += 1) {
    const result = await listVoicemails(ctx, { page });
    for (const row of result.rows) if (callIds.includes(row.callId)) found.set(row.callId, row);
    if (found.size === callIds.length || page >= result.pageCount) break;
  }
  return found;
}

beforeAll(async () => {
  [agentA, agentB] = await Promise.all([
    createUser({ name: `Follow Agent A ${TAG}`, timezone: NY }),
    createUser({ name: `Follow Agent B ${TAG}`, timezone: AKL }),
  ]);
  [ctxA, ctxB, ctxAdmin] = await Promise.all([contextForUser(agentA), contextForUser(agentB), signInSeeded('admin').then(contextFor)]);
  [leadA, leadB] = await Promise.all([
    createLead({ business_name: `${TAG} A lead`, contact_name: 'Ada Contact', assigned_to: agentA.id }),
    createLead({ business_name: `${TAG} B lead`, assigned_to: agentB.id }),
  ]);

  const now = Date.now();
  // Year-2000 due dates sort first in the admin's Overdue tab, whatever else the shared stack holds.
  f.aAncient = (await createFollowUp({ lead_id: leadA.id, user_id: agentA.id, due_at: '2000-01-01T00:00:00.000Z', note: 'ancient A' })).id;
  f.bAncient = (await createFollowUp({ lead_id: leadB.id, user_id: agentB.id, due_at: '2000-01-01T00:00:01.000Z', note: 'ancient B' })).id;
  f.aOverdue = (await createFollowUp({ lead_id: leadA.id, user_id: agentA.id, due_at: iso(now - 2 * DAY), note: 'overdue A' })).id;
  f.aUpcoming = (await createFollowUp({ lead_id: leadA.id, user_id: agentA.id, due_at: iso(now + 10 * DAY), note: 'upcoming A' })).id;
  f.aCompleted = (
    await createFollowUp({ lead_id: leadA.id, user_id: agentA.id, due_at: iso(now - DAY), completed_at: iso(now - HOUR), note: 'done A' })
  ).id;
  f.bOpen = (await createFollowUp({ lead_id: leadB.id, user_id: agentB.id, due_at: iso(now + 3 * DAY), note: 'open B' })).id;
  f.bCompleted = (
    await createFollowUp({ lead_id: leadB.id, user_id: agentB.id, due_at: iso(now - DAY), completed_at: iso(now - HOUR), note: 'done B' })
  ).id;

  adminOnlyPhone = fictionalPhone();
  vm.aHeard = await inboundVoicemail({ lead_id: leadA.id, user_id: agentA.id, handled: true });
  vm.aLead = await inboundVoicemail({ lead_id: leadA.id, user_id: agentA.id });
  vm.aRouted = await inboundVoicemail({ lead_id: null, user_id: agentA.id });
  vm.b = await inboundVoicemail({ lead_id: leadB.id, user_id: agentB.id });
  vm.adminOnly = await inboundVoicemail({ lead_id: null, user_id: null, remote: adminOnlyPhone });
});

describe('listFollowUps', () => {
  it('an agent gets only their own follow-ups in each tab, without owner names', async () => {
    const overdue = await listFollowUps(ctxA, 'overdue');
    expect(overdue.rows.map((row) => row.id)).toEqual([f.aAncient, f.aOverdue]);
    expect(overdue.total).toBe(2);
    expect((await listFollowUps(ctxA, 'today')).rows).toEqual([]);
    expect((await listFollowUps(ctxA, 'upcoming')).rows.map((row) => row.id)).toEqual([f.aUpcoming]);
    const completed = await listFollowUps(ctxA, 'completed');
    expect(completed.rows.map((row) => row.id)).toEqual([f.aCompleted]);
    expect(completed.rows[0].completedAt).not.toBeNull();

    const all = [...overdue.rows, ...completed.rows];
    expect(all.every((row) => row.ownerName === null)).toBe(true);
    expect(overdue.rows[0]).toMatchObject({
      leadId: leadA.id,
      businessName: `${TAG} A lead`,
      contactName: 'Ada Contact',
      phone: leadA.phone,
      leadStatus: 'NEW',
      note: 'ancient A',
      dueAt: expect.any(String),
    });

    const bSeen = (await Promise.all((['overdue', 'today', 'upcoming', 'completed'] as const).map((tab) => listFollowUps(ctxB, tab))))
      .flatMap((result) => result.rows.map((row) => row.id))
      .sort();
    expect(bSeen).toEqual([f.bAncient, f.bOpen, f.bCompleted].sort());
  });

  it('an admin sees every agent with owner names', async () => {
    const overdue = await listFollowUps(ctxAdmin, 'overdue');
    const byId = new Map(overdue.rows.map((row) => [row.id, row]));
    expect(byId.get(f.aAncient)?.ownerName).toBe(`Follow Agent A ${TAG}`);
    expect(byId.get(f.bAncient)?.ownerName).toBe(`Follow Agent B ${TAG}`);
  });

  it('validates the tab and page, and reports the total past the last page', async () => {
    await expect(listFollowUps(ctxA, 'voicemails')).rejects.toMatchObject({ code: 'validation' });
    await expect(listFollowUps(ctxA, "overdue'; drop table leads;--")).rejects.toMatchObject({ code: 'validation' });
    await expect(listFollowUps(ctxA, 'overdue', 0)).rejects.toMatchObject({ code: 'validation' });
    await expect(listFollowUps(ctxA, 'overdue', 1.5)).rejects.toMatchObject({ code: 'validation' });
    const past = await listFollowUps(ctxA, 'overdue', 3);
    expect(past).toMatchObject({ rows: [], total: 2, page: 3, pageCount: 1, from: 0, to: 0 });
  });

  it('requires a session', async () => {
    await expect(listFollowUps(null, 'today')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(followUpCounts(null)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(listVoicemails(null)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(completeFollowUp(null, f.aOverdue)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(rescheduleFollowUp(null, f.aOverdue, iso(Date.now() + DAY))).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('followUpCounts', () => {
  it('is scoped to the caller', async () => {
    // A has three voicemails (aHeard, aLead, aRouted) of which two are unheard: the badge counts the
    // rows the tab lists, the unheard count only drives its styling.
    expect(await followUpCounts(ctxA)).toEqual({
      overdue: 2,
      today: 0,
      upcoming: 1,
      completed: 1,
      voicemailsTotal: 3,
      voicemailsUnheard: 2,
    });
    expect(await followUpCounts(ctxB)).toEqual({
      overdue: 1,
      today: 0,
      upcoming: 1,
      completed: 1,
      voicemailsTotal: 1,
      voicemailsUnheard: 1,
    });
    const admin = await followUpCounts(ctxAdmin);
    expect(admin.overdue).toBeGreaterThanOrEqual(3);
    expect(admin.voicemailsUnheard).toBeGreaterThanOrEqual(4);
    // The admin sees every voicemail: A's three, B's one and the unmatched one, plus any other file's.
    expect(admin.voicemailsTotal).toBeGreaterThanOrEqual(5);
    expect(admin.voicemailsTotal).toBeGreaterThanOrEqual(admin.voicemailsUnheard);
  });
});

describe('completeFollowUp', () => {
  it("another agent's follow-up is not_found and unchanged, like random and malformed ids", async () => {
    const before = await followUpRow(f.bOpen);
    await expect(completeFollowUp(ctxA, f.bOpen)).rejects.toMatchObject({ code: 'not_found' });
    await expect(completeFollowUp(ctxA, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    await expect(completeFollowUp(ctxA, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    await expect(completeFollowUp(ctxA, 42)).rejects.toMatchObject({ code: 'not_found' });
    expect(await followUpRow(f.bOpen)).toEqual(before);
  });

  it('completes an own open follow-up once, moves it to Completed and refreshes the lead', async () => {
    const lead = await createLead({ business_name: `${TAG} complete`, assigned_to: agentA.id });
    const first = await createFollowUp({ lead_id: lead.id, user_id: agentA.id, due_at: iso(Date.now() + 2 * DAY) });
    const second = await createFollowUp({ lead_id: lead.id, user_id: agentA.id, due_at: iso(Date.now() + 5 * DAY) });

    const result = await completeFollowUp(ctxA, first.id);
    expect(result.id).toBe(first.id);
    expect(Math.abs(Date.parse(result.completedAt) - Date.now())).toBeLessThan(60_000);
    await expect(completeFollowUp(ctxA, first.id)).rejects.toMatchObject({ code: 'not_found' });

    expect((await listFollowUps(ctxA, 'completed')).rows.map((row) => row.id)).toContain(first.id);
    expect((await listFollowUps(ctxA, 'upcoming')).rows.map((row) => row.id)).not.toContain(first.id);
    const { data: leadRow } = await serviceClient().from('leads').select('next_follow_up_at').eq('id', lead.id).single();
    expect(Date.parse(leadRow?.next_follow_up_at ?? '')).toBe(Date.parse(second.due_at));
  });

  it('an admin can complete an agent follow-up', async () => {
    const extra = await createFollowUp({ lead_id: leadB.id, user_id: agentB.id, due_at: iso(Date.now() + 20 * DAY) });
    await expect(completeFollowUp(ctxAdmin, extra.id)).resolves.toMatchObject({ id: extra.id });
    expect((await followUpRow(extra.id))?.completed_at).not.toBeNull();
  });

  it('a disabled agent with a still-valid token cannot complete or list anything', async () => {
    const gone = await createUser({ name: `Follow Gone ${TAG}` });
    const ctxGone = await contextForUser(gone);
    const lead = await createLead({ business_name: `${TAG} gone`, assigned_to: gone.id });
    const open = await createFollowUp({ lead_id: lead.id, user_id: gone.id, due_at: iso(Date.now() - HOUR) });
    expect((await listFollowUps(ctxGone, 'overdue')).rows.map((row) => row.id)).toEqual([open.id]);
    await disableUser(gone.id);
    expect((await listFollowUps(ctxGone, 'overdue')).rows).toEqual([]);
    expect(await followUpCounts(ctxGone)).toEqual({
      overdue: 0,
      today: 0,
      upcoming: 0,
      completed: 0,
      voicemailsTotal: 0,
      voicemailsUnheard: 0,
    });
    await expect(completeFollowUp(ctxGone, open.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await followUpRow(open.id))?.completed_at).toBeNull();
  });
});

describe('rescheduleFollowUp', () => {
  it("another agent's follow-up is not_found and unchanged", async () => {
    const before = await followUpRow(f.bOpen);
    await expect(rescheduleFollowUp(ctxA, f.bOpen, iso(Date.now() + 4 * DAY))).rejects.toMatchObject({ code: 'not_found' });
    await expect(rescheduleFollowUpTo(ctxA, f.bOpen, { kind: 'quick', pick: 'nextWeek' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(rescheduleFollowUpTo(ctxA, f.bOpen, { kind: 'custom', local: '2030-01-01T10:00' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await followUpRow(f.bOpen)).toEqual(before);
  });

  it('a completed follow-up is not_found and keeps its due time', async () => {
    const before = await followUpRow(f.aCompleted);
    await expect(rescheduleFollowUp(ctxA, f.aCompleted, iso(Date.now() + DAY))).rejects.toMatchObject({ code: 'not_found' });
    expect(await followUpRow(f.aCompleted)).toEqual(before);
  });

  it('rejects times in the past, beyond five years, or malformed', async () => {
    const lead = await createLead({ business_name: `${TAG} bounds`, assigned_to: agentA.id });
    const open = await createFollowUp({ lead_id: lead.id, user_id: agentA.id, due_at: iso(Date.now() + DAY) });
    const before = await followUpRow(open.id);
    for (const bad of [iso(Date.now() - HOUR), iso(Date.now() + 1830 * DAY), 'tomorrow', '2030-01-01T10:00', null]) {
      await expect(rescheduleFollowUp(ctxA, open.id, bad), String(bad)).rejects.toMatchObject({ code: 'validation' });
    }
    for (const bad of [{ kind: 'custom', local: 'not a date' }, { kind: 'quick', pick: 'yesterday' }, { kind: 'other' }, 'nextWeek', null]) {
      await expect(rescheduleFollowUpTo(ctxA, open.id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'validation' });
    }
    expect(await followUpRow(open.id)).toEqual(before);
  });

  it('moves an own open follow-up and updates the lead', async () => {
    const lead = await createLead({ business_name: `${TAG} move`, assigned_to: agentA.id });
    const open = await createFollowUp({ lead_id: lead.id, user_id: agentA.id, due_at: iso(Date.now() + DAY) });
    const target = new Date(Date.now() + 9 * DAY);
    target.setUTCMilliseconds(0);
    const result = await rescheduleFollowUp(ctxA, open.id, target.toISOString());
    expect(Date.parse(result.dueAt)).toBe(target.getTime());
    const { data: leadRow } = await serviceClient().from('leads').select('next_follow_up_at').eq('id', lead.id).single();
    expect(Date.parse(leadRow?.next_follow_up_at ?? '')).toBe(target.getTime());
  });

  it('converts a Custom local time in the caller profile time zone', async () => {
    const leadNy = await createLead({ business_name: `${TAG} custom ny`, assigned_to: agentA.id });
    const leadAkl = await createLead({ business_name: `${TAG} custom akl`, assigned_to: agentB.id });
    const openNy = await createFollowUp({ lead_id: leadNy.id, user_id: agentA.id, due_at: iso(Date.now() + DAY) });
    const openAkl = await createFollowUp({ lead_id: leadAkl.id, user_id: agentB.id, due_at: iso(Date.now() + DAY) });
    // 40 days ahead at 15:45 local, as a datetime-local input would send it.
    const local = `${wallClock(new Date(Date.now() + 40 * DAY), 'UTC').slice(0, 10)}T15:45`;

    const ny = await rescheduleFollowUpTo(ctxA, openNy.id, { kind: 'custom', local });
    const akl = await rescheduleFollowUpTo(ctxB, openAkl.id, { kind: 'custom', local });
    expect(wallClock(ny.dueAt, NY)).toBe(local);
    expect(wallClock(akl.dueAt, AKL)).toBe(local);
    // Auckland is 16 to 18 hours ahead of New York, so the same wall-clock time happens that much earlier there.
    const hoursApart = (Date.parse(ny.dueAt) - Date.parse(akl.dueAt)) / HOUR;
    expect([16, 17, 18]).toContain(hoursApart);
  });

  it('quick picks resolve at 09:00 in the caller profile time zone', async () => {
    const lead = await createLead({ business_name: `${TAG} quick`, assigned_to: agentB.id });
    const open = await createFollowUp({ lead_id: lead.id, user_id: agentB.id, due_at: iso(Date.now() + DAY) });
    const expected = followUpQuickPicks(AKL);
    const tomorrow = await rescheduleFollowUpTo(ctxB, open.id, { kind: 'quick', pick: 'tomorrow9am' });
    expect(Date.parse(tomorrow.dueAt)).toBe(expected.tomorrow9am.getTime());
    expect(wallClock(tomorrow.dueAt, AKL).slice(11)).toBe('09:00');
    const nextWeek = await rescheduleFollowUpTo(ctxB, open.id, { kind: 'quick', pick: 'nextWeek' });
    expect(Date.parse(nextWeek.dueAt)).toBe(expected.nextWeek.getTime());
    const in3 = await rescheduleFollowUpTo(ctxB, open.id, { kind: 'quick', pick: 'in3Days' });
    expect(Date.parse(in3.dueAt)).toBe(expected.in3Days.getTime());
  });
});

describe('listVoicemails', () => {
  it("an agent sees own-lead and routed voicemails only, never B's or admin-only ones", async () => {
    const result = await listVoicemails(ctxA);
    expect(result.rows.map((row) => row.callId).sort()).toEqual([vm.aLead, vm.aRouted, vm.aHeard].sort());
    expect(result.total).toBe(3);
    const byId = new Map(result.rows.map((row) => [row.callId, row]));
    expect(byId.get(vm.aLead)).toMatchObject({
      leadId: leadA.id,
      businessName: `${TAG} A lead`,
      contactName: 'Ada Contact',
      phone: leadA.phone,
      leadStatus: 'NEW',
      durationSeconds: 17,
      unheard: true,
      canMarkHeard: true,
    });
    expect(byId.get(vm.aRouted)).toMatchObject({ leadId: null, businessName: null, leadStatus: null, unheard: true, canMarkHeard: true });
    expect(byId.get(vm.aRouted)?.phone).toMatch(/^\+1\d{10}$/);
    expect(byId.get(vm.aHeard)?.unheard).toBe(false);

    expect((await listVoicemails(ctxB)).rows.map((row) => row.callId)).toEqual([vm.b]);
  });

  it('filters unheard only and pages', async () => {
    const unheard = await listVoicemails(ctxA, { unheardOnly: true });
    expect(unheard.rows.map((row) => row.callId).sort()).toEqual([vm.aLead, vm.aRouted].sort());
    expect(unheard.unheardOnly).toBe(true);
    const past = await listVoicemails(ctxA, { page: 4 });
    expect(past).toMatchObject({ rows: [], total: 3, page: 4 });
    await expect(listVoicemails(ctxA, { page: 0 })).rejects.toMatchObject({ code: 'validation' });
    await expect(listVoicemails(ctxA, { page: 1, extra: true } as never)).rejects.toMatchObject({ code: 'validation' });
  });

  it('an admin sees the admin-only voicemail and may mark only unowned ones heard', async () => {
    const found = await findVoicemails(ctxAdmin, [vm.adminOnly, vm.aLead, vm.aRouted, vm.b]);
    expect(found.get(vm.adminOnly)).toMatchObject({ leadId: null, phone: adminOnlyPhone, canMarkHeard: true });
    expect(found.get(vm.aLead)?.canMarkHeard).toBe(false);
    expect(found.get(vm.b)?.canMarkHeard).toBe(false);
    expect(found.get(vm.aRouted)?.canMarkHeard).toBe(true);
  });
});
