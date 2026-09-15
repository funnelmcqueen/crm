// SPEC 5/13 reassignment A -> B: A loses every path to the lead, B gains the lead with its history
// (without learning who made the earlier calls), open follow-ups move to B, and stats stay with A.
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioInbound } from '@/server/http/twilio/inbound';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import {
  createCall,
  createFollowUp,
  createLead,
  createPhoneNumber,
  createUser,
  fakeTwilioSid,
  fictionalPhone,
  type Call,
  type FixtureUser,
  type FollowUp,
  type Lead,
  type PhoneNumber,
} from '../helpers/fixtures';
import { expectEmptyRows, expectError, expectNoRowsAffected } from '../helpers/isolation';
import { signInSeeded } from '../helpers/seeded';
import { WEBHOOK_PATHS, callRowBySid, inboundParams, markOnline, readTwiml, twilioRequest, twimlParts, webhookDeps } from '../routes/_helpers';

const HOUR = 3_600_000;
const CALL_COLUMNS = 'id, created_at, lead_id, direction, mode, remote_e164, call_status, outcome, notes, duration_seconds, voicemail_duration_seconds, handled_at';

let userA: FixtureUser;
let userB: FixtureUser;
let a: SignedInUser;
let b: SignedInUser;
let admin: SignedInUser;
let lead: Lead;
let numberA: PhoneNumber;
let outbound: Call;
let voicemail: Call;
let overdueFollowUp: FollowUp;
let upcomingFollowUp: FollowUp;
let completedFollowUp: FollowUp;

async function nextLeadIds(session: SignedInUser): Promise<string[]> {
  const exclude: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const { data, error } = await session.client.rpc('get_next_lead', { p_exclude_ids: exclude });
    expect(error).toBeNull();
    if (!data || data.length === 0) break;
    exclude.push(data[0].lead_id);
  }
  return exclude;
}

beforeAll(async () => {
  [userA, userB] = await Promise.all([createUser({ name: 'Reassign From' }), createUser({ name: 'Reassign To' })]);
  lead = await createLead({ assigned_to: userA.id, status: 'VOICEMAIL', notes: 'Lead notes travel with the lead' });
  numberA = await createPhoneNumber({ assigned_to: userA.id });
  outbound = await createCall({
    lead_id: lead.id,
    user_id: userA.id,
    direction: 'OUTBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    phone_number_id: numberA.id,
    remote_e164: lead.phone,
    call_status: 'completed',
    outcome: 'VOICEMAIL',
    notes: 'Left a message from A',
    duration_seconds: 31,
    created_at: new Date(Date.now() - 48 * HOUR).toISOString(),
  });
  voicemail = await createCall({
    lead_id: lead.id,
    user_id: userA.id,
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    phone_number_id: numberA.id,
    remote_e164: lead.phone,
    call_status: 'completed',
    voicemail_recording_sid: fakeTwilioSid('RE'),
    voicemail_duration_seconds: 17,
    created_at: new Date(Date.now() - 2 * HOUR).toISOString(),
  });
  [overdueFollowUp, upcomingFollowUp, completedFollowUp] = await Promise.all([
    createFollowUp({ lead_id: lead.id, user_id: userA.id, due_at: new Date(Date.now() - HOUR).toISOString(), note: 'Voicemail received' }),
    createFollowUp({ lead_id: lead.id, user_id: userA.id, due_at: new Date(Date.now() + 30 * HOUR).toISOString(), note: 'Try again' }),
    createFollowUp({
      lead_id: lead.id,
      user_id: userA.id,
      due_at: new Date(Date.now() - 40 * HOUR).toISOString(),
      completed_at: new Date(Date.now() - 39 * HOUR).toISOString(),
      note: 'Done by A',
    }),
  ]);
  [a, b, admin] = await Promise.all([signInAs(userA.email, userA.password), signInAs(userB.email, userB.password), signInSeeded('admin')]);
});

describe('reassignment A -> B', () => {
  it('before: A has the lead, calls, history, voicemail and follow-ups; B has nothing', async () => {
    expect((await a.client.from('leads').select('id').eq('id', lead.id)).data).toEqual([{ id: lead.id }]);
    expect((await a.client.from('calls').select('id').eq('lead_id', lead.id)).data).toHaveLength(2);
    const history = await a.client.rpc('get_lead_call_history', { p_lead_id: lead.id });
    expect(history.data?.map((r) => r.is_mine)).toEqual([true, true]);
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: userA.id })).data).toBe(voicemail.voicemail_recording_sid);
    expectError(await a.client.rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: userA.id }), '42501');
    expect((await a.client.from('follow_ups').select('id').eq('lead_id', lead.id)).data).toHaveLength(3);
    expect(await nextLeadIds(a)).toEqual([lead.id]);

    expectEmptyRows(await b.client.from('leads').select('id').eq('id', lead.id));
    expectEmptyRows(await b.client.from('calls').select('id').eq('lead_id', lead.id));
    expectEmptyRows(await b.client.rpc('get_lead_call_history', { p_lead_id: lead.id }));
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: userB.id })).data).toBeNull();
    expect(await nextLeadIds(b)).toEqual([]);
  });

  it('the admin reassigns with reassign_leads', async () => {
    const { data, error } = await admin.client.rpc('reassign_leads', { p_lead_ids: [lead.id], p_to_user_id: userB.id });
    expect(error).toBeNull();
    expect(data).toBe(1);
  });

  it('A loses the lead, its calls, history, voicemail and follow-ups', async () => {
    expectEmptyRows(await a.client.from('leads').select('id').eq('id', lead.id));
    expectEmptyRows(await a.client.from('leads').select('id'));
    expectEmptyRows(await a.client.rpc('search_leads', { p_query: lead.business_name }));
    expectEmptyRows(await a.client.from('calls').select(CALL_COLUMNS).eq('lead_id', lead.id));
    expectEmptyRows(await a.client.from('calls').select('id').in('id', [outbound.id, voicemail.id]));
    expectEmptyRows(await a.client.rpc('get_lead_call_history', { p_lead_id: lead.id }));
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: userA.id })).data).toBeNull();
    expect((await a.client.rpc('mark_voicemail_heard', { p_call_id: voicemail.id })).data).toBe(false);
    expectEmptyRows(await a.client.rpc('list_voicemails', {}));
    expect((await a.client.rpc('unheard_voicemail_count')).data).toBe(0);
    expectEmptyRows(await a.client.from('follow_ups').select('id').eq('lead_id', lead.id));
    expectEmptyRows(await a.client.from('follow_ups').select('id').eq('id', completedFollowUp.id));
    expect(await nextLeadIds(a)).toEqual([]);
    expect((await a.client.rpc('can_access_lead', { p_lead_id: lead.id })).data).toBe(false);
  });

  it('A can no longer act on the lead, not even on calls A made', async () => {
    expectError(await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_call_id: outbound.id }), 'P0002');
    expectError(await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_call_id: voicemail.id }), 'P0002');
    expectError(await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: lead.id }), 'P0002');
    expectError(await a.client.rpc('create_outbound_call', { p_lead_id: lead.id }), 'P0002');
    expectNoRowsAffected(await a.client.from('leads').update({ status: 'NOT_INTERESTED' }).eq('id', lead.id).select('id'));
    expectNoRowsAffected(await a.client.from('follow_ups').update({ note: 'A was here' }).eq('id', overdueFollowUp.id).select('id'));
    expectError(await a.client.from('follow_ups').insert({ lead_id: lead.id, user_id: userA.id, due_at: new Date().toISOString() }).select('id'), '42501');

    const service = serviceClient();
    expect((await service.from('leads').select('status, assigned_to').eq('id', lead.id).single()).data).toEqual({ status: 'VOICEMAIL', assigned_to: userB.id });
    expect((await service.from('calls').select('outcome, handled_at').eq('id', voicemail.id).single()).data).toEqual({ outcome: null, handled_at: null });
  });

  it('B gains the lead with its full call history, without learning who made the calls', async () => {
    expect((await b.client.from('leads').select('id, assigned_to, notes').eq('id', lead.id)).data).toEqual([
      { id: lead.id, assigned_to: userB.id, notes: 'Lead notes travel with the lead' },
    ]);
    const calls = await b.client.from('calls').select(CALL_COLUMNS).eq('lead_id', lead.id);
    expect(calls.error).toBeNull();
    expect(new Set(calls.data?.map((c) => c.id))).toEqual(new Set([outbound.id, voicemail.id]));
    expectError(await b.client.from('calls').select('user_id').eq('lead_id', lead.id), '42501');

    const history = await b.client.rpc('get_lead_call_history', { p_lead_id: lead.id });
    expect(history.error).toBeNull();
    expect(history.data?.map((r) => r.id)).toEqual([voicemail.id, outbound.id]);
    for (const row of history.data ?? []) {
      expect(row.is_mine).toBe(false);
      expect(row.caller_name).toBeNull();
      expect(row.caller_id_e164).toBeNull();
    }
    const [vmRow, outRow] = history.data ?? [];
    expect(vmRow.has_voicemail).toBe(true);
    expect(vmRow.voicemail_duration_seconds).toBe(17);
    expect(outRow.outcome).toBe('VOICEMAIL');
    expect(outRow.notes).toBe('Left a message from A');
    expect(outRow.duration_seconds).toBe(31);
    expect(JSON.stringify(history.data)).not.toContain('Reassign From');
    expect(JSON.stringify(history.data)).not.toContain(numberA.e164);
  });

  it("B can access the voicemail recording and sees it in B's voicemail list and badge", async () => {
    expect((await serviceClient().rpc('get_voicemail_recording', { p_call_id: voicemail.id, p_user_id: userB.id })).data).toBe(voicemail.voicemail_recording_sid);
    const list = await b.client.rpc('list_voicemails', {});
    expect(list.data?.map((r) => r.call_id)).toEqual([voicemail.id]);
    expect(list.data?.[0].lead_id).toBe(lead.id);
    expect((await b.client.rpc('unheard_voicemail_count')).data).toBe(1);
    expect(await nextLeadIds(b)).toEqual([lead.id]);
  });

  it('open follow-ups moved to B; the completed one stays with A and is visible to neither agent', async () => {
    const visible = await b.client.from('follow_ups').select('id, user_id, note').eq('lead_id', lead.id).order('due_at');
    expect(visible.error).toBeNull();
    expect(visible.data).toEqual([
      { id: overdueFollowUp.id, user_id: userB.id, note: 'Voicemail received' },
      { id: upcomingFollowUp.id, user_id: userB.id, note: 'Try again' },
    ]);
    const service = serviceClient();
    expect((await service.from('follow_ups').select('user_id').eq('id', completedFollowUp.id).single()).data?.user_id).toBe(userA.id);
    expect(Date.parse((await service.from('leads').select('next_follow_up_at').eq('id', lead.id).single()).data?.next_follow_up_at ?? '')).toBe(
      Date.parse(overdueFollowUp.due_at),
    );
  });

  it('calls.user_id and phone_number_id are unchanged, so stats stay with A', async () => {
    const { data } = await serviceClient().from('calls').select('id, user_id, phone_number_id').eq('lead_id', lead.id).order('created_at');
    expect(data).toEqual([
      { id: outbound.id, user_id: userA.id, phone_number_id: numberA.id },
      { id: voicemail.id, user_id: userA.id, phone_number_id: numberA.id },
    ]);
  });

  it('the admin still sees who made each call and which caller ID was used', async () => {
    const history = await admin.client.rpc('get_lead_call_history', { p_lead_id: lead.id });
    expect(history.error).toBeNull();
    expect(history.data?.map((r) => [r.id, r.caller_name, r.caller_id_e164, r.is_mine])).toEqual([
      [voicemail.id, 'Reassign From', numberA.e164, false],
      [outbound.id, 'Reassign From', numberA.e164, false],
    ]);
  });

  it('B can now work the lead', async () => {
    const logged = await b.client.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: lead.id, p_notes: 'B called back' });
    expect(logged.error).toBeNull();
    expect(logged.data).toMatchObject({ lead_id: lead.id, status: 'CONNECTED' });
    const history = await b.client.rpc('get_lead_call_history', { p_lead_id: lead.id });
    expect(history.data?.filter((r) => r.is_mine)).toHaveLength(1);
    expectEmptyRows(await a.client.rpc('get_lead_call_history', { p_lead_id: lead.id }));
  });

  it("an inbound callback from the reassigned lead routes to B, not A, even on A's own number (/api/twilio/voice/inbound)", async () => {
    await Promise.all([markOnline(userA.id), markOnline(userB.id)]);
    // A's assigned number, and a number the CRM does not know (no new pool number, so pool rotation tests are unaffected).
    for (const to of [numberA.e164, fictionalPhone()]) {
      const callSid = fakeTwilioSid('CA');
      const xml = await readTwiml(await handleTwilioInbound(twilioRequest(WEBHOOK_PATHS.inbound, inboundParams(lead.phone, to, callSid)), webhookDeps()));
      expect(twimlParts.identity(xml)).toBe(userB.id);
      expect(xml).not.toContain(userA.id);
      const rows = await callRowBySid(callSid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ direction: 'INBOUND', lead_id: lead.id, user_id: userB.id });
    }
    expectEmptyRows(await a.client.from('calls').select('id').eq('lead_id', lead.id));
  });
});
