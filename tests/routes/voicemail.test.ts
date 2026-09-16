// SPEC 5 / 13: GET /api/voicemail/[callId] streams audio server-side only for callers who may access the
// call (D13), with the same 404 for inaccessible and missing ids.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleVoicemail } from '@/server/http/voicemail';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createCall, createLead, createUser, disableUser, fakeTwilioSid, type Call, type FixtureUser, type Lead } from '../helpers/fixtures';
import { signInSeeded } from '../helpers/seeded';
import { FAKE_AUDIO, UNCONFIGURED, browserRequest, fakeRest, routeEnv, stubSessionEnv, unstubSessionEnv, type FakeRest } from './_helpers';

let userA: FixtureUser;
let userB: FixtureUser;
let a: SignedInUser;
let b: SignedInUser;
let admin: SignedInUser;
let leadA: Lead;
let leadB: Lead;
let voicemailA: Call;
let voicemailB: Call;
let adminOnly: Call;
let unmatchedA: Call;
let outboundA: Call;

function voicemailRow(overrides: Partial<Call>): Promise<Call> {
  return createCall({
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    voicemail_recording_sid: fakeTwilioSid('RE'),
    voicemail_duration_seconds: 12,
    remote_e164: '+13055550142',
    ...overrides,
  });
}

beforeAll(async () => {
  stubSessionEnv();
  [userA, userB] = await Promise.all([createUser(), createUser()]);
  [a, b, admin] = await Promise.all([signInAs(userA.email, userA.password), signInAs(userB.email, userB.password), signInSeeded('admin')]);
  [leadA, leadB] = await Promise.all([createLead({ assigned_to: userA.id }), createLead({ assigned_to: userB.id })]);
  voicemailA = await voicemailRow({ lead_id: leadA.id, user_id: userA.id });
  voicemailB = await voicemailRow({ lead_id: leadB.id, user_id: userB.id });
  adminOnly = await voicemailRow({ lead_id: null, user_id: null });
  unmatchedA = await voicemailRow({ lead_id: null, user_id: userA.id });
  outboundA = await createCall({ direction: 'OUTBOUND', mode: 'TEL', lead_id: leadA.id, user_id: userA.id });
});

afterAll(() => unstubSessionEnv());

function get(callId: string, token?: string, fake: FakeRest = fakeRest(), headers: Record<string, string> = {}, env = routeEnv()): Promise<Response> {
  return handleVoicemail(browserRequest(`/api/voicemail/${callId}`, { method: 'GET', token, headers }), callId, {
    env,
    adminClient: serviceClient(),
    rest: fake.rest,
  });
}

async function raw(res: Response): Promise<{ status: number; text: string }> {
  return { status: res.status, text: await res.text() };
}

const NOT_FOUND = { status: 404, text: '{"error":"not_found"}' };

describe('GET /api/voicemail/[callId] with Twilio configured', () => {
  it("streams the agent's own voicemail, asking Twilio for exactly that recording SID", async () => {
    const fake = fakeRest();
    const res = await get(voicemailA.id, a.accessToken, fake);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_AUDIO);
    expect(fake.recordings).toEqual([{ sid: voicemailA.voicemail_recording_sid, range: null }]);
  });

  it('forwards Range and streams the partial response back', async () => {
    const fake = fakeRest();
    const res = await get(voicemailA.id, a.accessToken, fake, { Range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-1/${FAKE_AUDIO.length}`);
    expect(res.headers.get('content-length')).toBe('2');
    expect((await res.arrayBuffer()).byteLength).toBe(2);
    expect(fake.recordings).toEqual([{ sid: voicemailA.voicemail_recording_sid, range: 'bytes=0-1' }]);
  });

  it("404 for B's voicemail, identical to a random id, and Twilio is never asked", async () => {
    const fake = fakeRest();
    expect(await raw(await get(voicemailB.id, a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(await raw(await get(crypto.randomUUID(), a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(await raw(await get('not-a-uuid', a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(await raw(await get(outboundA.id, a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(fake.recordings).toEqual([]);
  });

  it('the admin-only unmatched voicemail is 404 for agents and streams for the admin', async () => {
    const fake = fakeRest();
    expect(await raw(await get(adminOnly.id, a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(await raw(await get(adminOnly.id, b.accessToken, fake))).toEqual(NOT_FOUND);
    expect(fake.recordings).toEqual([]);

    const res = await get(adminOnly.id, admin.accessToken, fake);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(fake.recordings).toEqual([{ sid: adminOnly.voicemail_recording_sid, range: null }]);

    const adminB = await get(voicemailB.id, admin.accessToken, fake);
    expect(adminB.status).toBe(200);
    await adminB.arrayBuffer();
  });

  it("streams an unmatched voicemail routed to the agent's own number", async () => {
    const res = await get(unmatchedA.id, a.accessToken);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('follows reassignment: the previous agent gets 404, the new owner streams it', async () => {
    const lead = await createLead({ assigned_to: userA.id });
    const voicemail = await voicemailRow({ lead_id: lead.id, user_id: userA.id });
    const moved = await serviceClient().from('leads').update({ assigned_to: userB.id }).eq('id', lead.id).select('id');
    expect(moved.data).toHaveLength(1);
    expect(await raw(await get(voicemail.id, a.accessToken))).toEqual(NOT_FOUND);
    const res = await get(voicemail.id, b.accessToken);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('401 without a session and for a disabled agent with a still-valid token', async () => {
    expect(await raw(await get(voicemailA.id))).toEqual({ status: 401, text: '{"error":"unauthorized"}' });
    const user = await createUser();
    const session = await signInAs(user.email, user.password);
    const lead = await createLead({ assigned_to: user.id });
    const voicemail = await voicemailRow({ lead_id: lead.id, user_id: user.id });
    await disableUser(user.id);
    const fake = fakeRest();
    expect((await get(voicemail.id, session.accessToken, fake)).status).toBe(401);
    expect(fake.recordings).toEqual([]);
  });

  it('maps upstream failures without leaking details, and refuses malformed stored SIDs', async () => {
    expect(await raw(await get(voicemailA.id, a.accessToken, fakeRest(() => new Response('nope', { status: 404 }))))).toEqual(NOT_FOUND);
    expect((await get(voicemailA.id, a.accessToken, fakeRest(() => new Response('boom', { status: 500 })))).status).toBe(503);

    const lead = await createLead({ assigned_to: userA.id });
    const bad = await voicemailRow({ lead_id: lead.id, user_id: userA.id, voicemail_recording_sid: 'RE../../Accounts' });
    const fake = fakeRest();
    expect(await raw(await get(bad.id, a.accessToken, fake))).toEqual(NOT_FOUND);
    expect(fake.recordings).toEqual([]);
  });
});

describe('GET /api/voicemail/[callId] in mock / unconfigured mode', () => {
  it('returns a valid short WAV tone (8 kHz mono PCM, about 1.5 s) without calling Twilio', async () => {
    for (const env of [routeEnv(UNCONFIGURED), routeEnv({ DIALER_DRIVER: 'mock' })]) {
      const fake = fakeRest();
      const res = await get(voicemailA.id, a.accessToken, fake, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/wav');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const wav = Buffer.from(await res.arrayBuffer());
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
      expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(8000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.toString('ascii', 36, 40)).toBe('data');
      const seconds = wav.readUInt32LE(40) / (8000 * 2);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(2);
      expect(Number(res.headers.get('content-length'))).toBe(wav.length);
      expect(fake.recordings).toEqual([]);
    }
  });

  it('supports Range on the tone and still hides inaccessible voicemails', async () => {
    const env = routeEnv({ DIALER_DRIVER: 'mock' });
    const partial = await get(voicemailA.id, a.accessToken, fakeRest(), { Range: 'bytes=0-43' }, env);
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-43\/\d+$/);
    expect((await partial.arrayBuffer()).byteLength).toBe(44);
    expect(await raw(await get(voicemailB.id, a.accessToken, fakeRest(), {}, env))).toEqual(NOT_FOUND);
  });
});

// The tone is a development convenience, and it must never stand in for a real recording. D24 refuses
// DIALER_DRIVER=mock in production precisely so the app cannot fake calls or voicemail audio, but the
// media path had no production equivalent: an unconfigured production deployment (the documented
// fallback — unset DIALER_DRIVER resolves to `tel` in production) served a generated 440 Hz beep for
// every seeded and real voicemail alike, with nothing in the UI to say so. An agent would play the
// "voicemail", hear a beep, move on, and log_call would then mark that lead's voicemails handled — so a
// real customer message is never heard and is silently marked as dealt with.
describe('GET /api/voicemail/[callId] in production without Twilio', () => {
  const productionUnconfigured = () => routeEnv({ ...UNCONFIGURED, NODE_ENV: 'production' });

  it('refuses with 503 rather than serving synthetic audio', async () => {
    const fake = fakeRest();
    const res = await get(voicemailA.id, a.accessToken, fake, {}, productionUnconfigured());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).not.toMatch(/^audio\//);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(fake.recordings).toEqual([]);
  });

  it('answers a Range request the same way, with no partial tone', async () => {
    const res = await get(voicemailA.id, a.accessToken, fakeRest(), { Range: 'bytes=0-43' }, productionUnconfigured());
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).not.toMatch(/^audio\//);
  });

  it("still hides another agent's voicemail behind the same 404", async () => {
    expect(await raw(await get(voicemailB.id, a.accessToken, fakeRest(), {}, productionUnconfigured()))).toEqual(NOT_FOUND);
  });
});
