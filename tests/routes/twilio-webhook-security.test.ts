// SPEC 7e / 13: every /api/twilio/* route refuses unsigned, wrongly signed, wrong-URL and wrong-AccountSid
// requests with 403 "Forbidden", and a refused request changes nothing.
import { describe, expect, it } from 'vitest';
import {
  handleTwilioDialComplete,
  handleTwilioInboundDialComplete,
  handleTwilioRecordingStatus,
  handleTwilioStatus,
  handleTwilioVoicemailComplete,
} from '@/server/http/twilio/callbacks';
import { handleTwilioInbound } from '@/server/http/twilio/inbound';
import { handleTwilioOutbound } from '@/server/http/twilio/outbound';
import type { WebhookDeps } from '@/server/http/twilio/webhook';
import { fakeTwilioSid, fictionalPhone } from '../helpers/fixtures';
import {
  APP_BASE_URL,
  INTERNAL_ORIGIN,
  UNCONFIGURED,
  WEBHOOK_PATHS,
  callRow,
  createAgent,
  createDialableCall,
  createLeadFor,
  expectForbidden,
  outboundParams,
  readTwiml,
  routeEnv,
  twilioRequest,
  webhookDeps,
} from './_helpers';

type Handler = (req: Request, deps?: Partial<WebhookDeps>) => Promise<Response>;

const ROUTES: { name: string; path: string; handler: Handler; params: () => Record<string, string> }[] = [
  { name: 'outbound', path: WEBHOOK_PATHS.outbound, handler: handleTwilioOutbound, params: () => outboundParams(crypto.randomUUID(), crypto.randomUUID()) },
  { name: 'dial-complete', path: WEBHOOK_PATHS.dialComplete, handler: handleTwilioDialComplete, params: () => ({ CallSid: fakeTwilioSid('CA'), DialCallStatus: 'completed', DialCallDuration: '5' }) },
  { name: 'status', path: WEBHOOK_PATHS.status, handler: handleTwilioStatus, params: () => ({ CallSid: fakeTwilioSid('CA'), ParentCallSid: fakeTwilioSid('CA'), CallStatus: 'ringing' }) },
  { name: 'inbound', path: WEBHOOK_PATHS.inbound, handler: handleTwilioInbound, params: () => ({ CallSid: fakeTwilioSid('CA'), From: fictionalPhone(), To: fictionalPhone() }) },
  { name: 'inbound-dial-complete', path: WEBHOOK_PATHS.inboundDialComplete, handler: handleTwilioInboundDialComplete, params: () => ({ CallSid: fakeTwilioSid('CA'), DialCallStatus: 'completed' }) },
  { name: 'voicemail-complete', path: WEBHOOK_PATHS.voicemailComplete, handler: handleTwilioVoicemailComplete, params: () => ({ CallSid: fakeTwilioSid('CA') }) },
  { name: 'recording-status', path: WEBHOOK_PATHS.recordingStatus, handler: handleTwilioRecordingStatus, params: () => ({ CallSid: fakeTwilioSid('CA'), RecordingSid: fakeTwilioSid('RE'), RecordingDuration: '3', RecordingStatus: 'completed' }) },
];

describe.each(ROUTES)('POST $path signature checks', ({ path, handler, params }) => {
  it('accepts a correctly signed request (sanity check for the negative cases)', async () => {
    const res = await handler(twilioRequest(path, params()), webhookDeps());
    expect(res.status).toBe(200);
  });

  it('refuses an unsigned request', async () => {
    await expectForbidden(await handler(twilioRequest(path, params(), { signature: null }), webhookDeps()));
  });

  it('refuses a signature made with the wrong auth token', async () => {
    await expectForbidden(await handler(twilioRequest(path, params(), { authToken: 'not-the-auth-token-000000000000' }), webhookDeps()));
  });

  it('refuses a garbage signature header', async () => {
    await expectForbidden(await handler(twilioRequest(path, params(), { signature: 'c2lnbmF0dXJl' }), webhookDeps()));
  });

  it('refuses a signature for a different URL (other route, proxy host, or extra query)', async () => {
    const other = path === WEBHOOK_PATHS.status ? WEBHOOK_PATHS.dialComplete : WEBHOOK_PATHS.status;
    await expectForbidden(await handler(twilioRequest(path, params(), { signatureUrl: `${APP_BASE_URL}${other}` }), webhookDeps()));
    await expectForbidden(await handler(twilioRequest(path, params(), { signatureUrl: `${INTERNAL_ORIGIN}${path}` }), webhookDeps()));
    await expectForbidden(await handler(twilioRequest(path, params(), { signatureUrl: `${APP_BASE_URL}${path}?x=1` }), webhookDeps()));
  });

  it('refuses a validly signed request from another Twilio account (AccountSid mismatch)', async () => {
    const foreign = { ...params(), AccountSid: fakeTwilioSid('AC') };
    await expectForbidden(await handler(twilioRequest(path, foreign), webhookDeps()));
    const missing = twilioRequest(path, params(), { tamper: { AccountSid: '' } });
    await expectForbidden(await handler(missing, webhookDeps()));
  });

  it('refuses params changed after signing', async () => {
    await expectForbidden(await handler(twilioRequest(path, params(), { tamper: { CallSid: fakeTwilioSid('CA') } }), webhookDeps()));
  });

  it('refuses a non-form body', async () => {
    await expectForbidden(await handler(twilioRequest(path, params(), { contentType: 'application/json' }), webhookDeps()));
  });

  it('refuses everything when Twilio is not configured', async () => {
    const deps = webhookDeps({ env: routeEnv(UNCONFIGURED) });
    await expectForbidden(await handler(twilioRequest(path, params()), deps));
    const noBase = webhookDeps({ env: routeEnv({ DIALER_DRIVER: 'mock', APP_BASE_URL: undefined }) });
    await expectForbidden(await handler(twilioRequest(path, params()), noBase));
  });
});

describe('a refused outbound webhook has no side effects', () => {
  it('leaves a dialable row unclaimed and still dialable by the genuine request', async () => {
    const agent = await createAgent();
    const lead = await createLeadFor(agent.user.id);
    const call = await createDialableCall(agent.user.id, lead);
    const params = outboundParams(agent.user.id, call.id);

    await expectForbidden(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, params, { signature: null }), webhookDeps()));
    await expectForbidden(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, { ...params, AccountSid: fakeTwilioSid('AC') }), webhookDeps()));
    const untouched = await callRow(call.id);
    expect(untouched.provider_call_sid).toBeNull();
    expect(untouched.call_status).toBeNull();

    const xml = await readTwiml(await handleTwilioOutbound(twilioRequest(WEBHOOK_PATHS.outbound, params), webhookDeps()));
    expect(xml).toContain('<Dial');
  });
});
