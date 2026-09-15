// Pure pieces of src/server/twilio and the route helpers: signature validation, TwiML, access token,
// REST client (fake fetch), log masking, status mapping, the WAV tone and the CSRF origin check.
import { decodeJwt } from 'jose';
import twilio from 'twilio';
import { describe, expect, it, vi } from 'vitest';
import { isAllowedOrigin } from '@/server/http/browser';
import { callbackStatus, dialStatus, isTerminalStatus, parseDuration } from '@/server/http/twilio/call-status';
import { generateToneWav, parseByteRange } from '@/server/http/voicemail-tone';
import { formatTwilioLog } from '@/server/twilio/log';
import { createTwilioRest } from '@/server/twilio/rest';
import { twilioSignedUrl, validateTwilioWebhook } from '@/server/twilio/signature';
import { createVoiceAccessToken } from '@/server/twilio/token';
import { emptyTwiml, failureTwiml, goodbyeTwiml, outboundDialTwiml, ringClientTwiml, voicemailTwiml } from '@/server/twilio/twiml';

const ACCOUNT = `AC${'1'.repeat(32)}`;
const TOKEN = 'unit-auth-token';
const BASE = 'https://crm.example.test';
const ENV = { APP_BASE_URL: BASE, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_ACCOUNT_SID: ACCOUNT };
const XML = '<?xml version="1.0" encoding="UTF-8"?>';

function signed(path: string, params: Record<string, string>, options: { url?: string; token?: string; host?: string } = {}): Request {
  const signature = twilio.getExpectedTwilioSignature(options.token ?? TOKEN, options.url ?? `${BASE}${path}`, params);
  return new Request(`${options.host ?? 'http://10.0.0.5:3000'}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  });
}

describe('validateTwilioWebhook', () => {
  const params = { AccountSid: ACCOUNT, CallSid: `CA${'2'.repeat(32)}`, From: '+12125550100' };

  it('validates against APP_BASE_URL + path + query, not the host the request arrived on', async () => {
    await expect(validateTwilioWebhook(signed('/api/twilio/voice/status?attempt=1', params), ENV)).resolves.toEqual({ ok: true, params });
    expect(twilioSignedUrl(new Request('http://internal/a/b?c=d'), `${BASE}/`)).toBe(`${BASE}/a/b?c=d`);
  });

  it('fails for wrong token, wrong URL, missing header, wrong AccountSid, non-form body or missing config', async () => {
    await expect(validateTwilioWebhook(signed('/x', params, { token: 'other' }), ENV)).resolves.toEqual({ ok: false });
    await expect(validateTwilioWebhook(signed('/x', params, { url: 'http://10.0.0.5:3000/x' }), ENV)).resolves.toEqual({ ok: false });
    const unsigned = new Request(`${BASE}/x`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    await expect(validateTwilioWebhook(unsigned, ENV)).resolves.toEqual({ ok: false });
    const foreign = { ...params, AccountSid: `AC${'9'.repeat(32)}` };
    await expect(validateTwilioWebhook(signed('/x', foreign), ENV)).resolves.toEqual({ ok: false });
    const json = new Request(`${BASE}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Twilio-Signature': 'x' }, body: '{}' });
    await expect(validateTwilioWebhook(json, ENV)).resolves.toEqual({ ok: false });
    for (const key of ['APP_BASE_URL', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID'] as const) {
      await expect(validateTwilioWebhook(signed('/x', params), { ...ENV, [key]: undefined })).resolves.toEqual({ ok: false });
    }
  });
});

describe('TwiML builders', () => {
  it('outbound dial', () => {
    expect(outboundDialTwiml({ appBaseUrl: BASE, callerId: '+14155550150', to: '+12125550100' })).toBe(
      `${XML}<Response><Dial callerId="+14155550150" timeout="30" answerOnBridge="true" action="${BASE}/api/twilio/voice/dial-complete">` +
        `<Number statusCallback="${BASE}/api/twilio/voice/status" statusCallbackEvent="initiated ringing answered completed">+12125550100</Number></Dial></Response>`,
    );
  });

  it('ring client with the callId parameter', () => {
    expect(ringClientTwiml({ appBaseUrl: `${BASE}/`, identity: 'user-1', callId: 'call-1' })).toBe(
      `${XML}<Response><Dial timeout="20" answerOnBridge="true" action="${BASE}/api/twilio/voice/inbound-dial-complete">` +
        '<Client><Identity>user-1</Identity><Parameter name="callId" value="call-1"/></Client></Dial></Response>',
    );
  });

  it('voicemail escapes the greeting', () => {
    expect(voicemailTwiml({ appBaseUrl: BASE, greeting: 'Hi <you> & co' })).toBe(
      `${XML}<Response><Say>Hi &lt;you&gt; &amp; co</Say><Record maxLength="120" playBeep="true" action="${BASE}/api/twilio/voice/voicemail-complete" ` +
        `recordingStatusCallback="${BASE}/api/twilio/voice/recording-status" recordingStatusCallbackEvent="completed"/></Response>`,
    );
  });

  it('failure, empty and goodbye', () => {
    expect(failureTwiml()).toBe(`${XML}<Response><Say>Sorry, this call cannot be completed.</Say><Hangup/></Response>`);
    expect(emptyTwiml()).toBe(`${XML}<Response/>`);
    expect(goodbyeTwiml()).toBe(`${XML}<Response><Say>Thank you. Goodbye.</Say><Hangup/></Response>`);
  });
});

describe('createVoiceAccessToken', () => {
  const env = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: `SK${'3'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'secret', TWILIO_TWIML_APP_SID: `AP${'4'.repeat(32)}` };

  it('grants the TwiML App outgoing and incoming for identity, ttl 3600', () => {
    const { token, ttl } = createVoiceAccessToken(env, 'user-1');
    expect(ttl).toBe(3600);
    const claims = decodeJwt(token) as { exp: number; iat?: number; grants: { identity: string; voice: { incoming: { allow: boolean }; outgoing: { application_sid: string } } } };
    expect(claims.grants.identity).toBe('user-1');
    expect(claims.grants.voice).toEqual({ incoming: { allow: true }, outgoing: { application_sid: env.TWILIO_TWIML_APP_SID } });
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
  });

  it('throws when unconfigured', () => {
    expect(() => createVoiceAccessToken({ ...env, TWILIO_API_KEY_SECRET: undefined }, 'user-1')).toThrow('not configured');
  });
});

describe('createTwilioRest (fake fetch)', () => {
  const env = { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: 'SKkey', TWILIO_API_KEY_SECRET: 'shh' };
  const auth = `Basic ${Buffer.from('SKkey:shh').toString('base64')}`;
  const recordingSid = `RE${'a'.repeat(32)}`;

  it('fetches the recording mp3 with API-key basic auth and forwards Range', async () => {
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response('audio', { status: 206 }));
    const rest = createTwilioRest(env, fetchImpl as unknown as typeof fetch);
    const res = await rest.fetchRecording(recordingSid, 'bytes=0-10');
    expect(res.status).toBe(206);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${recordingSid}.mp3`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(auth);
    expect(headers.get('range')).toBe('bytes=0-10');
  });

  it('looks up a call status (null for an unknown call, an error for anything else unexpected)', async () => {
    const callSid = `CA${'d'.repeat(32)}`;
    const responses = [
      Response.json({ sid: callSid, status: 'in-progress' }),
      new Response('{"code":20404}', { status: 404 }),
      new Response('oops', { status: 500 }),
      Response.json({ sid: callSid }),
    ];
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => responses.shift() ?? new Response(null, { status: 500 }));
    const rest = createTwilioRest(env, fetchImpl as unknown as typeof fetch);
    expect(await rest.fetchCallStatus(callSid)).toBe('in-progress');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls/${callSid}.json`);
    expect(new Headers(init?.headers).get('authorization')).toBe(auth);
    expect(await rest.fetchCallStatus(callSid)).toBeNull();
    await expect(rest.fetchCallStatus(callSid)).rejects.toThrow('HTTP 500');
    await expect(rest.fetchCallStatus(callSid)).rejects.toThrow('unexpected body');
    await expect(rest.fetchCallStatus('CA../x')).rejects.toThrow('invalid call SID');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('refuses malformed SIDs and missing credentials without any request', async () => {
    const fetchImpl = vi.fn();
    const rest = createTwilioRest(env, fetchImpl as unknown as typeof fetch);
    await expect(rest.fetchRecording('RE../../x')).rejects.toThrow();
    await expect(rest.setIncomingNumberVoiceApp('PN1', 'AP1')).rejects.toThrow();
    await expect(createTwilioRest({ ...env, TWILIO_API_KEY_SECRET: undefined }, fetchImpl as unknown as typeof fetch).fetchRecording(recordingSid)).rejects.toThrow('not configured');
    expect(await rest.findIncomingNumber('not a number')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('finds an incoming number by exact E.164 and points it at the TwiML App', async () => {
    const numberSid = `PN${'b'.repeat(32)}`;
    const appSid = `AP${'c'.repeat(32)}`;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('IncomingPhoneNumbers.json')) {
        return Response.json({ incoming_phone_numbers: [{ sid: numberSid, phone_number: '+14155550150', voice_application_sid: null }] });
      }
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe(`VoiceApplicationSid=${appSid}`);
      return Response.json({ sid: numberSid });
    });
    const rest = createTwilioRest(env, fetchImpl as unknown as typeof fetch);
    expect(await rest.findIncomingNumber('+14155550150')).toEqual({ sid: numberSid, phoneNumber: '+14155550150', voiceApplicationSid: null });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('PhoneNumber=%2B14155550150');
    expect(await rest.findIncomingNumber('+14155550151')).toBeNull();
    await rest.setIncomingNumberVoiceApp(numberSid, appSid);
    expect(String(fetchImpl.mock.calls[2][0])).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/${numberSid}.json`);
  });
});

describe('formatTwilioLog', () => {
  it('masks phone numbers but keeps client identities', () => {
    const line = formatTwilioLog('inbound_refused', { from: '+12125550123', to: '+14155550150', callSid: 'CA1', note: 'caller +13055550199 hung up', identity: 'client:abc' });
    expect(line).toContain('from=+1******0123');
    expect(line).toContain('to=+1******0150');
    expect(line).toContain('+1******0199');
    expect(line).not.toMatch(/2125550123|4155550150|3055550199/);
    expect(line).toContain('identity=client:abc');
  });
});

describe('call status mapping', () => {
  it('maps callback and dial statuses and parses durations', () => {
    expect(callbackStatus('initiated')).toBe('queued');
    expect(callbackStatus('answered')).toBe('in-progress');
    expect(callbackStatus('completed')).toBe('completed');
    expect(callbackStatus('toString')).toBeNull();
    expect(callbackStatus(undefined)).toBeNull();
    expect(dialStatus('answered')).toBe('completed');
    expect(dialStatus('ringing')).toBeNull();
    expect(isTerminalStatus('busy')).toBe(true);
    expect(isTerminalStatus('ringing')).toBe(false);
    expect(parseDuration('42')).toBe(42);
    expect(parseDuration('-1')).toBeNull();
    expect(parseDuration('1.5')).toBeNull();
    expect(parseDuration('999999')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe('WAV tone and ranges', () => {
  it('is a valid 8 kHz mono 16-bit RIFF file of 1.5 s', () => {
    const wav = Buffer.from(generateToneWav());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(12_000 * 2);
  });

  it('parses single byte ranges', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseByteRange('items=0-1', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 100)).toBeNull();
  });
});

describe('isAllowedOrigin', () => {
  const env = { APP_BASE_URL: BASE };
  const req = (origin?: string) => new Request('http://localhost:3000/api/voice/token', { method: 'POST', headers: origin ? { Origin: origin } : {} });

  it('allows no Origin, the request origin and APP_BASE_URL; refuses anything else', () => {
    expect(isAllowedOrigin(req(), env)).toBe(true);
    expect(isAllowedOrigin(req('http://localhost:3000'), env)).toBe(true);
    expect(isAllowedOrigin(req(BASE), env)).toBe(true);
    expect(isAllowedOrigin(req('https://evil.example'), env)).toBe(false);
    expect(isAllowedOrigin(req('null'), env)).toBe(false);
    expect(isAllowedOrigin(req(`${BASE}.evil.example`), env)).toBe(false);
    expect(isAllowedOrigin(req(BASE), { APP_BASE_URL: undefined })).toBe(false);
  });
});
