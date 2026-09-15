// SPEC 13 isolation checks that go through Next.js route handlers or Twilio webhooks, exercised the way
// a browser attacker or a forged webhook would reach them (real access tokens, signed Twilio requests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioInbound } from '@/server/http/twilio/inbound';
import { handleTwilioOutbound } from '@/server/http/twilio/outbound';
import { handleCallsOutbound, handleVoiceToken } from '@/server/http/voice';
import { handleVoicemail } from '@/server/http/voicemail';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createCall, createLead, createPhoneNumber, disableUser, fakeTwilioSid, type Lead, type PhoneNumber } from '../helpers/fixtures';
import {
  WEBHOOK_PATHS,
  browserRequest,
  callRow,
  callRowBySid,
  createAgent,
  expectFailureTwiml,
  fakeRest,
  inboundParams,
  markOnline,
  outboundParams,
  readTwiml,
  routeEnv,
  stubSessionEnv,
  twilioRequest,
  twimlParts,
  unstubSessionEnv,
  webhookDeps,
  type Agent,
} from '../routes/_helpers';

let agentA: Agent;
let agentB: Agent;
let a: SignedInUser;
let b: SignedInUser;
let leadB: Lead;
let pool: PhoneNumber;

beforeAll(async () => {
  stubSessionEnv();
  [agentA, agentB] = await Promise.all([createAgent(), createAgent()]);
  [a, b] = await Promise.all([signInAs(agentA.user.email, agentA.user.password), signInAs(agentB.user.email, agentB.user.password)]);
  leadB = await createLead({ assigned_to: agentB.user.id });
  pool = await createPhoneNumber({ assigned_to: null });
});

afterAll(() => unstubSessionEnv());

async function createCallViaRoute(session: SignedInUser, leadId: string): Promise<string> {
  const res = await handleCallsOutbound(browserRequest('/api/calls/outbound', { token: session.accessToken, body: JSON.stringify({ leadId }) }), { env: routeEnv() });
  expect(res.status).toBe(201);
  return ((await res.json()) as { callId: string }).callId;
}

async function outboundWebhook(params: Record<string, string>): Promise<string> {
  return readTwiml(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, params), webhookDeps()));
}

async function expectUnclaimed(callId: string): Promise<void> {
  expect(await callRow(callId)).toMatchObject({ provider_call_sid: null, call_status: null, phone_number_id: null });
}

describe('route-level agent isolation', () => {
  it("Agent A cannot stream B's voicemail through GET /api/voicemail/[callId] (404, same as a missing id)", async () => {
    const voicemail = await createCall({
      direction: 'INBOUND',
      mode: 'IN_APP',
      lead_id: leadB.id,
      user_id: agentB.user.id,
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    });
    const fake = fakeRest();
    const fetchAs = async (session: SignedInUser, id: string) => {
      const res = await handleVoicemail(browserRequest(`/api/voicemail/${id}`, { method: 'GET', token: session.accessToken }), id, {
        env: routeEnv(),
        adminClient: serviceClient(),
        rest: fake.rest,
      });
      return { status: res.status, text: await res.text() };
    };
    const stolen = await fetchAs(a, voicemail.id);
    expect(stolen).toEqual(await fetchAs(a, crypto.randomUUID()));
    expect(stolen).toEqual({ status: 404, text: '{"error":"not_found"}' });
    expect(fake.recordings).toEqual([]);
    expect((await fetchAs(b, voicemail.id)).status).toBe(200);
  });

  it("Agent A cannot create an outbound call for B's lead through POST /api/calls/outbound (404)", async () => {
    const post = async (leadId: string) => {
      const res = await handleCallsOutbound(browserRequest('/api/calls/outbound', { token: a.accessToken, body: JSON.stringify({ leadId }) }), { env: routeEnv() });
      return { status: res.status, text: await res.text() };
    };
    const attempt = await post(leadB.id);
    expect(attempt).toEqual({ status: 404, text: '{"error":"not_found"}' });
    expect(attempt).toEqual(await post(crypto.randomUUID()));
    expect((await serviceClient().from('calls').select('id').eq('lead_id', leadB.id).eq('user_id', agentA.user.id)).data).toEqual([]);
  });

  it("the outbound webhook refuses to dial B's lead when the Twilio identity does not match calls.user_id", async () => {
    const callId = await createCallViaRoute(b, leadB.id);
    expectFailureTwiml(await outboundWebhook({ ...outboundParams(agentB.user.id, callId), From: `client:${agentA.user.id}` }));
    await expectUnclaimed(callId);
  });

  it('the outbound webhook refuses to dial a DO_NOT_CONTACT lead even with a valid pre-created call row', async () => {
    const lead = await createLead({ assigned_to: agentA.user.id });
    const callId = await createCallViaRoute(a, lead.id);
    const marked = await a.client.from('leads').update({ status: 'DO_NOT_CONTACT' }).eq('id', lead.id).select('id');
    expect(marked.data).toHaveLength(1);
    expectFailureTwiml(await outboundWebhook(outboundParams(agentA.user.id, callId)));
    await expectUnclaimed(callId);
  });

  it('the outbound webhook refuses a pre-created row whose outcome was already logged, so logged rows cannot be dialed alongside a live call', async () => {
    const lead = await createLead({ assigned_to: agentA.user.id });
    const callId = await createCallViaRoute(a, lead.id);
    const logged = await a.client.rpc('log_call', { p_outcome: 'NO_ANSWER', p_call_id: callId, p_lead_id: lead.id });
    expect(logged.error).toBeNull();
    expectFailureTwiml(await outboundWebhook(outboundParams(agentA.user.id, callId)));
    await expectUnclaimed(callId);
  });

  it.todo("Agent A cannot export B's leads through GET /api/leads/export (only own rows, no assigned agent column) (stage 9)");

  it('a disabled agent with a still-valid session cannot get a Twilio token from POST /api/voice/token', async () => {
    const disabled = await createAgent();
    const session = await signInAs(disabled.user.email, disabled.user.password);
    await disableUser(disabled.user.id);
    const res = await handleVoiceToken(browserRequest('/api/voice/token', { token: session.accessToken }), { env: routeEnv() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('after reassignment A -> B, an inbound callback from that lead routes to B and never rings A', async () => {
    const lead = await createLead({ assigned_to: agentA.user.id });
    await Promise.all([markOnline(agentA.user.id), markOnline(agentB.user.id)]);
    const admin = await signInAs('admin@funnelmcqueen.test');
    const reassigned = await admin.client.rpc('reassign_leads', { p_lead_ids: [lead.id], p_to_user_id: agentB.user.id });
    expect(reassigned.data).toBe(1);

    for (const to of [agentA.number?.e164 ?? '', pool.e164]) {
      const callSid = fakeTwilioSid('CA');
      const xml = await readTwiml(await handleTwilioInbound(twilioRequest(WEBHOOK_PATHS.inbound, inboundParams(lead.phone, to, callSid)), webhookDeps()));
      expect(twimlParts.identity(xml)).toBe(agentB.user.id);
      expect(xml).not.toContain(agentA.user.id);
      const [row] = await callRowBySid(callSid);
      expect(row).toMatchObject({ lead_id: lead.id, user_id: agentB.user.id });
    }
  });

  it("an inbound call from B's lead never rings A, even when it arrives on a shared pool number", async () => {
    await markOnline(agentA.user.id);
    await markOnline(agentB.user.id, new Date(Date.now() - 30 * 60_000));
    for (const to of [pool.e164, agentA.number?.e164 ?? '']) {
      const callSid = fakeTwilioSid('CA');
      const xml = await readTwiml(await handleTwilioInbound(twilioRequest(WEBHOOK_PATHS.inbound, inboundParams(leadB.phone, to, callSid)), webhookDeps()));
      // B is offline, so B's voicemail answers; A (online) is never dialed.
      expect(twimlParts.isVoicemail(xml)).toBe(true);
      expect(xml).not.toContain(agentA.user.id);
      const [row] = await callRowBySid(callSid);
      expect(row).toMatchObject({ lead_id: leadB.id, user_id: agentB.user.id });
    }

    await markOnline(agentB.user.id);
    const xml = await readTwiml(await handleTwilioInbound(twilioRequest(WEBHOOK_PATHS.inbound, inboundParams(leadB.phone, pool.e164)), webhookDeps()));
    expect(twimlParts.identity(xml)).toBe(agentB.user.id);
  });
});
