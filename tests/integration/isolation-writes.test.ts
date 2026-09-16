// SPEC 13 agent isolation, write side: every mutation Agent A attempts on B's data (or on protected
// columns of their own data) is refused or matches nothing, and the service client confirms nothing
// changed. Everything here runs on fresh fixtures.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TablesUpdate } from '../../src/lib/database.types';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import {
  createCall,
  createFollowUp,
  createLead,
  createPhoneNumber,
  createUser,
  fakeTwilioSid,
  fictionalPhone,
  uniqueEmail,
  type Call,
  type FollowUp,
  type FixtureUser,
  type Lead,
  type PhoneNumber,
} from '../helpers/fixtures';
import { expectEmptyRows, expectError, expectNoRowsAffected, sleep, untypedClient } from '../helpers/isolation';
import { signInSeeded } from '../helpers/seeded';

let userA: FixtureUser;
let userB: FixtureUser;
let a: SignedInUser;
let b: SignedInUser;
let leadA: Lead;
let leadB: Lead;
let dncLeadA: Lead;
let callA: Call;
let callB: Call;
let followUpA: FollowUp;
let followUpB: FollowUp;
let numberA: PhoneNumber;

const DAY = 86_400_000;

async function leadRow(id: string): Promise<Lead> {
  const { data, error } = await serviceClient().from('leads').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`lead ${id}: ${error?.message}`);
  return data;
}

async function callRow(id: string): Promise<Call> {
  const { data, error } = await serviceClient().from('calls').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`call ${id}: ${error?.message}`);
  return data;
}

async function followUpRow(id: string): Promise<FollowUp> {
  const { data, error } = await serviceClient().from('follow_ups').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`follow-up ${id}: ${error?.message}`);
  return data;
}

async function profileRow(id: string) {
  const { data, error } = await serviceClient().from('profiles').select('*').eq('id', id).single();
  if (error || !data) throw new Error(`profile ${id}: ${error?.message}`);
  return data;
}

async function callIdsOnLead(leadId: string): Promise<string[]> {
  const { data } = await serviceClient().from('calls').select('id').eq('lead_id', leadId).order('id');
  return (data ?? []).map((c) => c.id);
}

async function followUpIdsOnLead(leadId: string): Promise<string[]> {
  const { data } = await serviceClient().from('follow_ups').select('id').eq('lead_id', leadId).order('id');
  return (data ?? []).map((f) => f.id);
}

beforeAll(async () => {
  [userA, userB] = await Promise.all([createUser({ name: 'Writer A' }), createUser({ name: 'Writer B' })]);
  [leadA, leadB, dncLeadA] = await Promise.all([
    createLead({ assigned_to: userA.id, status: 'TO_CALL', notes: 'A notes', email: 'a@writer.test', source: 'Referral' }),
    createLead({ assigned_to: userB.id, status: 'INTERESTED', notes: 'B private notes', source: 'Yelp' }),
    createLead({ assigned_to: userA.id, status: 'DO_NOT_CONTACT' }),
  ]);
  [callA, callB, followUpA, followUpB, numberA] = await Promise.all([
    createCall({ lead_id: leadA.id, user_id: userA.id, outcome: 'NO_ANSWER', notes: 'A call' }),
    createCall({ lead_id: leadB.id, user_id: userB.id, outcome: 'INTERESTED', notes: 'B call notes' }),
    createFollowUp({ lead_id: leadA.id, user_id: userA.id, due_at: new Date(Date.now() + 2 * DAY).toISOString() }),
    createFollowUp({ lead_id: leadB.id, user_id: userB.id, note: 'B follow-up' }),
    createPhoneNumber({ assigned_to: userA.id }),
  ]);
  [a, b] = await Promise.all([signInAs(userA.email, userA.password), signInAs(userB.email, userB.password)]);
});

describe('leads', () => {
  it("update of B's lead matches nothing and changes nothing", async () => {
    const before = await leadRow(leadB.id);
    expectNoRowsAffected(await a.client.from('leads').update({ status: 'NOT_INTERESTED', notes: 'pwned' }).eq('id', leadB.id).select('id'));
    expectNoRowsAffected(await a.client.from('leads').update({ notes: 'pwned' }).neq('assigned_to', userA.id).select('id'));
    expectNoRowsAffected(await a.client.from('leads').update({ notes: 'pwned' }).is('assigned_to', null).select('id'));
    expect(await leadRow(leadB.id)).toEqual(before);
  });

  it("delete of B's lead (or any lead) has no effect", async () => {
    expectNoRowsAffected(await a.client.from('leads').delete().eq('id', leadB.id).select('id'));
    expectNoRowsAffected(await a.client.from('leads').delete().eq('id', leadA.id).select('id'));
    expect((await leadRow(leadB.id)).id).toBe(leadB.id);
    expect((await leadRow(leadA.id)).id).toBe(leadA.id);
  });

  it('assigned_to cannot be changed on an own lead: to B, to null, or re-sent with another column', async () => {
    const before = await leadRow(leadA.id);
    const attempts: TablesUpdate<'leads'>[] = [
      { assigned_to: userB.id },
      { assigned_to: null },
      { assigned_to: userB.id, status: 'NEW' },
      { assigned_to: userA.id, city: 'Elsewhere' },
      { assigned_to: userA.id, business_name: 'Renamed' },
    ];
    for (const patch of attempts) {
      expectError(await a.client.from('leads').update(patch).eq('id', leadA.id).select('id'), '42501');
    }
    expectError(
      await a.client.from('leads').upsert({ id: leadA.id, business_name: leadA.business_name, phone: leadA.phone, assigned_to: userB.id }).select('id'),
      '42501',
    );
    expect(await leadRow(leadA.id)).toEqual(before);
    expect((await b.client.from('leads').select('id').eq('id', leadA.id)).data).toEqual([]);
  });

  it('protected columns on an own lead are refused', async () => {
    const before = await leadRow(leadA.id);
    const attempts: TablesUpdate<'leads'>[] = [
      { business_name: 'Renamed Inc' },
      { contact_name: 'Someone Else' },
      { phone: fictionalPhone() },
      { phone_raw: '(999) 555-0100' },
      { email: 'x@evil.test' },
      { website: 'evil.test' },
      { website_domain: 'evil.test' },
      { address: '1 Evil Way' },
      { city: 'Evil City' },
      { state: 'ZZ' },
      { country: 'ZZ' },
      { source: 'Spoofed' },
      { call_count: 999 },
      { last_contacted_at: new Date().toISOString() },
      { created_at: '2000-01-01T00:00:00Z' },
      { updated_at: '2000-01-01T00:00:00Z', city: 'x' },
      { id: randomUUID() },
      { status: 'CLIENT', call_count: 5 },
    ];
    for (const patch of attempts) {
      const result = await a.client.from('leads').update(patch).eq('id', leadA.id).select('id');
      expect(result.error, `patch ${JSON.stringify(patch)} was accepted`).not.toBeNull();
      expectError(result, '42501');
    }
    expect(await leadRow(leadA.id)).toEqual(before);
  });

  it('a direct next_follow_up_at write cannot break the earliest-open-follow-up invariant', async () => {
    const expectInvariant = async () => {
      const lead = await leadRow(leadA.id);
      const { data } = await serviceClient().from('follow_ups').select('due_at').eq('lead_id', leadA.id).is('completed_at', null).order('due_at').limit(1);
      const earliest = data?.[0]?.due_at ?? null;
      if (earliest === null) expect(lead.next_follow_up_at).toBeNull();
      else expect(Date.parse(lead.next_follow_up_at ?? '')).toBe(Date.parse(earliest));
    };
    await expectInvariant();
    for (const next_follow_up_at of ['2001-01-01T00:00:00Z', null, new Date(Date.now() + 365 * DAY).toISOString()]) {
      const result = await a.client.from('leads').update({ next_follow_up_at }).eq('id', leadA.id).select('id');
      if (!result.error) expect(result.data).toEqual([{ id: leadA.id }]);
      await expectInvariant();
      await a.client.from('leads').update({ notes: 'still A notes', next_follow_up_at }).eq('id', leadA.id).select('id');
      await expectInvariant();
    }
  });

  it('agents cannot insert leads', async () => {
    const before = await serviceClient().from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', userA.id);
    expectError(await a.client.from('leads').insert({ business_name: 'Sneaky', phone: fictionalPhone() }).select('id'), '42501');
    expectError(await a.client.from('leads').insert({ business_name: 'Sneaky', phone: fictionalPhone(), assigned_to: userA.id }).select('id'), '42501');
    const after = await serviceClient().from('leads').select('id', { count: 'exact', head: true }).eq('assigned_to', userA.id);
    expect(after.count).toBe(before.count);
  });

  it('sanity: an agent may change status and notes on an own lead', async () => {
    const result = await a.client.from('leads').update({ status: 'CONNECTED', notes: 'Updated by A' }).eq('id', leadA.id).select('id, status, notes');
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ id: leadA.id, status: 'CONNECTED', notes: 'Updated by A' }]);
  });
});

describe('follow-ups', () => {
  it("A sees own follow-ups but not B's", async () => {
    const own = await a.client.from('follow_ups').select('id');
    expect(own.error).toBeNull();
    expect(own.data?.map((f) => f.id)).toContain(followUpA.id);
    expect(own.data?.map((f) => f.id)).not.toContain(followUpB.id);
    expectEmptyRows(await a.client.from('follow_ups').select('id').eq('id', followUpB.id));
  });

  it("inserts on B's lead, or for B on an own lead, are refused", async () => {
    const beforeB = await followUpIdsOnLead(leadB.id);
    const beforeA = await followUpIdsOnLead(leadA.id);
    const due_at = new Date(Date.now() + DAY).toISOString();
    expectError(await a.client.from('follow_ups').insert({ lead_id: leadB.id, user_id: userA.id, due_at }).select('id'), '42501');
    expectError(await a.client.from('follow_ups').insert({ lead_id: leadB.id, user_id: userB.id, due_at }).select('id'), '42501');
    expectError(await a.client.from('follow_ups').insert({ lead_id: leadA.id, user_id: userB.id, due_at }).select('id'), '42501');
    expect(await followUpIdsOnLead(leadB.id)).toEqual(beforeB);
    expect(await followUpIdsOnLead(leadA.id)).toEqual(beforeA);
  });

  it("an own follow-up cannot be moved to B's lead or handed to B", async () => {
    const before = await followUpRow(followUpA.id);
    expectError(await a.client.from('follow_ups').update({ lead_id: leadB.id }).eq('id', followUpA.id).select('id'), '42501');
    expectError(await a.client.from('follow_ups').update({ user_id: userB.id }).eq('id', followUpA.id).select('id'), '42501');
    expectError(await a.client.from('follow_ups').update({ lead_id: leadB.id, user_id: userB.id }).eq('id', followUpA.id).select('id'), '42501');
    expectError(await a.client.from('follow_ups').upsert({ id: followUpA.id, lead_id: leadB.id, user_id: userB.id, due_at: before.due_at }).select('id'), '42501');
    expect(await followUpRow(followUpA.id)).toEqual(before);
  });

  it("update and delete of B's follow-up match nothing", async () => {
    const before = await followUpRow(followUpB.id);
    expectNoRowsAffected(await a.client.from('follow_ups').update({ completed_at: new Date().toISOString(), note: 'pwned' }).eq('id', followUpB.id).select('id'));
    expectNoRowsAffected(await a.client.from('follow_ups').delete().eq('id', followUpB.id).select('id'));
    expectNoRowsAffected(await a.client.from('follow_ups').delete().eq('lead_id', leadB.id).select('id'));
    expect(await followUpRow(followUpB.id)).toEqual(before);
  });

  it('sanity: A may create a follow-up on an own lead for themselves', async () => {
    const result = await a.client
      .from('follow_ups')
      .insert({ lead_id: leadA.id, user_id: userA.id, due_at: new Date(Date.now() + 3 * DAY).toISOString() })
      .select('id');
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(1);
  });
});

describe('calls', () => {
  it("direct inserts are refused on B's lead and on an own lead", async () => {
    const beforeA = await callIdsOnLead(leadA.id);
    const beforeB = await callIdsOnLead(leadB.id);
    for (const lead_id of [leadB.id, leadA.id]) {
      expectError(await a.client.from('calls').insert({ lead_id, user_id: userA.id, direction: 'OUTBOUND', mode: 'TEL', outcome: 'CONNECTED' }).select('id'), '42501');
      expectError(await a.client.from('calls').insert({ lead_id, user_id: userA.id, direction: 'OUTBOUND', mode: 'TEL' }), '42501');
    }
    expect(await callIdsOnLead(leadA.id)).toEqual(beforeA);
    expect(await callIdsOnLead(leadB.id)).toEqual(beforeB);
  });

  it('direct update and delete of any call have no effect', async () => {
    const beforeA = await callRow(callA.id);
    const beforeB = await callRow(callB.id);
    for (const id of [callA.id, callB.id]) {
      expectNoRowsAffected(await a.client.from('calls').update({ outcome: 'APPOINTMENT', notes: 'rewritten' }).eq('id', id).select('id'));
      expectNoRowsAffected(await a.client.from('calls').delete().eq('id', id).select('id'));
    }
    expect(await callRow(callA.id)).toEqual(beforeA);
    expect(await callRow(callB.id)).toEqual(beforeB);
  });

  it("log_call on B's lead is not_found (P0002), identical to a nonexistent lead", async () => {
    const before = await leadRow(leadB.id);
    const beforeCalls = await callIdsOnLead(leadB.id);
    const forB = await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: leadB.id, p_notes: 'x' });
    const forRandom = await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: randomUUID(), p_notes: 'x' });
    expectError(forB, 'P0002');
    expectError(forRandom, 'P0002');
    expect(forB.error?.message).toBe(forRandom.error?.message);
    expect(forB.status).toBe(forRandom.status);
    expectError(await a.client.rpc('log_call', { p_outcome: 'FOLLOW_UP', p_lead_id: leadB.id, p_follow_up_at: new Date(Date.now() + DAY).toISOString() }), 'P0002');
    expect(await leadRow(leadB.id)).toEqual(before);
    expect(await callIdsOnLead(leadB.id)).toEqual(beforeCalls);
  });

  it("log_call with B's call id is not_found (P0002) and leaves the call untouched", async () => {
    const before = await callRow(callB.id);
    expectError(await a.client.rpc('log_call', { p_outcome: 'WRONG_NUMBER', p_call_id: callB.id }), 'P0002');
    expectError(await a.client.rpc('log_call', { p_outcome: 'WRONG_NUMBER', p_call_id: callB.id, p_lead_id: leadB.id }), 'P0002');
    expect(await callRow(callB.id)).toEqual(before);
    expect((await leadRow(leadB.id)).status).toBe('INTERESTED');
  });

  it("B's call id on an own lead is just an unknown client key: same answer as a random id, and B's call is untouched", async () => {
    const own = await createLead({ assigned_to: userA.id, status: 'TO_CALL' });
    const before = await callRow(callB.id);
    const withB = await a.client.rpc('log_call', { p_outcome: 'NO_ANSWER', p_call_id: callB.id, p_lead_id: own.id });
    const withRandom = await a.client.rpc('log_call', { p_outcome: 'NO_ANSWER', p_call_id: randomUUID(), p_lead_id: own.id });
    expect(withB.error).toBeNull();
    expect(withRandom.error).toBeNull();
    expect(withB.status).toBe(withRandom.status);
    expect(withB.data).toMatchObject({ lead_id: own.id, call_count: 1 });
    expect(withRandom.data).toMatchObject({ lead_id: own.id, call_count: 2 });
    expect((withB.data as { call_id: string }).call_id).not.toBe(callB.id);
    expect(await callRow(callB.id)).toEqual(before);
  });

  it("create_outbound_call for B's lead is not_found (P0002), identical to a nonexistent lead", async () => {
    const beforeCalls = await callIdsOnLead(leadB.id);
    const forB = await a.client.rpc('create_outbound_call', { p_lead_id: leadB.id });
    const forRandom = await a.client.rpc('create_outbound_call', { p_lead_id: randomUUID() });
    expectError(forB, 'P0002');
    expectError(forRandom, 'P0002');
    expect(forB.error?.message).toBe(forRandom.error?.message);
    expect(await callIdsOnLead(leadB.id)).toEqual(beforeCalls);
  });

  it('a DO_NOT_CONTACT lead cannot be dialed (create_outbound_call) or logged as a new TEL call', async () => {
    const before = await callIdsOnLead(dncLeadA.id);
    const outbound = await a.client.rpc('create_outbound_call', { p_lead_id: dncLeadA.id });
    expectError(outbound, 'P0001');
    expect(outbound.error?.message).toBe('do_not_contact');
    const tel = await a.client.rpc('log_call', { p_outcome: 'CONNECTED', p_lead_id: dncLeadA.id, p_call_id: randomUUID() });
    expectError(tel, 'P0001');
    expect(tel.error?.message).toBe('do_not_contact');
    expect(await callIdsOnLead(dncLeadA.id)).toEqual(before);
    expect((await leadRow(dncLeadA.id)).status).toBe('DO_NOT_CONTACT');
  });
});

describe('phone numbers and service-only functions', () => {
  it('phone_numbers cannot be read, inserted, updated or deleted', async () => {
    const before = (await serviceClient().from('phone_numbers').select('*').eq('id', numberA.id).single()).data;
    expectEmptyRows(await a.client.from('phone_numbers').select('id, e164, twilio_sid'));
    expectEmptyRows(await a.client.from('phone_numbers').select('id').eq('id', numberA.id));
    const e164 = fictionalPhone();
    expectError(await a.client.from('phone_numbers').insert({ e164, twilio_sid: fakeTwilioSid('PN'), assigned_to: userA.id }).select('id'), '42501');
    expectNoRowsAffected(await a.client.from('phone_numbers').update({ assigned_to: null, label: 'stolen' }).eq('id', numberA.id).select('id'));
    expectNoRowsAffected(await a.client.from('phone_numbers').update({ active: false }).neq('id', randomUUID()).select('id'));
    expectNoRowsAffected(await a.client.from('phone_numbers').delete().eq('id', numberA.id).select('id'));
    expect((await serviceClient().from('phone_numbers').select('*').eq('id', numberA.id).single()).data).toEqual(before);
    expect((await serviceClient().from('phone_numbers').select('id').eq('e164', e164)).data).toEqual([]);
  });

  it('claim_caller_id, apply_call_status, record_voicemail and internal helpers are permission denied', async () => {
    const before = await callRow(callA.id);
    const beforeNumber = (await serviceClient().from('phone_numbers').select('*').eq('id', numberA.id).single()).data;
    expectError(await a.client.rpc('claim_caller_id', { p_user_id: userA.id }), '42501');
    expectError(await a.client.rpc('apply_call_status', { p_call_sid: fakeTwilioSid('CA'), p_status: 'completed', p_duration: 5 }), '42501');
    expectError(await a.client.rpc('record_voicemail', { p_call_sid: fakeTwilioSid('CA'), p_recording_sid: fakeTwilioSid('RE'), p_duration: 5 }), '42501');
    expectError(await a.client.rpc('lead_earliest_open_follow_up', { p_lead_id: leadA.id }), '42501');
    expectError(await a.client.rpc('get_voicemail_recording', { p_call_id: callA.id, p_user_id: userA.id }), '42501');
    expectError(await a.client.rpc('apply_rate_limit', { p_user_id: userB.id, p_bucket: 'voice_token' }), '42501');
    expect(await callRow(callA.id)).toEqual(before);
    expect((await serviceClient().from('phone_numbers').select('*').eq('id', numberA.id).single()).data).toEqual(beforeNumber);
  });
});

describe('profiles', () => {
  it('an agent cannot change their own role, active flag, target, calling flag, timezone, email or presence directly', async () => {
    const before = await profileRow(userA.id);
    const attempts: TablesUpdate<'profiles'>[] = [
      { role: 'ADMIN' },
      { active: false },
      { daily_call_target: 1000 },
      { in_app_calling_enabled: false },
      { timezone: 'America/Chicago' },
      { email: uniqueEmail('hijack') },
      { device_seen_at: new Date().toISOString() },
      { created_at: '2000-01-01T00:00:00Z' },
      { name: 'Legit Name', role: 'ADMIN' },
      { id: randomUUID() },
    ];
    for (const patch of attempts) {
      expectError(await a.client.from('profiles').update(patch).eq('id', userA.id).select('id'), '42501');
    }
    expect(await profileRow(userA.id)).toEqual(before);
    expect((await a.client.rpc('is_admin')).data).toBe(false);
  });

  it("an agent may rename themselves but not B", async () => {
    const own = await a.client.from('profiles').update({ name: 'Writer A Renamed' }).eq('id', userA.id).select('id, name');
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id: userA.id, name: 'Writer A Renamed' }]);

    const beforeB = await profileRow(userB.id);
    expectNoRowsAffected(await a.client.from('profiles').update({ name: 'Hacked' }).eq('id', userB.id).select('id'));
    expectNoRowsAffected(await a.client.from('profiles').update({ name: 'Hacked' }).neq('id', userA.id).select('id'));
    expect(await profileRow(userB.id)).toEqual(beforeB);
  });

  it('agents cannot insert or delete profiles', async () => {
    expectError(await a.client.from('profiles').insert({ id: randomUUID(), email: uniqueEmail('ghost'), role: 'ADMIN' }).select('id'), '42501');
    expectNoRowsAffected(await a.client.from('profiles').delete().eq('id', userB.id).select('id'));
    expectNoRowsAffected(await a.client.from('profiles').delete().eq('id', userA.id).select('id'));
    expect((await profileRow(userB.id)).id).toBe(userB.id);
    expect((await profileRow(userA.id)).id).toBe(userA.id);
  });

  it('Auth user_metadata written by the agent never grants a role', async () => {
    const updated = await a.client.auth.updateUser({ data: { role: 'ADMIN', user_role: 'ADMIN', is_admin: true } });
    expect(updated.error).toBeNull();
    expect((await profileRow(userA.id)).role).toBe('AGENT');
    const refreshed = await signInAs(userA.email, userA.password);
    expect((await refreshed.client.rpc('is_admin')).data).toBe(false);
    expectEmptyRows(await refreshed.client.from('leads').select('id').eq('id', leadB.id));
    expectError(await refreshed.client.rpc('reassign_leads', { p_lead_ids: [leadB.id], p_to_user_id: userA.id }), '42501');
  });
});

describe('admin-only operations as an agent', () => {
  it('reassign_leads is forbidden (42501) and changes nothing', async () => {
    expectError(await a.client.rpc('reassign_leads', { p_lead_ids: [leadB.id], p_to_user_id: userA.id }), '42501');
    expectError(await a.client.rpc('reassign_leads', { p_lead_ids: [leadA.id], p_to_user_id: userB.id }), '42501');
    expectError(await a.client.rpc('reassign_leads', { p_lead_ids: [], p_to_user_id: userA.id }), '42501');
    expect((await leadRow(leadB.id)).assigned_to).toBe(userB.id);
    expect((await leadRow(leadA.id)).assigned_to).toBe(userA.id);
    expect((await followUpRow(followUpB.id)).user_id).toBe(userB.id);
  });

  it('settings cannot be read or written', async () => {
    const service = serviceClient();
    const before = (await service.from('settings').select('*').single()).data;
    expectEmptyRows(await a.client.from('settings').select('id, company_name, voicemail_greeting'));
    expectNoRowsAffected(await a.client.from('settings').update({ company_name: 'Pwned Co', voicemail_greeting: 'pwned' }).eq('id', true).select('id'));
    expectError(await a.client.from('settings').insert({ id: true, company_name: 'Pwned Co' }).select('id'));
    expectNoRowsAffected(await a.client.from('settings').delete().eq('id', true).select('id'));
    expect((await service.from('settings').select('*').single()).data).toEqual(before);
    expect((await a.client.rpc('get_company_name')).data).toBe(before?.company_name);
  });

  it('later-stage admin RPCs raise 42501 for agents and never echo B', async () => {
    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const results = [
      await a.client.rpc('admin_agent_rows'),
      await a.client.rpc('admin_team_totals'),
      await a.client.rpc('admin_agent_activity', { p_user_id: userB.id, p_from: from, p_to: to }),
      await a.client.rpc('admin_agent_activity', { p_user_id: userA.id, p_from: from, p_to: to }),
      await a.client.rpc('admin_phone_number_rows'),
      await a.client.rpc('admin_report_agents', { p_from: from, p_to: to }),
      await a.client.rpc('admin_report_numbers', { p_from: from, p_to: to }),
      await a.client.rpc('admin_report_totals', { p_from: from, p_to: to }),
      await a.client.rpc('find_duplicate_leads', { p_phones: [leadB.phone], p_domains: [], p_name_keys: [] }),
    ];
    for (const result of results) {
      expectError(result, '42501');
      const text = JSON.stringify(result.error);
      expect(text).not.toContain(userB.email);
      expect(text).not.toContain(leadB.phone);
      expect(text).not.toContain(leadB.business_name);
    }
    // The caller-scoped dashboard never includes B's numbers.
    const mine = await a.client.rpc('get_my_dashboard');
    expect(mine.error).toBeNull();
    expect(JSON.stringify(mine.data)).not.toContain(userB.id);
  });
});

describe('rate limits', () => {
  it('an agent cannot erase their own rate-limit history: the limit and window are fixed server-side', async () => {
    // Regression: consume_rate_limit used to prune hits older than a caller-supplied window, so a direct
    // call with p_window_seconds=1 reset the limit of any bucket (SPEC 12).
    const agent = await createUser({ name: 'Rate Limited' });
    const session = await signInAs(agent.email, agent.password);
    for (let i = 0; i < 20; i += 1) {
      expect((await session.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' })).data).toBe(true);
    }
    expect((await session.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' })).data).toBe(false);
    await sleep(1_100);
    const legacy = await untypedClient(session.accessToken).rpc('consume_rate_limit', { p_bucket: 'voice_token', p_max: 10_000, p_window_seconds: 1 });
    expect(legacy.error).not.toBeNull();
    expectError(await session.client.rpc('consume_rate_limit', { p_bucket: 'outbound_call' }), '22023');
    const afterReset = await session.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' });
    expect(afterReset.error).toBeNull();
    expect(afterReset.data, 'the voice_token limit was reset by a direct RPC call').toBe(false);
    const { count } = await serviceClient().from('rate_limit_hits').select('id', { count: 'exact', head: true }).eq('user_id', agent.id);
    expect(count).toBe(20);
  });

  it('create_outbound_call is limited to 12 per minute even when called directly, and leaves one dialable row', async () => {
    const agent = await createUser({ name: 'Direct Dialer' });
    const lead = await createLead({ assigned_to: agent.id, status: 'TO_CALL' });
    const session = await signInAs(agent.email, agent.password);
    for (let i = 0; i < 12; i += 1) {
      expect((await session.client.rpc('create_outbound_call', { p_lead_id: lead.id })).error).toBeNull();
    }
    const over = await session.client.rpc('create_outbound_call', { p_lead_id: lead.id });
    expectError(over, 'P0001');
    expect(over.error?.message).toBe('rate_limited');
    expect(await callIdsOnLead(lead.id)).toHaveLength(1);
  });

  it("an agent's hits never count against another agent", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await a.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' })).data).toBe(true);
    }
    expect((await a.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' })).data).toBe(false);
    expect((await b.client.rpc('consume_rate_limit', { p_bucket: 'voice_token' })).data).toBe(true);
  });
});

describe('known ids after reassignment are not an existence oracle', () => {
  it("A's call id, client key and follow-up id from a lead now owned by B answer exactly like random ids, before and after deletion", async () => {
    const [agentA, agentB] = await Promise.all([createUser({ name: 'Oracle A' }), createUser({ name: 'Oracle B' })]);
    const moved = await createLead({ assigned_to: agentA.id, status: 'TO_CALL' });
    const sessionA = await signInAs(agentA.email, agentA.password);
    const key = randomUUID();
    const logged = await sessionA.client.rpc('log_call', {
      p_outcome: 'FOLLOW_UP',
      p_lead_id: moved.id,
      p_call_id: key,
      p_follow_up_at: new Date(Date.now() + 2 * DAY).toISOString(),
    });
    expect(logged.error).toBeNull();
    const callId = (logged.data as { call_id: string }).call_id;
    const followUpId = (await serviceClient().from('follow_ups').select('id').eq('lead_id', moved.id)).data?.[0]?.id ?? '';
    expect(followUpId).not.toBe('');
    const admin = await signInSeeded('admin');
    expect((await admin.client.rpc('reassign_leads', { p_lead_ids: [moved.id], p_to_user_id: agentB.id })).error).toBeNull();

    const answers = async (ownLeadId: string, id: string): Promise<string> => {
      const withLead = await sessionA.client.rpc('log_call', { p_outcome: 'NO_ANSWER', p_lead_id: ownLeadId, p_call_id: id });
      const withoutLead = await sessionA.client.rpc('log_call', { p_outcome: 'NO_ANSWER', p_call_id: id });
      const insert = await sessionA.client
        .from('follow_ups')
        .insert({ id, lead_id: ownLeadId, user_id: agentA.id, due_at: new Date().toISOString() })
        .select('id');
      const pick = (r: { status: number; error: { code?: string; message: string } | null }) => [r.status, r.error?.code ?? null, r.error?.message ?? null];
      return JSON.stringify([pick(withLead), pick(withoutLead), pick(insert)]);
    };

    for (const phase of ['lead owned by B', 'lead deleted']) {
      // A fresh own lead per phase: a successful probe stores its id as that lead's client key.
      const own = await createLead({ assigned_to: agentA.id, status: 'TO_CALL' });
      const reference = await answers(own.id, randomUUID());
      expect(JSON.parse(reference)[0], phase).toEqual([200, null, null]);
      for (const id of [callId, key, followUpId]) {
        expect(await answers(own.id, id), `${phase}: ${id}`).toBe(reference);
      }
      if (phase === 'lead owned by B') {
        expect((await admin.client.from('leads').delete().eq('id', moved.id).select('id')).data).toEqual([{ id: moved.id }]);
      }
    }
  });
});
