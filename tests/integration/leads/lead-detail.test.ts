// Lead detail service (SPEC 8 "Lead detail"): RLS-visible lead or null, call history without caller
// identity for agents (SPEC 5 reassignment rule), caller names and caller ID for admins.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { getLeadDetail } from '@/server/services/leads';
import {
  createCall,
  createLead,
  createPhoneNumber,
  createUser,
  fakeTwilioSid,
  type FixtureUser,
  type Lead,
  type PhoneNumber,
} from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';
import { contextFor, contextForUser } from '../../helpers/context';

const TAG = `LD${randomUUID().slice(0, 8)}`;

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxAdmin: RequestContext;
let leadA: Lead;
let leadB: Lead;
let number: PhoneNumber;

beforeAll(async () => {
  [agentA, agentB, number] = await Promise.all([
    createUser({ name: `Detail Agent A ${TAG}` }),
    createUser({ name: `Detail Agent B ${TAG}` }),
    createPhoneNumber(),
  ]);
  [leadA, leadB] = await Promise.all([
    createLead({ business_name: `${TAG} Mine`, contact_name: 'Pat Lee', notes: 'Own notes', assigned_to: agentA.id }),
    createLead({ business_name: `${TAG} Theirs`, notes: 'B secret notes', assigned_to: agentB.id }),
  ]);
  const now = Date.now();
  await createCall({
    lead_id: leadA.id,
    user_id: agentB.id,
    phone_number_id: number.id,
    outcome: 'NO_ANSWER',
    notes: 'Earlier call by a previous owner',
    duration_seconds: 0,
    created_at: new Date(now - 3 * 3_600_000).toISOString(),
  });
  await createCall({
    lead_id: leadA.id,
    user_id: agentA.id,
    phone_number_id: number.id,
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    call_status: 'completed',
    outcome: 'CONNECTED',
    duration_seconds: 125,
    created_at: new Date(now - 3_600_000).toISOString(),
  });
  await createCall({
    lead_id: leadA.id,
    user_id: agentA.id,
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    voicemail_recording_sid: fakeTwilioSid('RE'),
    voicemail_duration_seconds: 18,
    created_at: new Date(now - 60_000).toISOString(),
  });
  [ctxA, ctxAdmin] = await Promise.all([contextForUser(agentA), signInSeeded('admin').then(contextFor)]);
});

describe('getLeadDetail', () => {
  it('returns null for another agent\'s lead, a random id and a malformed id', async () => {
    expect(await getLeadDetail(ctxA, leadB.id)).toBeNull();
    expect(await getLeadDetail(ctxA, randomUUID())).toBeNull();
    expect(await getLeadDetail(ctxA, 'not-a-uuid')).toBeNull();
    expect(await getLeadDetail(ctxA, '')).toBeNull();
    expect(await getLeadDetail(ctxA, `${leadB.id}' or 1=1 --`)).toBeNull();
  });

  it('gives an agent the lead and history without caller identity or admin data', async () => {
    const detail = await getLeadDetail(ctxA, leadA.id);
    expect(detail).not.toBeNull();
    expect(detail?.lead).toMatchObject({ id: leadA.id, businessName: `${TAG} Mine`, contactName: 'Pat Lee', notes: 'Own notes', status: 'NEW' });
    expect(detail?.admin).toBeNull();
    expect(detail?.lead).not.toHaveProperty('assignedTo');

    const history = detail?.history ?? [];
    expect(history).toHaveLength(3);
    expect(history.map((c) => c.direction)).toEqual(['INBOUND', 'OUTBOUND', 'OUTBOUND']);
    expect(history[0]).toMatchObject({ hasVoicemail: true, voicemailDurationSeconds: 18, handledAt: null, outcome: null });
    expect(history[1]).toMatchObject({ outcome: 'CONNECTED', durationSeconds: 125, callStatus: 'completed', mode: 'IN_APP' });
    for (const call of history) expect(call.caller).toBeNull();

    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(agentB.id);
    expect(serialized).not.toContain(`Detail Agent B ${TAG}`);
    expect(serialized).not.toContain(number.e164);
    expect(serialized).not.toContain('voicemail_recording_sid');
  });

  it('gives an admin the assigned agent, caller names and caller ID numbers', async () => {
    const detail = await getLeadDetail(ctxAdmin, leadA.id);
    expect(detail?.admin).toEqual({ assignedTo: { id: agentA.id, name: `Detail Agent A ${TAG}`, active: true } });
    const outbound = (detail?.history ?? []).filter((c) => c.direction === 'OUTBOUND');
    expect(outbound.map((c) => c.caller)).toEqual([
      { name: `Detail Agent A ${TAG}`, callerIdE164: number.e164 },
      { name: `Detail Agent B ${TAG}`, callerIdE164: number.e164 },
    ]);

    const other = await getLeadDetail(ctxAdmin, leadB.id);
    expect(other?.lead.notes).toBe('B secret notes');
    expect(other?.history).toEqual([]);
  });

  it('shows unassigned leads to admins only', async () => {
    const pool = await createLead({ business_name: `${TAG} Pool`, assigned_to: null });
    expect(await getLeadDetail(ctxA, pool.id)).toBeNull();
    const detail = await getLeadDetail(ctxAdmin, pool.id);
    expect(detail?.admin).toEqual({ assignedTo: null });
  });
});
