// SPEC 7a / 13: the outbound webhook dials only a fresh, unclaimed row of the Twilio identity that owns
// it, for a lead still assigned to them and not DO_NOT_CONTACT, with the right caller ID.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioOutbound } from '@/server/http/twilio/outbound';
import { serviceClient } from '../helpers/clients';
import { createCall, createPhoneNumber, createUser, disableUser, fakeTwilioSid, type Lead, type PhoneNumber } from '../helpers/fixtures';
import {
  APP_BASE_URL,
  WEBHOOK_PATHS,
  callRow,
  createAgent,
  createDialableCall,
  createLeadFor,
  expectFailureTwiml,
  outboundParams,
  readTwiml,
  twilioRequest,
  twimlParts,
  webhookDeps,
  type Agent,
} from './_helpers';

async function dial(params: Record<string, string>): Promise<string> {
  return readTwiml(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, params), webhookDeps()));
}

async function expectUnclaimed(callId: string): Promise<void> {
  const row = await callRow(callId);
  expect(row.provider_call_sid).toBeNull();
  expect(row.call_status).toBeNull();
  expect(row.phone_number_id).toBeNull();
}

let agent: Agent;
let other: Agent;
let lead: Lead;

beforeAll(async () => {
  [agent, other] = await Promise.all([createAgent(), createAgent()]);
  lead = await createLeadFor(agent.user.id);
});

describe('outbound webhook: success', () => {
  it("returns Dial TwiML with the lead's exact E.164 number and the agent's assigned caller ID, and claims the row", async () => {
    const call = await createDialableCall(agent.user.id, lead);
    const callSid = fakeTwilioSid('CA');
    const before = Date.now();
    const xml = await dial(outboundParams(agent.user.id, call.id, callSid));

    expect(twimlParts.number(xml)).toBe(lead.phone);
    expect(twimlParts.callerId(xml)).toBe(agent.number?.e164);
    expect(xml).toContain(
      `<Dial callerId="${agent.number?.e164}" timeout="30" answerOnBridge="true" action="${APP_BASE_URL}/api/twilio/voice/dial-complete">` +
        `<Number statusCallback="${APP_BASE_URL}/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed">${lead.phone}</Number></Dial>`,
    );

    const row = await callRow(call.id);
    expect(row.provider_call_sid).toBe(callSid);
    expect(row.phone_number_id).toBe(agent.number?.id);
    expect(row.call_status).toBe('queued');

    const number = await serviceClient().from('phone_numbers').select('last_used_at').eq('id', agent.number?.id ?? '').single();
    expect(Date.parse(number.data?.last_used_at ?? '')).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('lets an admin dial any lead with their own caller ID', async () => {
    const admin = await createAgent({ role: 'ADMIN' });
    const call = await createDialableCall(admin.user.id, lead);
    const xml = await dial(outboundParams(admin.user.id, call.id));
    expect(twimlParts.number(xml)).toBe(lead.phone);
    expect(twimlParts.callerId(xml)).toBe(admin.number?.e164);
  });
});

describe('outbound webhook: refusals return failure TwiML and never claim the row', () => {
  it('refuses a replayed webhook for an already-claimed row (same or new CallSid)', async () => {
    const call = await createDialableCall(agent.user.id, lead);
    const callSid = fakeTwilioSid('CA');
    const params = outboundParams(agent.user.id, call.id, callSid);
    expect(await dial(params)).toContain('<Dial');

    expectFailureTwiml(await dial(params));
    expectFailureTwiml(await dial({ ...params, CallSid: fakeTwilioSid('CA') }));
    const row = await callRow(call.id);
    expect(row.provider_call_sid).toBe(callSid);
  });

  it('refuses when the Twilio identity is not calls.user_id (another agent dialing this row)', async () => {
    const call = await createDialableCall(agent.user.id, lead);
    expectFailureTwiml(await dial({ ...outboundParams(agent.user.id, call.id), From: `client:${other.user.id}` }));
    expectFailureTwiml(await dial({ ...outboundParams(agent.user.id, call.id), From: `client:${agent.user.id.toUpperCase()}` }));
    await expectUnclaimed(call.id);
  });

  it('refuses a DO_NOT_CONTACT lead even with a valid pre-created row', async () => {
    const dnc = await createLeadFor(agent.user.id, { status: 'DO_NOT_CONTACT' });
    const call = await createDialableCall(agent.user.id, dnc);
    expectFailureTwiml(await dial(outboundParams(agent.user.id, call.id)));
    await expectUnclaimed(call.id);
  });

  it('refuses a row whose outcome was already logged', async () => {
    const call = await createDialableCall(agent.user.id, lead, { outcome: 'NO_ANSWER' });
    expectFailureTwiml(await dial(outboundParams(agent.user.id, call.id)));
    await expectUnclaimed(call.id);
  });

  it('refuses when the lead was reassigned after the row was created', async () => {
    const moving = await createLeadFor(agent.user.id);
    const call = await createDialableCall(agent.user.id, moving);
    const updated = await serviceClient().from('leads').update({ assigned_to: other.user.id }).eq('id', moving.id).select('id');
    expect(updated.data).toHaveLength(1);
    expectFailureTwiml(await dial(outboundParams(agent.user.id, call.id)));
    await expectUnclaimed(call.id);
  });

  it('refuses a disabled user and a user with in-app calling turned off', async () => {
    const disabled = await createAgent();
    const disabledLead = await createLeadFor(disabled.user.id);
    const disabledCall = await createDialableCall(disabled.user.id, disabledLead);
    await disableUser(disabled.user.id);
    expectFailureTwiml(await dial(outboundParams(disabled.user.id, disabledCall.id)));
    await expectUnclaimed(disabledCall.id);

    const noInApp = await createAgent({ inAppCallingEnabled: false });
    const noInAppLead = await createLeadFor(noInApp.user.id);
    const noInAppCall = await createDialableCall(noInApp.user.id, noInAppLead);
    expectFailureTwiml(await dial(outboundParams(noInApp.user.id, noInAppCall.id)));
    await expectUnclaimed(noInAppCall.id);
  });

  it('refuses a stale row (older than 10 minutes)', async () => {
    const call = await createDialableCall(agent.user.id, lead, { created_at: new Date(Date.now() - 11 * 60_000).toISOString() });
    expectFailureTwiml(await dial(outboundParams(agent.user.id, call.id)));
    await expectUnclaimed(call.id);
  });

  it('refuses missing, malformed and unknown call ids and a malformed CallSid', async () => {
    const params = outboundParams(agent.user.id, crypto.randomUUID());
    expectFailureTwiml(await dial(params));
    expectFailureTwiml(await dial({ ...params, callId: 'not-a-uuid' }));
    const { callId: _omit, ...withoutCallId } = params;
    void _omit;
    expectFailureTwiml(await dial(withoutCallId));

    const call = await createDialableCall(agent.user.id, lead);
    expectFailureTwiml(await dial({ ...outboundParams(agent.user.id, call.id), CallSid: 'CA-not-a-sid' }));
    await expectUnclaimed(call.id);
  });

  it('refuses rows that are not un-started OUTBOUND in-app calls', async () => {
    const tel = await createCall({ direction: 'OUTBOUND', mode: 'TEL', user_id: agent.user.id, lead_id: lead.id });
    expectFailureTwiml(await dial(outboundParams(agent.user.id, tel.id)));

    const inbound = await createCall({ direction: 'INBOUND', mode: 'IN_APP', user_id: agent.user.id, lead_id: lead.id, provider_call_sid: fakeTwilioSid('CA') });
    expectFailureTwiml(await dial(outboundParams(agent.user.id, inbound.id)));

    const statused = await createDialableCall(agent.user.id, lead, { call_status: 'ringing' });
    expectFailureTwiml(await dial(outboundParams(agent.user.id, statused.id)));
    await expect(callRow(statused.id)).resolves.toMatchObject({ provider_call_sid: null, call_status: 'ringing' });
  });
});

describe('outbound webhook: caller ID from the pool', () => {
  // Old created_at and a null last_used_at put these first in claim_caller_id's pool order, and no other
  // route test claims pool numbers (their agents all have assigned numbers), so the order is deterministic.
  let pool: PhoneNumber[];

  beforeAll(async () => {
    pool = [];
    for (const createdAt of ['2000-01-01T00:00:00Z', '2000-01-01T00:00:01Z', '2000-01-01T00:00:02Z']) {
      pool.push(await createPhoneNumber({ assigned_to: null, created_at: createdAt, last_used_at: null }));
    }
  });

  afterAll(async () => {
    if (pool.length > 0) await serviceClient().from('phone_numbers').update({ active: false }).in('id', pool.map((n) => n.id));
  });

  it('uses the least recently used active pool number when the agent has none, rotating across calls', async () => {
    const poolAgent = await createAgent({ withNumber: false });
    const poolLead = await createLeadFor(poolAgent.user.id);

    const first = await createDialableCall(poolAgent.user.id, poolLead);
    const firstXml = await dial(outboundParams(poolAgent.user.id, first.id));
    expect(twimlParts.number(firstXml)).toBe(poolLead.phone);
    expect(twimlParts.callerId(firstXml)).toBe(pool[0].e164);
    expect((await callRow(first.id)).phone_number_id).toBe(pool[0].id);

    const second = await createDialableCall(poolAgent.user.id, poolLead);
    expect(twimlParts.callerId(await dial(outboundParams(poolAgent.user.id, second.id)))).toBe(pool[1].e164);

    // An inactive assigned number does not count: that agent also gets the next pool number.
    const inactiveOwner = await createUser();
    await createPhoneNumber({ assigned_to: inactiveOwner.id, active: false });
    const inactiveLead = await createLeadFor(inactiveOwner.id);
    const third = await createDialableCall(inactiveOwner.id, inactiveLead);
    expect(twimlParts.callerId(await dial(outboundParams(inactiveOwner.id, third.id)))).toBe(pool[2].e164);
  });
});
