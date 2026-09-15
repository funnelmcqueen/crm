// Service-role webhook functions: claim_caller_id rotation, apply_call_status idempotency and
// terminal precedence, record_voicemail idempotency.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;

beforeAll(async () => {
  db = await bootDb();
});

afterAll(async () => {
  await db?.close();
});

async function claim(userId: string | null): Promise<string | null> {
  const rows = await serviceRows<{ phone_number_id: string }>(db, 'select phone_number_id from public.claim_caller_id($1::uuid)', [userId]);
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.phone_number_id ?? null;
}

describe('claim_caller_id', () => {
  const base = Date.now() - 30 * 86_400_000;
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  it("rotates the caller's assigned numbers first, then the pool, skipping inactive numbers", async () => {
    const agent = await createAuthUser(db);
    const other = await createAuthUser(db);
    const pool = await createAuthUser(db);

    const mine1 = await createPhoneNumberRow(db, { assigned_to: agent, created_at: at(1) });
    const mine2 = await createPhoneNumberRow(db, { assigned_to: agent, created_at: at(2) });
    await createPhoneNumberRow(db, { assigned_to: agent, active: false, created_at: at(0) });
    const othersNumber = await createPhoneNumberRow(db, { assigned_to: other, created_at: at(0) });
    const pool1 = await createPhoneNumberRow(db, { created_at: at(3) });
    const pool2 = await createPhoneNumberRow(db, { created_at: at(4) });
    const pool3 = await createPhoneNumberRow(db, { created_at: at(5), last_used_at: at(6) });
    await createPhoneNumberRow(db, { active: false, created_at: at(0) });

    expect([await claim(agent), await claim(agent), await claim(agent), await claim(agent)]).toEqual([mine1.id, mine2.id, mine1.id, mine2.id]);

    // No assigned number: least recently used pool number first (never used ones before used ones).
    const poolOrder = [];
    for (let i = 0; i < 6; i += 1) poolOrder.push(await claim(pool));
    expect(poolOrder).toEqual([pool1.id, pool2.id, pool3.id, pool1.id, pool2.id, pool3.id]);
    expect(poolOrder).not.toContain(othersNumber.id);

    const [row] = await adminSqlRows<{ last_used_at: Date }>(db, 'select last_used_at from public.phone_numbers where id = $1', [pool3.id]);
    expect(Date.now() - row.last_used_at.getTime()).toBeLessThan(60_000);

    expect(await claim(other)).toBe(othersNumber.id);
  });

  it('returns nothing for inactive, missing or null users', async () => {
    const inactive = await createAuthUser(db, { active: false });
    await createPhoneNumberRow(db, { assigned_to: inactive });
    expect(await claim(inactive)).toBeNull();
    expect(await claim(crypto.randomUUID())).toBeNull();
    expect(await claim(null)).toBeNull();
  });

  it('returns nothing when no active number is available', async () => {
    const agent = await createAuthUser(db);
    await db.query('update public.phone_numbers set active = false where assigned_to is null');
    expect(await claim(agent)).toBeNull();
  });

  it('is not callable by authenticated users', async () => {
    const agent = await createAuthUser(db);
    expect((await pgError(userRows(db, agent, 'select * from public.claim_caller_id($1)', [agent]))).code).toBe('42501');
  });
});

describe('apply_call_status', () => {
  async function outboundCall(): Promise<{ id: string; sid: string }> {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    const sid = fakeTwilioSid('CA');
    const call = await createCallRow(db, { lead_id: lead.id, user_id: agent, mode: 'IN_APP', provider_call_sid: sid, call_status: 'queued' });
    return { id: call.id, sid };
  }

  const apply = async (sid: string, status: string, duration: number | null = null): Promise<boolean> =>
    (await serviceRows<{ ok: boolean }>(db, 'select public.apply_call_status($1, $2, $3) as ok', [sid, status, duration]))[0].ok;

  const state = async (id: string) =>
    (await adminSqlRows<{ call_status: string; duration_seconds: number | null }>(
      db,
      'select call_status, duration_seconds from public.calls where id = $1',
      [id],
    ))[0];

  it('moves forward, never backwards, and is idempotent under retries', async () => {
    const call = await outboundCall();
    expect(await apply(call.sid, 'ringing')).toBe(true);
    expect(await apply(call.sid, 'queued')).toBe(true);
    expect(await state(call.id)).toEqual({ call_status: 'ringing', duration_seconds: null });
    await apply(call.sid, 'in-progress');
    await apply(call.sid, 'ringing');
    expect(await state(call.id)).toEqual({ call_status: 'in-progress', duration_seconds: null });

    await apply(call.sid, 'completed', 30);
    for (let i = 0; i < 3; i += 1) await apply(call.sid, 'completed', 30);
    await apply(call.sid, 'ringing');
    await apply(call.sid, 'in-progress', 5);
    await apply(call.sid, 'no-answer', 10);
    expect(await state(call.id)).toEqual({ call_status: 'completed', duration_seconds: 30 });
  });

  it('lets a terminal status be replaced only while the duration is still unknown', async () => {
    const call = await outboundCall();
    await apply(call.sid, 'no-answer');
    expect(await state(call.id)).toEqual({ call_status: 'no-answer', duration_seconds: null });
    await apply(call.sid, 'busy');
    expect(await state(call.id)).toEqual({ call_status: 'no-answer', duration_seconds: null });
    await apply(call.sid, 'completed', 12);
    expect(await state(call.id)).toEqual({ call_status: 'completed', duration_seconds: 12 });
    await apply(call.sid, 'failed', 5);
    await apply(call.sid, 'canceled', 40);
    expect(await state(call.id)).toEqual({ call_status: 'completed', duration_seconds: 40 });
  });

  it('handles out-of-order delivery (terminal first)', async () => {
    const call = await outboundCall();
    await apply(call.sid, 'completed', 61);
    await apply(call.sid, 'in-progress');
    await apply(call.sid, 'ringing');
    await apply(call.sid, 'queued');
    expect(await state(call.id)).toEqual({ call_status: 'completed', duration_seconds: 61 });
  });

  it('returns false for unknown or blank SIDs and validates input', async () => {
    expect(await apply(fakeTwilioSid('CA'), 'ringing')).toBe(false);
    expect(await apply('  ', 'ringing')).toBe(false);
    const call = await outboundCall();
    expect((await pgError(apply(call.sid, 'answered'))).code).toBe('22023');
    expect((await pgError(apply(call.sid, 'completed', -1))).code).toBe('22023');
  });
});

describe('record_voicemail', () => {
  const record = async (sid: string, recordingSid: string, duration: number | null = 17): Promise<boolean> =>
    (await serviceRows<{ ok: boolean }>(db, 'select public.record_voicemail($1, $2, $3) as ok', [sid, recordingSid, duration]))[0].ok;

  async function inboundCall(leadOwner: string | null | 'none'): Promise<{ id: string; sid: string; leadId: string | null }> {
    const sid = fakeTwilioSid('CA');
    let leadId: string | null = null;
    if (leadOwner !== 'none') leadId = (await createLeadRow(db, { assigned_to: leadOwner })).id;
    const call = await createCallRow(db, {
      lead_id: leadId,
      user_id: leadOwner === 'none' ? null : leadOwner,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: sid,
    });
    return { id: call.id, sid, leadId };
  }

  it('stores the first recording once and creates exactly one follow-up for the lead owner', async () => {
    const agent = await createAuthUser(db);
    const call = await inboundCall(agent);
    const firstRecording = fakeTwilioSid('RE');
    expect(await record(call.sid, firstRecording, 17)).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(await record(call.sid, i === 0 ? firstRecording : fakeTwilioSid('RE'), 99)).toBe(false);

    expect(await adminSqlRows(db, 'select voicemail_recording_sid, voicemail_duration_seconds from public.calls where id = $1', [call.id])).toEqual([
      { voicemail_recording_sid: firstRecording, voicemail_duration_seconds: 17 },
    ]);
    const fus = await adminSqlRows<{ user_id: string; note: string; due_at: Date; completed_at: Date | null }>(
      db,
      'select user_id, note, due_at, completed_at from public.follow_ups where lead_id = $1',
      [call.leadId],
    );
    expect(fus).toHaveLength(1);
    expect(fus[0]).toMatchObject({ user_id: agent, note: 'Voicemail received', completed_at: null });
    expect(Math.abs(Date.now() - fus[0].due_at.getTime())).toBeLessThan(60_000);
    const [lead] = await adminSqlRows<{ next_follow_up_at: Date }>(db, 'select next_follow_up_at from public.leads where id = $1', [call.leadId]);
    expect(lead.next_follow_up_at.getTime()).toBe(fus[0].due_at.getTime());
  });

  it('creates no follow-up for unmatched calls or unassigned leads', async () => {
    const unmatched = await inboundCall('none');
    const unassigned = await inboundCall(null);
    expect(await record(unmatched.sid, fakeTwilioSid('RE'))).toBe(true);
    expect(await record(unassigned.sid, fakeTwilioSid('RE'))).toBe(true);
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.follow_ups where lead_id = $1', [unassigned.leadId])).toEqual([{ n: 0 }]);
  });

  it('returns false for an unknown call and validates input', async () => {
    expect(await record(fakeTwilioSid('CA'), fakeTwilioSid('RE'))).toBe(false);
    const call = await inboundCall('none');
    expect((await pgError(record(' ', fakeTwilioSid('RE')))).code).toBe('22023');
    expect((await pgError(record(call.sid, ''))).code).toBe('22023');
    expect((await pgError(record(call.sid, fakeTwilioSid('RE'), -3))).code).toBe('22023');
  });
});
