// SPEC 7c / 13: inbound routing (lead owner first, assigned number, else admin-only voicemail), ringing
// only an available Device, the voicemail flow with its follow-up, and delegation from /outbound.
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTwilioInboundDialComplete, handleTwilioRecordingStatus, handleTwilioVoicemailComplete } from '@/server/http/twilio/callbacks';
import { handleTwilioInbound } from '@/server/http/twilio/inbound';
import { handleTwilioOutbound } from '@/server/http/twilio/outbound';
import { serviceClient } from '../helpers/clients';
import { createCall, createPhoneNumber, createUser, disableUser, fakeTwilioSid, fictionalPhone, type PhoneNumber } from '../helpers/fixtures';
import {
  APP_BASE_URL,
  WEBHOOK_PATHS,
  callRow,
  callRowBySid,
  createAgent,
  createLeadFor,
  inboundParams,
  markOnline,
  readTwiml,
  twilioRequest,
  twimlParts,
  webhookDeps,
  xmlText,
  type Agent,
} from './_helpers';

async function inbound(from: string, to: string, callSid = fakeTwilioSid('CA'), path: string = WEBHOOK_PATHS.inbound) {
  const handler = path === WEBHOOK_PATHS.outbound ? handleTwilioOutbound : handleTwilioInbound;
  const xml = await readTwiml(await handler(twilioRequest(path, inboundParams(from, to, callSid)), webhookDeps()));
  const rows = await callRowBySid(callSid);
  expect(rows).toHaveLength(1);
  return { xml, row: rows[0], callSid };
}

let greeting: string;
let poolNumber: PhoneNumber;

beforeAll(async () => {
  const settings = await serviceClient().from('settings').select('voicemail_greeting').single();
  greeting = settings.data?.voicemail_greeting ?? '';
  expect(greeting.length).toBeGreaterThan(0);
  poolNumber = await createPhoneNumber({ assigned_to: null });
});

function expectVoicemailTwiml(xml: string): void {
  expect(twimlParts.isVoicemail(xml)).toBe(true);
  expect(xml).toContain(
    `<Say>${xmlText(greeting)}</Say><Record maxLength="120" playBeep="true" action="${APP_BASE_URL}/api/twilio/voice/voicemail-complete" ` +
      `recordingStatusCallback="${APP_BASE_URL}/api/twilio/voice/recording-status" recordingStatusCallbackEvent="completed"/>`,
  );
}

function expectRings(xml: string, userId: string, callId: string): void {
  expect(xml).toContain(
    `<Dial timeout="20" answerOnBridge="true" action="${APP_BASE_URL}/api/twilio/voice/inbound-dial-complete">` +
      `<Client><Identity>${userId}</Identity><Parameter name="callId" value="${callId}"/></Client></Dial>`,
  );
}

describe('inbound routing', () => {
  let a: Agent;
  let b: Agent;

  beforeAll(async () => {
    [a, b] = await Promise.all([createAgent(), createAgent()]);
  });

  it("rings the matched lead's owner with the call id, and logs an INBOUND row for that lead", async () => {
    await markOnline(a.user.id);
    const lead = await createLeadFor(a.user.id);
    const { xml, row, callSid } = await inbound(lead.phone, a.number?.e164 ?? '');
    expectRings(xml, a.user.id, row.id);
    expect(row).toMatchObject({
      direction: 'INBOUND',
      mode: 'IN_APP',
      lead_id: lead.id,
      user_id: a.user.id,
      phone_number_id: a.number?.id,
      remote_e164: lead.phone,
      provider_call_sid: callSid,
      outcome: null,
    });
  });

  it("routes to the lead owner even when the caller dials another agent's number or the pool", async () => {
    await Promise.all([markOnline(a.user.id), markOnline(b.user.id)]);
    const leadOfB = await createLeadFor(b.user.id);
    for (const to of [a.number?.e164 ?? '', poolNumber.e164]) {
      const { xml, row } = await inbound(leadOfB.phone, to);
      expect(twimlParts.identity(xml)).toBe(b.user.id);
      expect(xml).not.toContain(a.user.id);
      expect(row.user_id).toBe(b.user.id);
    }
  });

  it('rings the agent the dialed number is assigned to for an unmatched caller (lead_id null)', async () => {
    await markOnline(a.user.id);
    const { xml, row } = await inbound(fictionalPhone(), a.number?.e164 ?? '');
    expectRings(xml, a.user.id, row.id);
    expect(row).toMatchObject({ lead_id: null, user_id: a.user.id, phone_number_id: a.number?.id });
  });

  it('sends an unmatched caller on a pool number to admin-only voicemail (user_id null)', async () => {
    const caller = fictionalPhone();
    const { xml, row } = await inbound(caller, poolNumber.e164);
    expectVoicemailTwiml(xml);
    expect(row).toMatchObject({ lead_id: null, user_id: null, phone_number_id: poolNumber.id, remote_e164: caller });
  });

  it('sends an unmatched caller on an unknown or inactive number to admin-only voicemail', async () => {
    const unknown = await inbound(fictionalPhone(), fictionalPhone());
    expectVoicemailTwiml(unknown.xml);
    expect(unknown.row).toMatchObject({ user_id: null, phone_number_id: null });

    const owner = await createUser();
    await markOnline(owner.id);
    const inactive = await createPhoneNumber({ assigned_to: owner.id, active: false });
    const viaInactive = await inbound(fictionalPhone(), inactive.e164);
    expectVoicemailTwiml(viaInactive.xml);
    expect(viaInactive.row.user_id).toBeNull();
  });

  it('sends a matched lead without an owner to admin-only voicemail, even on an assigned number', async () => {
    await markOnline(a.user.id);
    const unassigned = await createLeadFor(null);
    const { xml, row } = await inbound(unassigned.phone, a.number?.e164 ?? '');
    expectVoicemailTwiml(xml);
    expect(row).toMatchObject({ lead_id: unassigned.id, user_id: null });
  });

  it('routes a shared phone to the owner of the most recently contacted lead', async () => {
    await Promise.all([markOnline(a.user.id), markOnline(b.user.id)]);
    const phone = fictionalPhone();
    const older = await createLeadFor(a.user.id, { phone, last_contacted_at: new Date(Date.now() - 86_400_000).toISOString() });
    const newer = await createLeadFor(b.user.id, { phone, last_contacted_at: new Date().toISOString() });
    const { xml, row } = await inbound(phone, poolNumber.e164);
    expect(twimlParts.identity(xml)).toBe(b.user.id);
    expect(row.lead_id).toBe(newer.id);
    expect(row.lead_id).not.toBe(older.id);
  });

  it('after reassignment A -> B, a callback from that lead rings B, never A', async () => {
    await Promise.all([markOnline(a.user.id), markOnline(b.user.id)]);
    const lead = await createLeadFor(a.user.id);
    const moved = await serviceClient().from('leads').update({ assigned_to: b.user.id }).eq('id', lead.id).select('id');
    expect(moved.data).toHaveLength(1);
    for (const to of [a.number?.e164 ?? '', poolNumber.e164]) {
      const { xml, row } = await inbound(lead.phone, to);
      expect(twimlParts.identity(xml)).toBe(b.user.id);
      expect(xml).not.toContain(a.user.id);
      expect(row.user_id).toBe(b.user.id);
    }
  });

  it('takes a Twilio retry of the same CallSid without logging the call twice', async () => {
    await markOnline(a.user.id);
    const lead = await createLeadFor(a.user.id);
    const callSid = fakeTwilioSid('CA');
    const first = await inbound(lead.phone, poolNumber.e164, callSid);
    const retry = await inbound(lead.phone, poolNumber.e164, callSid);
    expect(retry.row.id).toBe(first.row.id);
    expect(twimlParts.callIdParameter(retry.xml)).toBe(first.row.id);
  });

  it('handles a withheld caller number as unmatched', async () => {
    const { xml, row } = await inbound('anonymous', poolNumber.e164);
    expectVoicemailTwiml(xml);
    expect(row).toMatchObject({ lead_id: null, user_id: null, remote_e164: null });
  });

  it('delegates non-client callers from the TwiML App Voice URL (/outbound) to inbound routing', async () => {
    await markOnline(a.user.id);
    const lead = await createLeadFor(a.user.id);
    const { xml, row } = await inbound(lead.phone, a.number?.e164 ?? '', fakeTwilioSid('CA'), WEBHOOK_PATHS.outbound);
    expectRings(xml, a.user.id, row.id);
    expect(row).toMatchObject({ direction: 'INBOUND', lead_id: lead.id, user_id: a.user.id });

    const unmatched = await inbound(fictionalPhone(), poolNumber.e164, fakeTwilioSid('CA'), WEBHOOK_PATHS.outbound);
    expectVoicemailTwiml(unmatched.xml);
  });
});

describe('inbound: unavailable targets go to voicemail for the owner', () => {
  it('offline agent (stale Device presence): voicemail, then the recording is stored once with one follow-up due now', async () => {
    const owner = await createAgent();
    await markOnline(owner.user.id, new Date(Date.now() - 10 * 60_000));
    const lead = await createLeadFor(owner.user.id);
    const { xml, row, callSid } = await inbound(lead.phone, owner.number?.e164 ?? '');
    expectVoicemailTwiml(xml);
    expect(row).toMatchObject({ lead_id: lead.id, user_id: owner.user.id });

    const recordingSid = fakeTwilioSid('RE');
    const params = { CallSid: callSid, RecordingSid: recordingSid, RecordingDuration: '17', RecordingStatus: 'completed', RecordingUrl: 'https://api.twilio.com/x' };
    const before = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const res = await handleTwilioRecordingStatus(twilioRequest(WEBHOOK_PATHS.recordingStatus, params), webhookDeps());
      expect(res.status).toBe(200);
    }
    const stored = await callRow(row.id);
    expect(stored).toMatchObject({ voicemail_recording_sid: recordingSid, voicemail_duration_seconds: 17 });

    const followUps = await serviceClient().from('follow_ups').select('user_id, due_at, note, completed_at').eq('lead_id', lead.id);
    expect(followUps.data).toHaveLength(1);
    expect(followUps.data?.[0]).toMatchObject({ user_id: owner.user.id, note: 'Voicemail received', completed_at: null });
    expect(Math.abs(Date.parse(followUps.data?.[0].due_at ?? '') - before)).toBeLessThan(60_000);

    const other = await handleTwilioRecordingStatus(twilioRequest(WEBHOOK_PATHS.recordingStatus, { ...params, RecordingSid: fakeTwilioSid('RE') }), webhookDeps());
    expect(other.status).toBe(200);
    expect((await callRow(row.id)).voicemail_recording_sid).toBe(recordingSid);
  });

  it('ignores non-final recording callbacks', async () => {
    const owner = await createAgent();
    const lead = await createLeadFor(owner.user.id);
    const { row, callSid } = await inbound(lead.phone, owner.number?.e164 ?? '');
    const res = await handleTwilioRecordingStatus(
      twilioRequest(WEBHOOK_PATHS.recordingStatus, { CallSid: callSid, RecordingSid: fakeTwilioSid('RE'), RecordingStatus: 'in-progress' }),
      webhookDeps(),
    );
    expect(res.status).toBe(200);
    expect((await callRow(row.id)).voicemail_recording_sid).toBeNull();
  });

  it('a Device that never registered, an inactive owner, in-app calling off, or a busy owner all get voicemail', async () => {
    const neverSeen = await createAgent();
    const neverSeenLead = await createLeadFor(neverSeen.user.id);
    expectVoicemailTwiml((await inbound(neverSeenLead.phone, poolNumber.e164)).xml);

    const disabled = await createAgent();
    const disabledLead = await createLeadFor(disabled.user.id);
    await markOnline(disabled.user.id);
    await disableUser(disabled.user.id);
    const disabledCall = await inbound(disabledLead.phone, poolNumber.e164);
    expectVoicemailTwiml(disabledCall.xml);
    expect(disabledCall.row.user_id).toBe(disabled.user.id);

    const noInApp = await createAgent({ inAppCallingEnabled: false });
    await markOnline(noInApp.user.id);
    const noInAppLead = await createLeadFor(noInApp.user.id);
    expectVoicemailTwiml((await inbound(noInAppLead.phone, poolNumber.e164)).xml);

    const busy = await createAgent();
    await markOnline(busy.user.id);
    const busyLead = await createLeadFor(busy.user.id);
    await createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: busy.user.id, lead_id: busyLead.id, provider_call_sid: fakeTwilioSid('CA'), call_status: 'in-progress' });
    const busyCall = await inbound(busyLead.phone, poolNumber.e164);
    expectVoicemailTwiml(busyCall.xml);
    expect(busyCall.row.user_id).toBe(busy.user.id);

    // A logged or old live call no longer counts as busy.
    const free = await createAgent();
    await markOnline(free.user.id);
    const freeLead = await createLeadFor(free.user.id);
    await createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: free.user.id, lead_id: freeLead.id, provider_call_sid: fakeTwilioSid('CA'), call_status: 'in-progress', outcome: 'CONNECTED' });
    await createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: free.user.id, lead_id: freeLead.id, provider_call_sid: fakeTwilioSid('CA'), call_status: 'ringing', created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(twimlParts.identity((await inbound(freeLead.phone, poolNumber.e164)).xml)).toBe(free.user.id);
  });
});

describe('inbound dial-complete and voicemail-complete', () => {
  it('no-answer / busy / failed / canceled go to voicemail; completed ends the call', async () => {
    const owner = await createAgent();
    await markOnline(owner.user.id);
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      const lead = await createLeadFor(owner.user.id);
      const { row, callSid } = await inbound(lead.phone, owner.number?.e164 ?? '');
      const res = await handleTwilioInboundDialComplete(
        twilioRequest(WEBHOOK_PATHS.inboundDialComplete, { CallSid: callSid, DialCallStatus: status, From: lead.phone, To: owner.number?.e164 ?? '' }),
        webhookDeps(),
      );
      expectVoicemailTwiml(await readTwiml(res));
      expect((await callRow(row.id)).call_status).toBe(status);
    }

    const lead = await createLeadFor(owner.user.id);
    const { row, callSid } = await inbound(lead.phone, owner.number?.e164 ?? '');
    const answered = await handleTwilioInboundDialComplete(
      twilioRequest(WEBHOOK_PATHS.inboundDialComplete, { CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: '65' }),
      webhookDeps(),
    );
    expect(twimlParts.isEmpty(await readTwiml(answered))).toBe(true);
    expect(await callRow(row.id)).toMatchObject({ call_status: 'completed', duration_seconds: 65 });
  });

  it('voicemail-complete says goodbye and hangs up', async () => {
    const res = await handleTwilioVoicemailComplete(twilioRequest(WEBHOOK_PATHS.voicemailComplete, { CallSid: fakeTwilioSid('CA') }), webhookDeps());
    expect(await readTwiml(res)).toContain('<Say>Thank you. Goodbye.</Say><Hangup/>');
  });
});
