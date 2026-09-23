// SPEC 7a "One active call per agent" (D23): the outbound webhook refuses a second in-app call while
// another call of the same agent is still live on Twilio, even when its outcome was already logged.
// A live status left behind by a lost callback is checked against Twilio instead of locking the agent out.
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioOutbound } from '@/server/http/twilio/outbound';
import { createCall, fakeTwilioSid, type Lead } from '../helpers/fixtures';
import {
  WEBHOOK_PATHS,
  callRow,
  createAgent,
  createDialableCall,
  createLeadFor,
  expectFailureTwiml,
  fakeRest,
  outboundParams,
  readTwiml,
  twilioRequest,
  webhookDeps,
  type Agent,
} from './_helpers';

interface Lookup {
  sids: string[];
  status: (sid: string) => Promise<string | null>;
}

function lookup(answer: (sid: string) => string | null | Error): Lookup {
  const sids: string[] = [];
  return {
    sids,
    status: async (sid) => {
      sids.push(sid);
      const result = answer(sid);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function dial(agent: Agent, callId: string, twilio: Lookup): Promise<string> {
  const { rest } = fakeRest(undefined, twilio.status);
  return readTwiml(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, outboundParams(agent.user.id, callId)), webhookDeps({ rest })));
}

let agent: Agent;
let first: Lead;
let second: Lead;

beforeAll(async () => {
  agent = await createAgent();
  [first, second] = await Promise.all([createLeadFor(agent.user.id), createLeadFor(agent.user.id)]);
});

describe('outbound webhook: one live call per agent', () => {
  it('refuses a manual row while another call remains live on Twilio', async () => {
    const caller = await createAgent();
    const callerLead = await createLeadFor(caller.user.id);
    await createDialableCall(caller.user.id, callerLead, { provider_call_sid: fakeTwilioSid('CA'), call_status: 'in-progress', outcome: 'CONNECTED' });
    const manual = await createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: caller.user.id, lead_id: null, remote_e164: '+12125550123' });
    expectFailureTwiml(await dial(caller, manual.id, lookup(() => 'in-progress')));
    expect((await callRow(manual.id)).provider_call_sid).toBeNull();
  });

  it('refuses a second call while the first is still in progress on Twilio, even though its outcome was logged', async () => {
    const liveSid = fakeTwilioSid('CA');
    const live = await createDialableCall(agent.user.id, first, { provider_call_sid: liveSid, call_status: 'in-progress', outcome: 'CONNECTED' });
    const next = await createDialableCall(agent.user.id, second);
    const twilio = lookup(() => 'in-progress');

    expectFailureTwiml(await dial(agent, next.id, twilio));

    expect(twilio.sids).toEqual([liveSid]);
    const row = await callRow(next.id);
    expect(row.provider_call_sid).toBeNull();
    expect(row.call_status).toBeNull();
    expect((await callRow(live.id)).call_status).toBe('in-progress');
  });

  it('dials when Twilio says the logged call already ended (lost status callback), and records that final status', async () => {
    const other = await createAgent();
    const lead = await createLeadFor(other.user.id);
    const lead2 = await createLeadFor(other.user.id);
    const staleSid = fakeTwilioSid('CA');
    const stale = await createDialableCall(other.user.id, lead, { provider_call_sid: staleSid, call_status: 'in-progress', outcome: 'NO_ANSWER' });
    const next = await createDialableCall(other.user.id, lead2);

    const xml = await dial(other, next.id, lookup(() => 'completed'));

    expect(xml).toContain('<Dial');
    expect((await callRow(stale.id)).call_status).toBe('completed');
    expect((await callRow(next.id)).call_status).toBe('queued');
  });

  it('refuses when Twilio cannot be asked about the logged live call', async () => {
    const other = await createAgent();
    const lead = await createLeadFor(other.user.id);
    const lead2 = await createLeadFor(other.user.id);
    await createDialableCall(other.user.id, lead, { provider_call_sid: fakeTwilioSid('CA'), call_status: 'queued', outcome: 'CONNECTED' });
    const next = await createDialableCall(other.user.id, lead2);
    expectFailureTwiml(await dial(other, next.id, lookup(() => new Error('Twilio 500'))));
    expect((await callRow(next.id)).call_status).toBeNull();
  });

  it('ignores live-looking calls older than two hours and calls of other agents', async () => {
    const other = await createAgent();
    const bystander = await createAgent();
    const lead = await createLeadFor(other.user.id);
    const lead2 = await createLeadFor(other.user.id);
    const bystanderLead = await createLeadFor(bystander.user.id);
    await createDialableCall(other.user.id, lead, {
      provider_call_sid: fakeTwilioSid('CA'),
      call_status: 'in-progress',
      created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
    await createDialableCall(bystander.user.id, bystanderLead, { provider_call_sid: fakeTwilioSid('CA'), call_status: 'in-progress' });
    const next = await createDialableCall(other.user.id, lead2);
    const twilio = lookup(() => 'in-progress');
    expect(await dial(other, next.id, twilio)).toContain('<Dial');
    expect(twilio.sids).toEqual([]);
  });
});
