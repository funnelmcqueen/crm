// Lead mutations (SPEC 3 roles, SPEC 1 isolation, DEVIATIONS D5/D12): agents change status, notes and the
// next follow-up of their own leads only; details, reassignment and deletion are admin-only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import {
  deleteLead,
  markVoicemailHeard,
  reassignLead,
  setNextFollowUp,
  updateLeadDetails,
  updateLeadNotes,
  updateLeadStatus,
} from '@/server/services/leads';
import { serviceClient } from '../../helpers/clients';
import {
  createCall,
  createFollowUp,
  createLead,
  createUser,
  fakeTwilioSid,
  fictionalPhone,
  type FixtureUser,
  type Lead,
} from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';
import { contextFor, contextForUser } from '../../helpers/context';

const TAG = `LM${randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  [agentA, agentB] = await Promise.all([
    createUser({ name: `Mutation Agent A ${TAG}` }),
    createUser({ name: `Mutation Agent B ${TAG}` }),
  ]);
  [ctxA, ctxAdmin] = await Promise.all([contextForUser(agentA), signInSeeded('admin').then(contextFor)]);
});

async function leadRow(id: string) {
  const { data } = await serviceClient()
    .from('leads')
    .select('id, business_name, phone, phone_raw, website, website_domain, status, notes, assigned_to, next_follow_up_at')
    .eq('id', id)
    .maybeSingle();
  return data;
}

async function openFollowUps(leadId: string) {
  const { data } = await serviceClient()
    .from('follow_ups')
    .select('id, user_id, due_at, note')
    .eq('lead_id', leadId)
    .is('completed_at', null);
  return data ?? [];
}

describe('agent updates on another agent\'s lead', () => {
  let leadB: Lead;
  beforeAll(async () => {
    leadB = await createLead({ business_name: `${TAG} B lead`, notes: 'B notes', assigned_to: agentB.id });
  });

  it('status, notes and follow-up are not_found and change nothing', async () => {
    const before = await leadRow(leadB.id);
    await expect(updateLeadStatus(ctxA, leadB.id, 'CLIENT')).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateLeadNotes(ctxA, leadB.id, 'hijacked')).rejects.toMatchObject({ code: 'not_found' });
    await expect(setNextFollowUp(ctxA, leadB.id, new Date(Date.now() + DAY).toISOString())).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await leadRow(leadB.id)).toEqual(before);
    expect(await openFollowUps(leadB.id)).toEqual([]);
  });

  it('answers a random id and a malformed id the same way', async () => {
    for (const id of [randomUUID(), 'nope']) {
      await expect(updateLeadStatus(ctxA, id, 'CLIENT')).rejects.toMatchObject({ code: 'not_found' });
      await expect(updateLeadNotes(ctxA, id, 'x')).rejects.toMatchObject({ code: 'not_found' });
      await expect(setNextFollowUp(ctxA, id, new Date(Date.now() + DAY).toISOString())).rejects.toMatchObject({
        code: 'not_found',
      });
    }
  });
});

describe('agent updates on their own lead', () => {
  it('changes status and notes', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    expect(await updateLeadStatus(ctxA, lead.id, 'INTERESTED')).toEqual({ id: lead.id, status: 'INTERESTED' });
    expect(await updateLeadNotes(ctxA, lead.id, '  Call back after lunch  ')).toEqual({
      id: lead.id,
      notes: 'Call back after lunch',
    });
    expect(await updateLeadNotes(ctxA, lead.id, '   ')).toEqual({ id: lead.id, notes: null });
    const row = await leadRow(lead.id);
    expect(row).toMatchObject({ status: 'INTERESTED', notes: null });
    await expect(updateLeadStatus(ctxA, lead.id, 'BOGUS')).rejects.toMatchObject({ code: 'validation' });
  });

  it('may set DO_NOT_CONTACT but not re-open it (D12)', async () => {
    const lead = await createLead({ assigned_to: agentA.id, status: 'CONNECTED' });
    await updateLeadStatus(ctxA, lead.id, 'DO_NOT_CONTACT');
    await expect(updateLeadStatus(ctxA, lead.id, 'NEW')).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('Only an admin'),
    });
    expect((await leadRow(lead.id))?.status).toBe('DO_NOT_CONTACT');
    expect(await updateLeadNotes(ctxA, lead.id, 'still editable')).toMatchObject({ notes: 'still editable' });

    expect(await updateLeadStatus(ctxAdmin, lead.id, 'TO_CALL')).toEqual({ id: lead.id, status: 'TO_CALL' });
  });

  it('setNextFollowUp inserts a follow-up, then reschedules the same one', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const first = new Date(Date.now() + 2 * DAY);
    const created = await setNextFollowUp(ctxA, lead.id, first.toISOString(), 'Ask for the owner');
    expect(created.action).toBe('created');
    expect(Date.parse(created.nextFollowUpAt ?? '')).toBe(first.getTime());

    const second = new Date(Date.now() + 5 * DAY);
    const moved = await setNextFollowUp(ctxA, lead.id, second.toISOString());
    expect(moved).toMatchObject({ action: 'rescheduled', followUpId: created.followUpId });
    expect(Date.parse(moved.nextFollowUpAt ?? '')).toBe(second.getTime());

    const open = await openFollowUps(lead.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: created.followUpId, user_id: agentA.id, note: 'Ask for the owner' });
    expect(Date.parse((await leadRow(lead.id))?.next_follow_up_at ?? '')).toBe(second.getTime());
  });

  it('setNextFollowUp validates the date', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    await expect(setNextFollowUp(ctxA, lead.id, 'tomorrow')).rejects.toThrow();
    await expect(setNextFollowUp(ctxA, lead.id, new Date(Date.now() + 30 * 365 * DAY).toISOString())).rejects.toThrow();
    expect(await openFollowUps(lead.id)).toEqual([]);
  });
});

describe('admin-only operations', () => {
  it('are forbidden for agents, even on their own lead, and change nothing', async () => {
    const lead = await createLead({ business_name: `${TAG} Own`, assigned_to: agentA.id });
    const before = await leadRow(lead.id);
    await expect(updateLeadDetails(ctxA, lead.id, { businessName: 'Renamed' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reassignLead(ctxA, lead.id, agentB.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(reassignLead(ctxA, lead.id, null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteLead(ctxA, lead.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await leadRow(lead.id)).toEqual(before);
  });

  it('admin updateLeadDetails normalizes phone and website domain', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const e164 = fictionalPhone();
    const raw = `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
    const updated = await updateLeadDetails(ctxAdmin, lead.id, {
      businessName: `  ${TAG} Renamed  `,
      phone: raw,
      website: 'https://WWW.Fixture-Example.test/about',
      email: ' Owner@Fixture-Example.test ',
      city: '',
    });
    expect(updated).toMatchObject({
      businessName: `${TAG} Renamed`,
      phone: e164,
      phoneRaw: raw,
      website: 'https://WWW.Fixture-Example.test/about',
      websiteDomain: 'fixture-example.test',
      email: 'owner@fixture-example.test',
      city: null,
    });
    expect(await leadRow(lead.id)).toMatchObject({ phone: e164, phone_raw: raw, website_domain: 'fixture-example.test' });
  });

  it('admin updateLeadDetails rejects an unusable phone and bad fields without changing the lead', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const before = await leadRow(lead.id);
    await expect(updateLeadDetails(ctxAdmin, lead.id, { phone: '12', businessName: 'Nope' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(updateLeadDetails(ctxAdmin, lead.id, { businessName: '   ' })).rejects.toThrow();
    await expect(updateLeadDetails(ctxAdmin, lead.id, { email: 'not an email' })).rejects.toThrow();
    await expect(updateLeadDetails(ctxAdmin, lead.id, { assigned_to: agentB.id })).rejects.toThrow();
    expect(await leadRow(lead.id)).toEqual(before);
    await expect(updateLeadDetails(ctxAdmin, randomUUID(), { businessName: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('admin reassigns and unassigns a lead; open follow-ups move with it', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    await createFollowUp({ lead_id: lead.id, user_id: agentA.id });
    expect(await reassignLead(ctxAdmin, lead.id, agentB.id)).toEqual({ id: lead.id, assignedTo: agentB.id });
    expect((await leadRow(lead.id))?.assigned_to).toBe(agentB.id);
    expect((await openFollowUps(lead.id)).map((f) => f.user_id)).toEqual([agentB.id]);

    expect(await reassignLead(ctxAdmin, lead.id, null)).toEqual({ id: lead.id, assignedTo: null });
    expect((await leadRow(lead.id))?.assigned_to).toBeNull();

    await expect(reassignLead(ctxAdmin, lead.id, randomUUID())).rejects.toMatchObject({ code: 'validation' });
    await expect(reassignLead(ctxAdmin, randomUUID(), agentA.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('admin setNextFollowUp on an assigned lead schedules it for the owner', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const due = new Date(Date.now() + DAY);
    const result = await setNextFollowUp(ctxAdmin, lead.id, due.toISOString(), 'From admin');
    expect(result.action).toBe('created');
    expect(await openFollowUps(lead.id)).toEqual([expect.objectContaining({ user_id: agentA.id, note: 'From admin' })]);
  });

  it('admin deletes a lead with its calls and follow-ups', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const call = await createCall({ lead_id: lead.id, user_id: agentA.id, outcome: 'CONNECTED' });
    await createFollowUp({ lead_id: lead.id, user_id: agentA.id });
    expect(await deleteLead(ctxAdmin, lead.id)).toEqual({ id: lead.id });
    expect(await leadRow(lead.id)).toBeNull();
    expect((await serviceClient().from('calls').select('id').eq('id', call.id)).data).toEqual([]);
    await expect(deleteLead(ctxAdmin, lead.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('markVoicemailHeard', () => {
  async function voicemailOn(leadId: string, userId: string) {
    return createCall({
      lead_id: leadId,
      user_id: userId,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
      voicemail_duration_seconds: 12,
    });
  }

  it('is not_found for another agent\'s voicemail and leaves it unheard', async () => {
    const leadB = await createLead({ assigned_to: agentB.id });
    const call = await voicemailOn(leadB.id, agentB.id);
    await expect(markVoicemailHeard(ctxA, call.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(markVoicemailHeard(ctxA, 'bad-id')).rejects.toMatchObject({ code: 'not_found' });
    const { data } = await serviceClient().from('calls').select('handled_at').eq('id', call.id).single();
    expect(data?.handled_at).toBeNull();
  });

  it('marks the agent\'s own voicemail as heard', async () => {
    const lead = await createLead({ assigned_to: agentA.id });
    const call = await voicemailOn(lead.id, agentA.id);
    expect(await markVoicemailHeard(ctxA, call.id)).toEqual({ callId: call.id });
    const { data } = await serviceClient().from('calls').select('handled_at').eq('id', call.id).single();
    expect(data?.handled_at).not.toBeNull();
    // Already heard still counts as success.
    expect(await markVoicemailHeard(ctxA, call.id)).toEqual({ callId: call.id });
  });
});
