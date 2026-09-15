// Stage 2-5 review regressions in SQL: admin voicemail plays (D20), follow-up bounds in log_call (D21)
// and due-today follow-ups completed by the call that Next Lead served them for (D22).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  asUser,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  fakeTwilioSid,
  nextPhone,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

let db: PGlite;
let admin = '';

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN' });
});

afterAll(async () => {
  await db?.close();
});

function logCall(userId: string, args: { outcome: string; leadId: string; followUpAt?: Date | null }) {
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<{ r: { call_id: string; next_follow_up_at: string | null } }>(
      `select public.log_call(p_outcome => $1::public.call_outcome, p_lead_id => $2::uuid, p_follow_up_at => $3::timestamptz) as r`,
      [args.outcome, args.leadId, args.followUpAt ?? null],
    );
    return rows[0].r;
  });
}

async function nextLead(userId: string): Promise<{ lead_id: string; reason: string } | undefined> {
  const rows = await userRows<{ lead_id: string; reason: string }>(db, userId, 'select lead_id, reason from public.get_next_lead()');
  return rows[0];
}

async function voicemail(values: Record<string, string | null>): Promise<string> {
  const row = await createCallRow(db, {
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    voicemail_recording_sid: fakeTwilioSid('RE'),
    ...values,
  });
  return row.id;
}

async function handledAt(callId: string): Promise<Date | null> {
  const [row] = await adminSqlRows<{ handled_at: Date | null }>(db, 'select handled_at from public.calls where id = $1', [callId]);
  return row.handled_at;
}

const markHeard = async (userId: string, callId: string) =>
  (await userRows<{ ok: boolean }>(db, userId, 'select public.mark_voicemail_heard($1) as ok', [callId]))[0].ok;

/** A zone where it is currently between 02:00 and 20:59, so "now + 1h" is still today there. */
function zoneWithDaytime(): string {
  const candidates = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Honolulu'];
  for (const zone of candidates) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour >= 2 && hour <= 20) return zone;
  }
  throw new Error('no daytime zone found');
}

describe('mark_voicemail_heard: an admin play never clears the owner\'s unheard voicemail', () => {
  it("leaves an agent's lead voicemail unheard for the agent (badge and Next Lead priority stay)", async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent, status: 'CONNECTED', last_contacted_at: new Date(Date.now() - HOUR) });
    const vm = await voicemail({ lead_id: lead.id, user_id: agent });
    expect(await userRows(db, agent, 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 1 }]);
    expect(await nextLead(agent)).toEqual({ lead_id: lead.id, reason: 'VOICEMAIL' });

    expect(await markHeard(admin, vm)).toBe(true);

    expect(await handledAt(vm)).toBeNull();
    expect(await userRows(db, agent, 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 1 }]);
    expect(await nextLead(agent)).toEqual({ lead_id: lead.id, reason: 'VOICEMAIL' });

    expect(await markHeard(agent, vm)).toBe(true);
    expect(await handledAt(vm)).not.toBeNull();
  });

  it("leaves an agent's unmatched voicemail (routed to their number) unheard for that agent", async () => {
    const agent = await createAuthUser(db);
    const vm = await voicemail({ lead_id: null, user_id: agent, remote_e164: nextPhone() });
    expect(await markHeard(admin, vm)).toBe(true);
    expect(await handledAt(vm)).toBeNull();
  });

  it('marks voicemails that only admins see (admin-only unmatched, unassigned lead, lead assigned to the admin) as heard', async () => {
    const adminOnly = await voicemail({ lead_id: null, user_id: null, remote_e164: nextPhone() });
    const unassigned = await createLeadRow(db, { assigned_to: null });
    const onUnassigned = await voicemail({ lead_id: unassigned.id, user_id: null });
    const ownLead = await createLeadRow(db, { assigned_to: admin });
    const onOwn = await voicemail({ lead_id: ownLead.id, user_id: admin });
    for (const id of [adminOnly, onUnassigned, onOwn]) {
      expect(await markHeard(admin, id)).toBe(true);
      expect(await handledAt(id)).not.toBeNull();
    }
  });
});

describe('log_call follow-up bounds', () => {
  it('refuses a follow-up in the past or more than five years ahead, and changes nothing', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent, status: 'NEW' });
    for (const followUpAt of [new Date('1970-01-01T00:00:00Z'), new Date(Date.now() - 10 * MINUTE), new Date(Date.now() + 5 * YEAR + DAY), new Date('9999-12-31T00:00:00Z')]) {
      const err = await pgError(logCall(agent, { outcome: 'FOLLOW_UP', leadId: lead.id, followUpAt }));
      expect({ followUpAt, code: err.code }).toEqual({ followUpAt, code: '22023' });
    }
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.follow_ups where lead_id = $1', [lead.id])).toEqual([{ n: 0 }]);
    expect(await adminSqlRows(db, 'select call_count, status from public.leads where id = $1', [lead.id])).toEqual([{ call_count: 0, status: 'NEW' }]);
    expect(await nextLead(agent)).toEqual({ lead_id: lead.id, reason: 'NEW' });
  });

  it('accepts a follow-up a few seconds old (clock skew) and one just under five years ahead', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    await logCall(agent, { outcome: 'FOLLOW_UP', leadId: lead.id, followUpAt: new Date(Date.now() - 20_000) });
    const other = await createLeadRow(db, { assigned_to: agent });
    await logCall(agent, { outcome: 'FOLLOW_UP', leadId: other.id, followUpAt: new Date(Date.now() + 5 * YEAR - DAY) });
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.follow_ups where lead_id = any($1::uuid[])', [[lead.id, other.id]])).toEqual([{ n: 2 }]);
  });
});

describe('log_call completes the due-today follow-up Next Lead served', () => {
  it('a call logged before a DUE_TODAY follow-up is due completes it, so the lead does not come back as OVERDUE', async () => {
    const agent = await createAuthUser(db, { timezone: zoneWithDaytime() });
    const lead = await createLeadRow(db, { assigned_to: agent, status: 'FOLLOW_UP', last_contacted_at: new Date(Date.now() - 2 * DAY) });
    const dueToday = await createFollowUpRow(db, { lead_id: lead.id, user_id: agent, due_at: new Date(Date.now() + HOUR) });
    const later = await createFollowUpRow(db, { lead_id: lead.id, user_id: agent, due_at: new Date(Date.now() + 3 * DAY) });
    expect(await nextLead(agent)).toEqual({ lead_id: lead.id, reason: 'DUE_TODAY' });

    await logCall(agent, { outcome: 'NO_ANSWER', leadId: lead.id });

    const rows = await adminSqlRows<{ id: string; completed_at: Date | null }>(db, 'select id, completed_at from public.follow_ups where lead_id = $1', [lead.id]);
    expect(rows.find((row) => row.id === dueToday.id)?.completed_at).not.toBeNull();
    expect(rows.find((row) => row.id === later.id)?.completed_at).toBeNull();

    // The clock reaching the original due time must not resurface the lead.
    await db.query(`update public.follow_ups set due_at = now() - interval '1 minute' where id = $1`, [dueToday.id]);
    expect(await nextLead(agent)).toBeUndefined();
  });

  it('a follow-up created by the same log for later today stays open', async () => {
    const agent = await createAuthUser(db, { timezone: zoneWithDaytime() });
    const lead = await createLeadRow(db, { assigned_to: agent });
    const due = new Date(Date.now() + 30 * MINUTE);
    const result = await logCall(agent, { outcome: 'FOLLOW_UP', leadId: lead.id, followUpAt: due });
    expect(new Date(result.next_follow_up_at as string).getTime()).toBe(due.getTime());
    expect(await adminSqlRows(db, 'select completed_at from public.follow_ups where lead_id = $1', [lead.id])).toEqual([{ completed_at: null }]);
  });

  it("an admin logging on an agent's lead uses the agent's day", async () => {
    // The admin's zone is far from the agent's, so "today" differs for most of the day.
    const agentZone = zoneWithDaytime();
    const agent = await createAuthUser(db, { timezone: agentZone });
    const farAdmin = await createAuthUser(db, { role: 'ADMIN', timezone: agentZone === 'Pacific/Auckland' ? 'Pacific/Honolulu' : 'Pacific/Kiritimati' });
    const lead = await createLeadRow(db, { assigned_to: agent, status: 'FOLLOW_UP' });
    const dueToday = await createFollowUpRow(db, { lead_id: lead.id, user_id: agent, due_at: new Date(Date.now() + HOUR) });
    await logCall(farAdmin, { outcome: 'CONNECTED', leadId: lead.id });
    expect((await adminSqlRows<{ completed_at: Date | null }>(db, 'select completed_at from public.follow_ups where id = $1', [dueToday.id]))[0].completed_at).not.toBeNull();
  });
});
