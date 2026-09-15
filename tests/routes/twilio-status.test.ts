// SPEC 7a.6 / 13: status and dial-complete callbacks are idempotent under retries and out-of-order
// delivery; a terminal status is never replaced by an earlier one; dial-complete fills talk time.
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioDialComplete, handleTwilioStatus } from '@/server/http/twilio/callbacks';
import { fakeTwilioSid, type Lead } from '../helpers/fixtures';
import { WEBHOOK_PATHS, callRow, createAgent, createDialableCall, createLeadFor, readTwiml, twilioRequest, twimlParts, webhookDeps, type Agent } from './_helpers';

let agent: Agent;
let lead: Lead;

beforeAll(async () => {
  agent = await createAgent();
  lead = await createLeadFor(agent.user.id);
});

async function claimedCall(): Promise<{ id: string; parentSid: string }> {
  const parentSid = fakeTwilioSid('CA');
  const call = await createDialableCall(agent.user.id, lead, { provider_call_sid: parentSid, call_status: 'queued', phone_number_id: agent.number?.id ?? null });
  return { id: call.id, parentSid };
}

async function childStatus(parentSid: string, status: string, extra: Record<string, string> = {}): Promise<void> {
  const params = { CallSid: fakeTwilioSid('CA'), ParentCallSid: parentSid, CallStatus: status, ...extra };
  const xml = await readTwiml(await handleTwilioStatus(twilioRequest(WEBHOOK_PATHS.status, params), webhookDeps()));
  expect(twimlParts.isEmpty(xml)).toBe(true);
}

async function dialComplete(callSid: string, status: string, duration?: string): Promise<string> {
  const params: Record<string, string> = { CallSid: callSid, DialCallStatus: status };
  if (duration !== undefined) params.DialCallDuration = duration;
  return readTwiml(await handleTwilioDialComplete(twilioRequest(WEBHOOK_PATHS.dialComplete, params), webhookDeps()));
}

describe('status callback', () => {
  it('follows the child leg by ParentCallSid through to completed with talk time', async () => {
    const { id, parentSid } = await claimedCall();
    await childStatus(parentSid, 'initiated');
    expect((await callRow(id)).call_status).toBe('queued');
    await childStatus(parentSid, 'ringing');
    expect((await callRow(id)).call_status).toBe('ringing');
    await childStatus(parentSid, 'in-progress');
    expect((await callRow(id)).call_status).toBe('in-progress');
    await childStatus(parentSid, 'completed', { CallDuration: '42' });
    expect(await callRow(id)).toMatchObject({ call_status: 'completed', duration_seconds: 42 });
  });

  it('is idempotent under retries and never moves a terminal status backwards', async () => {
    const { id, parentSid } = await claimedCall();
    await childStatus(parentSid, 'completed', { CallDuration: '30' });
    for (let i = 0; i < 3; i += 1) await childStatus(parentSid, 'completed', { CallDuration: '30' });
    await childStatus(parentSid, 'ringing');
    await childStatus(parentSid, 'in-progress');
    await childStatus(parentSid, 'queued');
    await childStatus(parentSid, 'busy');
    expect(await callRow(id)).toMatchObject({ call_status: 'completed', duration_seconds: 30 });
  });

  it('handles out-of-order delivery (ringing after in-progress)', async () => {
    const { id, parentSid } = await claimedCall();
    await childStatus(parentSid, 'in-progress');
    await childStatus(parentSid, 'ringing');
    expect((await callRow(id)).call_status).toBe('in-progress');
  });

  it('uses CallSid when there is no ParentCallSid, and ignores unknown SIDs and statuses', async () => {
    const { id, parentSid } = await claimedCall();
    const res = await handleTwilioStatus(twilioRequest(WEBHOOK_PATHS.status, { CallSid: parentSid, CallStatus: 'no-answer' }), webhookDeps());
    expect(res.status).toBe(200);
    expect((await callRow(id)).call_status).toBe('no-answer');

    await childStatus(fakeTwilioSid('CA'), 'completed', { CallDuration: '9' });
    await childStatus(parentSid, 'teleported');
    expect((await callRow(id)).call_status).toBe('no-answer');
  });
});

describe('dial-complete callback', () => {
  it('stores the final dial status and duration and returns an empty Response', async () => {
    const { id, parentSid } = await claimedCall();
    await childStatus(parentSid, 'completed', { CallDuration: '40' });
    const xml = await dialComplete(parentSid, 'completed', '45');
    expect(twimlParts.isEmpty(xml)).toBe(true);
    expect(await callRow(id)).toMatchObject({ call_status: 'completed', duration_seconds: 45 });

    await dialComplete(parentSid, 'completed', '45');
    await dialComplete(parentSid, 'completed', '12');
    expect(await callRow(id)).toMatchObject({ call_status: 'completed', duration_seconds: 45 });
  });

  it('records busy / no-answer when the lead never picked up', async () => {
    const busy = await claimedCall();
    await dialComplete(busy.parentSid, 'busy');
    expect(await callRow(busy.id)).toMatchObject({ call_status: 'busy', duration_seconds: null });

    const noAnswer = await claimedCall();
    await childStatus(noAnswer.parentSid, 'ringing');
    await dialComplete(noAnswer.parentSid, 'no-answer', '0');
    expect(await callRow(noAnswer.id)).toMatchObject({ call_status: 'no-answer', duration_seconds: 0 });
  });
});
