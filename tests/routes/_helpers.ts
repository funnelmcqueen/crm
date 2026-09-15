// Shared helpers for the route-core tests (tests/routes/**) and route-level isolation tests: a
// Twilio-configured env pointing at the shared localbase, signed webhook requests, a fake Twilio REST
// client, and fixture arrangers. Everything mutable is a fresh fixture.
import twilio from 'twilio';
import { expect, vi } from 'vitest';
import { parseServerEnv, resetEnvCacheForTests, type ServerEnv } from '@/server/env';
import type { TablesInsert } from '@/lib/database.types';
import type { TwilioRest } from '@/server/twilio/rest';
import type { WebhookDeps } from '@/server/http/twilio/webhook';
import { serviceClient } from '../helpers/clients';
import { testStack } from '../helpers/env';
import { createCall, createLead, createPhoneNumber, createUser, fakeTwilioSid, type Call, type CreateUserOptions, type FixtureUser, type Lead, type PhoneNumber } from '../helpers/fixtures';

export const APP_BASE_URL = 'https://crm.funnelmcqueen.test';
/** Where requests actually arrive (a proxy host); signatures must still use APP_BASE_URL. */
export const INTERNAL_ORIGIN = 'http://internal-proxy.local:3000';
export const TEST_ACCOUNT_SID = `AC${'0123456789abcdef'.repeat(2)}`;
export const TEST_AUTH_TOKEN = 'test-auth-token-0123456789abcdef';
export const TEST_API_KEY_SID = `SK${'fedcba9876543210'.repeat(2)}`;
export const TEST_API_KEY_SECRET = 'test-api-key-secret-000000000000';
export const TEST_TWIML_APP_SID = `AP${'00112233445566778899aabbccddeeff'}`;

export const WEBHOOK_PATHS = {
  outbound: '/api/twilio/voice/outbound',
  dialComplete: '/api/twilio/voice/dial-complete',
  status: '/api/twilio/voice/status',
  inbound: '/api/twilio/voice/inbound',
  inboundDialComplete: '/api/twilio/voice/inbound-dial-complete',
  voicemailComplete: '/api/twilio/voice/voicemail-complete',
  recordingStatus: '/api/twilio/voice/recording-status',
} as const;

export const FAILURE_SAY = '<Say>Sorry, this call cannot be completed.</Say><Hangup/>';

/** A fully Twilio-configured server env for the shared test stack. Pass `undefined` to unset a key. */
export function routeEnv(overrides: Record<string, string | undefined> = {}): ServerEnv {
  const stack = testStack();
  return parseServerEnv({
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: stack.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    APP_BASE_URL,
    DIALER_DRIVER: 'twilio',
    TWILIO_ACCOUNT_SID: TEST_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN,
    TWILIO_API_KEY_SID: TEST_API_KEY_SID,
    TWILIO_API_KEY_SECRET: TEST_API_KEY_SECRET,
    TWILIO_TWIML_APP_SID: TEST_TWIML_APP_SID,
    ...overrides,
  });
}

export const UNCONFIGURED = {
  DIALER_DRIVER: undefined,
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_API_KEY_SID: undefined,
  TWILIO_API_KEY_SECRET: undefined,
  TWILIO_TWIML_APP_SID: undefined,
} as const;

/** getRouteAuth reads the public Supabase pair from process.env. Call in beforeAll. */
export function stubSessionEnv(): void {
  const stack = testStack();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', stack.url);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', stack.anonKey);
  resetEnvCacheForTests();
}

export function unstubSessionEnv(): void {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
}

export function webhookDeps(overrides: Partial<WebhookDeps> = {}): Partial<WebhookDeps> {
  return { env: routeEnv(), adminClient: serviceClient(), rest: fakeRest().rest, ...overrides };
}

export interface TwilioRequestOptions {
  /** Sign with this token instead of the configured one. */
  authToken?: string;
  /** Sign this URL instead of APP_BASE_URL + path. */
  signatureUrl?: string;
  /** An explicit header value, or null to omit the header. */
  signature?: string | null;
  /** Change params after signing. */
  tamper?: Record<string, string>;
  contentType?: string;
}

/** A Twilio webhook POST as it reaches the app behind a proxy, signed for the public URL. */
export function twilioRequest(path: string, params: Record<string, string>, options: TwilioRequestOptions = {}): Request {
  const signed = { AccountSid: TEST_ACCOUNT_SID, ApiVersion: '2010-04-01', ...params };
  const signatureUrl = options.signatureUrl ?? `${APP_BASE_URL}${path}`;
  const signature =
    options.signature === undefined
      ? twilio.getExpectedTwilioSignature(options.authToken ?? TEST_AUTH_TOKEN, signatureUrl, signed)
      : options.signature;
  const headers = new Headers({ 'Content-Type': options.contentType ?? 'application/x-www-form-urlencoded' });
  if (signature !== null) headers.set('X-Twilio-Signature', signature);
  const body = new URLSearchParams({ ...signed, ...options.tamper }).toString();
  return new Request(`${INTERNAL_ORIGIN}${path}`, { method: 'POST', headers, body });
}

export async function readTwiml(res: Response): Promise<string> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/xml');
  return text;
}

export async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe('Forbidden');
}

export function expectFailureTwiml(xml: string): void {
  expect(xml).toContain(FAILURE_SAY);
  expect(xml).not.toContain('<Dial');
}

export const twimlParts = {
  number: (xml: string) => /<Number[^>]*>([^<]*)<\/Number>/.exec(xml)?.[1] ?? null,
  callerId: (xml: string) => /<Dial[^>]*\scallerId="([^"]*)"/.exec(xml)?.[1] ?? null,
  identity: (xml: string) => /<Identity>([^<]*)<\/Identity>/.exec(xml)?.[1] ?? null,
  callIdParameter: (xml: string) => /<Parameter name="callId" value="([^"]*)"\/>/.exec(xml)?.[1] ?? null,
  isVoicemail: (xml: string) => xml.includes('<Record ') && !xml.includes('<Dial'),
  isEmpty: (xml: string) => xml.endsWith('<Response/>'),
};

export function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface FakeRest {
  rest: TwilioRest;
  recordings: { sid: string; range: string | null }[];
}

export const FAKE_AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

/** No network: records what the route asked for and returns canned audio (or a custom response). */
export function fakeRest(
  respond?: (sid: string, range: string | null) => Response,
  callStatus: (callSid: string) => Promise<string | null> = async () => null,
): FakeRest {
  const recordings: FakeRest['recordings'] = [];
  const rest: TwilioRest = {
    fetchCallStatus: callStatus,
    async fetchRecording(sid, range) {
      recordings.push({ sid, range: range ?? null });
      if (respond) return respond(sid, range ?? null);
      if (range) {
        return new Response(FAKE_AUDIO.slice(0, 2), {
          status: 206,
          headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '2', 'Content-Range': `bytes 0-1/${FAKE_AUDIO.length}`, 'Accept-Ranges': 'bytes' },
        });
      }
      return new Response(FAKE_AUDIO.slice(), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(FAKE_AUDIO.length), 'Accept-Ranges': 'bytes' },
      });
    },
    async findIncomingNumber() {
      return null;
    },
    async setIncomingNumberVoiceApp() {
      return undefined;
    },
  };
  return { rest, recordings };
}

export interface BrowserRequestOptions {
  token?: string;
  method?: 'GET' | 'POST';
  body?: string;
  origin?: string;
  headers?: Record<string, string>;
}

/** A browser-route request authenticated with a real access token (getRouteAuth accepts Bearer). */
export function browserRequest(path: string, options: BrowserRequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.origin) headers.set('Origin', options.origin);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${APP_BASE_URL}${path}`, { method: options.method ?? 'POST', headers, body: options.body });
}

export interface Agent {
  user: FixtureUser;
  number: PhoneNumber | null;
}

/** A fresh agent with its own assigned Twilio number (so outbound tests never touch the shared pool). */
export async function createAgent(options: CreateUserOptions & { withNumber?: boolean } = {}): Promise<Agent> {
  const { withNumber = true, ...userOptions } = options;
  const user = await createUser(userOptions);
  const number = withNumber ? await createPhoneNumber({ assigned_to: user.id }) : null;
  return { user, number };
}

export function createLeadFor(userId: string | null, overrides: Partial<TablesInsert<'leads'>> = {}): Promise<Lead> {
  return createLead({ assigned_to: userId, ...overrides });
}

/** A pre-created in-app row exactly like create_outbound_call inserts. */
export function createDialableCall(userId: string, lead: Lead, overrides: Partial<Call> = {}): Promise<Call> {
  return createCall({ direction: 'OUTBOUND', mode: 'IN_APP', user_id: userId, lead_id: lead.id, remote_e164: lead.phone, ...overrides });
}

export function outboundParams(userId: string, callId: string, callSid: string = fakeTwilioSid('CA')): Record<string, string> {
  return { CallSid: callSid, From: `client:${userId}`, To: '', Caller: `client:${userId}`, Direction: 'inbound', CallStatus: 'ringing', callId };
}

export function inboundParams(from: string, to: string, callSid: string = fakeTwilioSid('CA')): Record<string, string> {
  return { CallSid: callSid, From: from, To: to, Caller: from, Called: to, Direction: 'inbound', CallStatus: 'ringing' };
}

export async function markOnline(userId: string, seenAt: Date = new Date()): Promise<void> {
  const { error } = await serviceClient().from('profiles').update({ device_seen_at: seenAt.toISOString() }).eq('id', userId);
  if (error) throw new Error(`markOnline failed: ${error.message}`);
}

export async function callRow(id: string) {
  const { data, error } = await serviceClient()
    .from('calls')
    .select('id, lead_id, user_id, direction, mode, phone_number_id, remote_e164, provider_call_sid, call_status, outcome, duration_seconds, voicemail_recording_sid, voicemail_duration_seconds')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`callRow(${id}) failed: ${error?.message ?? 'no row'}`);
  return data;
}

export async function callRowBySid(sid: string) {
  const { data, error } = await serviceClient()
    .from('calls')
    .select('id, lead_id, user_id, direction, mode, phone_number_id, remote_e164, provider_call_sid, call_status, outcome, voicemail_recording_sid')
    .eq('provider_call_sid', sid);
  if (error || !data) throw new Error(`callRowBySid failed: ${error?.message ?? 'no rows'}`);
  return data;
}
