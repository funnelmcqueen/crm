// create_outbound_call errors and reassign_leads (follow-ups move, old owner loses everything,
// history hides who made earlier calls from agents).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '' };

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Velo Admin' });
  u.a = await createAuthUser(db, { name: 'Agent Alpha' });
  u.b = await createAuthUser(db, { name: 'Agent Bravo' });
});

afterAll(async () => {
  await db?.close();
});

const createOutbound = async (userId: string, leadId: string | null): Promise<string> =>
  (await userRows<{ id: string }>(db, userId, 'select public.create_outbound_call($1::uuid) as id', [leadId]))[0].id;

describe('create_outbound_call', () => {
  it('inserts an OUTBOUND IN_APP row for an assigned lead', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const id = await createOutbound(u.a, lead.id);
    expect((await adminSqlRows(db, 'select * from public.calls where id = $1', [id]))[0]).toMatchObject({
      lead_id: lead.id,
      user_id: u.a,
      direction: 'OUTBOUND',
      mode: 'IN_APP',
      remote_e164: lead.phone,
      call_status: null,
      outcome: null,
      provider_call_sid: null,
    });
  });

  it("returns not_found for another agent's, unassigned, missing or null leads", async () => {
    const leadB = await createLeadRow(db, { assigned_to: u.b });
    const unassigned = await createLeadRow(db);
    for (const leadId of [leadB.id, unassigned.id, crypto.randomUUID(), null]) {
      expect(await pgError(createOutbound(u.a, leadId))).toEqual({ code: 'P0002', message: 'not_found' });
    }
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.calls where lead_id = any($1::uuid[])', [[leadB.id, unassigned.id]])).toEqual([
      { n: 0 },
    ]);
  });

  it('blocks DO_NOT_CONTACT leads', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a, status: 'DO_NOT_CONTACT' });
    expect(await pgError(createOutbound(u.a, lead.id))).toEqual({ code: 'P0001', message: 'do_not_contact' });
    expect(await pgError(createOutbound(u.admin, lead.id))).toEqual({ code: 'P0001', message: 'do_not_contact' });
  });

  it('allows one active call per caller', async () => {
    const agent = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: agent });
    const call = await createOutbound(agent, lead.id);
    for (const status of ['queued', 'ringing', 'in-progress']) {
      await db.query('update public.calls set call_status = $2 where id = $1', [call, status]);
      expect(await pgError(createOutbound(agent, lead.id))).toEqual({ code: 'P0001', message: 'call_in_progress' });
    }
    await db.query(`update public.calls set call_status = 'completed' where id = $1`, [call]);
    const next = await createOutbound(agent, lead.id);
    // A live status older than 2 hours is stale and does not block.
    await db.query(`update public.calls set call_status = 'ringing', created_at = now() - interval '3 hours' where id = $1`, [next]);
    expect(await createOutbound(agent, lead.id)).toMatch(/^[0-9a-f-]{36}$/);
    // Another agent's ringing call does not block this caller.
    const other = await createAuthUser(db);
    const otherLead = await createLeadRow(db, { assigned_to: other });
    await createCallRow(db, { lead_id: lead.id, user_id: agent, mode: 'IN_APP', call_status: 'ringing' });
    expect(await createOutbound(other, otherLead.id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is forbidden for inactive callers and callers with in-app calling disabled', async () => {
    const disabled = await createAuthUser(db, { inAppCallingEnabled: false });
    const inactive = await createAuthUser(db, { active: false });
    for (const userId of [disabled, inactive]) {
      const lead = await createLeadRow(db, { assigned_to: userId });
      expect((await pgError(createOutbound(userId, lead.id))).code).toBe('42501');
    }
  });

  it('lets an admin dial any lead, including unassigned ones', async () => {
    const leadB = await createLeadRow(db, { assigned_to: u.b });
    const unassigned = await createLeadRow(db);
    const adminCaller = await createAuthUser(db, { role: 'ADMIN' });
    expect(await createOutbound(adminCaller, leadB.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await createOutbound(u.admin, unassigned.id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('reassign_leads', () => {
  it('rejects non-admins and inactive admins with 42501, and invalid targets with 22023', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const inactiveAdmin = await createAuthUser(db, { role: 'ADMIN', active: false });
    for (const caller of [u.a, u.b, inactiveAdmin]) {
      const err = await pgError(userRows(db, caller, 'select public.reassign_leads(array[$1::uuid], $2::uuid)', [lead.id, caller]));
      expect(err.code).toBe('42501');
    }
    const inactiveAgent = await createAuthUser(db, { active: false });
    for (const target of [inactiveAgent, crypto.randomUUID()]) {
      const err = await pgError(userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid], $2::uuid)', [lead.id, target]));
      expect(err.code).toBe('22023');
    }
    expect(await adminSqlRows(db, 'select assigned_to from public.leads where id = $1', [lead.id])).toEqual([{ assigned_to: u.a }]);
  });

  it('moves the lead and its open follow-ups; the old agent loses everything; history hides callers from agents', async () => {
    const number = await createPhoneNumberRow(db, { assigned_to: u.a });
    const lead = await createLeadRow(db, { assigned_to: u.a, business_name: 'Reassigned Roofing', status: 'INTERESTED' });
    const keep = await createLeadRow(db, { assigned_to: u.a, business_name: 'Kept Roofing' });
    const call = await createCallRow(db, {
      lead_id: lead.id,
      user_id: u.a,
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      phone_number_id: number.id,
      call_status: 'completed',
      outcome: 'INTERESTED',
      notes: 'Wants a quote',
      duration_seconds: 120,
      created_at: new Date(Date.now() - 86_400_000),
    });
    const voicemail = await createCallRow(db, {
      lead_id: lead.id,
      user_id: u.a,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      phone_number_id: number.id,
      voicemail_recording_sid: fakeTwilioSid('RE'),
      voicemail_duration_seconds: 20,
    });
    const openFu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    const doneFu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a, completed_at: new Date() });

    const [{ n }] = await userRows<{ n: number }>(db, u.admin, 'select public.reassign_leads(array[$1::uuid], $2::uuid) as n', [lead.id, u.b]);
    expect(n).toBe(1);

    // Old agent A: nothing left.
    const a = u.a;
    expect(await userRows(db, a, 'select id from public.leads where id = $1', [lead.id])).toEqual([]);
    expect(await userRows(db, a, 'select id from public.calls where lead_id = $1', [lead.id])).toEqual([]);
    expect(await userRows(db, a, 'select id from public.follow_ups where lead_id = $1', [lead.id])).toEqual([]);
    expect(await userRows(db, a, 'select * from public.get_lead_call_history($1)', [lead.id])).toEqual([]);
    expect(await userRows(db, a, `select id from public.search_leads(p_query => 'Reassigned')`)).toEqual([]);
    expect(await userRows(db, a, 'select lead_id from public.get_next_lead() where lead_id = $1', [lead.id])).toEqual([]);
    expect(await userRows(db, a, 'select call_id from public.list_voicemails()')).toEqual([]);
    expect(await serviceRows(db, 'select public.get_voicemail_recording($1, $2) as sid', [voicemail.id, a])).toEqual([{ sid: null }]);
    expect(await userRows(db, a, 'select public.mark_voicemail_heard($1) as ok', [voicemail.id])).toEqual([{ ok: false }]);
    expect(await userRows(db, a, 'select public.can_access_lead($1) as ok', [lead.id])).toEqual([{ ok: false }]);
    expect((await pgError(userRows(db, a, 'select public.create_outbound_call($1)', [lead.id]))).code).toBe('P0002');
    expect((await pgError(userRows(db, a, `select public.log_call('CONNECTED', p_call_id => $1)`, [call.id]))).code).toBe('P0002');
    const stillVisible = (await userRows<{ id: string }>(db, a, 'select id from public.leads')).map((r) => r.id);
    expect(stillVisible).toContain(keep.id);
    expect(stillVisible).not.toContain(lead.id);

    // New agent B: the lead, its history and the open follow-up.
    const b = u.b;
    expect(await userRows(db, b, 'select id from public.leads where id = $1', [lead.id])).toEqual([{ id: lead.id }]);
    expect((await userRows(db, b, 'select id from public.calls where lead_id = $1', [lead.id])).length).toBe(2);
    expect(await userRows(db, b, 'select id, user_id from public.follow_ups where lead_id = $1', [lead.id])).toEqual([
      { id: openFu.id, user_id: b },
    ]);
    const history = await userRows<Record<string, unknown>>(db, b, 'select * from public.get_lead_call_history($1)', [lead.id]);
    expect(history.map((h) => h.id)).toEqual([voicemail.id, call.id]);
    for (const row of history) {
      expect(row).toMatchObject({ is_mine: false, caller_name: null, caller_id_e164: null });
    }
    expect(history[0]).toMatchObject({ has_voicemail: true, voicemail_duration_seconds: 20 });
    expect(history[1]).toMatchObject({ outcome: 'INTERESTED', notes: 'Wants a quote', duration_seconds: 120, has_voicemail: false });
    expect(await serviceRows(db, 'select public.get_voicemail_recording($1, $2) is not null as ok', [voicemail.id, b])).toEqual([{ ok: true }]);

    // Admin sees who called and from which number. Stats stay with the caller.
    const adminHistory = await userRows<Record<string, unknown>>(db, u.admin, 'select * from public.get_lead_call_history($1)', [lead.id]);
    expect(adminHistory[1]).toMatchObject({ caller_name: 'Agent Alpha', caller_id_e164: number.e164, is_mine: false });
    expect(await adminSqlRows(db, 'select user_id from public.calls where id = $1', [call.id])).toEqual([{ user_id: u.a }]);
    expect(await adminSqlRows(db, 'select user_id from public.follow_ups where id = $1', [doneFu.id])).toEqual([{ user_id: u.a }]);
  });

  it('unassigning keeps follow-up owners but hides them from the old agent', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.a });
    const fu = await createFollowUpRow(db, { lead_id: lead.id, user_id: u.a });
    expect(await userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid], null) as n', [lead.id])).toEqual([{ n: 1 }]);
    expect(await adminSqlRows(db, 'select user_id from public.follow_ups where id = $1', [fu.id])).toEqual([{ user_id: u.a }]);
    expect(await userRows(db, u.a, 'select id from public.follow_ups where id = $1', [fu.id])).toEqual([]);
  });

  it('counts existing leads and handles empty or null arrays', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.b });
    expect(
      await userRows(db, u.admin, 'select public.reassign_leads(array[$1::uuid, gen_random_uuid()], $2::uuid) as n', [lead.id, u.b]),
    ).toEqual([{ n: 1 }]);
    expect(await userRows(db, u.admin, `select public.reassign_leads('{}'::uuid[], $1::uuid) as n`, [u.b])).toEqual([{ n: 0 }]);
    expect(await userRows(db, u.admin, 'select public.reassign_leads(null, $1::uuid) as n', [u.b])).toEqual([{ n: 0 }]);
  });
});
