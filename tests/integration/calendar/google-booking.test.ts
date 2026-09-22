// Availability and booking wired to the real Google-backed calendar client (docs/DEVIATIONS.md D47): windows
// come from bookable_hours, busy time and the created/cancelled event come from Google, stubbed at the fetch
// layer — no test here reaches the network. calendar_connection is a locked-down singleton (no API role, admin
// included, may select it directly), so every test connects and disconnects it itself, the same way
// tests/integration/google/oauth.test.ts does for the same table.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKING_FAILED_MESSAGE, BOOKING_UNAVAILABLE_MESSAGE } from '@/lib/domain/booking-messages';
import type { RequestContext } from '@/server/context';
import { resetEnvCacheForTests } from '@/server/env';
import { encryptRefreshToken } from '@/server/google/crypto';
import { bookAppointment, cancelAppointment, getAgentAvailability } from '@/server/services/calendar-booking';
import { serviceClient } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { testStack } from '../../helpers/env';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

const TAG = `GBK${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
// Monday 2034-06-05, 06:00 EDT (10:00Z), on-the-hour so it is also a clean readAvailability cache bucket.
// The seeded bookable hours (10:00-12:00, 14:00-17:00 local, Monday-Friday) put two windows that same day at
// 14:00-16:00Z and 18:00-21:00Z — 4+ hours away, clear of the 120-minute booking notice. Far from every other
// integration suite's dates, so nothing here can collide with their appointments.
const NOW = new Date(Date.UTC(2034, 5, 5, 10, 0));
const at = (hours: number): Date => new Date(NOW.getTime() + hours * HOUR);

const GOOGLE_CLIENT_ID = 'test-client-id';
const GOOGLE_CLIENT_SECRET = 'test-client-secret';
const GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const ACCESS_TOKEN = 'test-access-token';
const APP_CALENDAR_ID = 'test-app-calendar-id';
const GOOGLE_EMAIL = 'closer@example.test';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com']);

function stubGoogleEnv(): void {
  const stack = testStack();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', stack.url);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', stack.anonKey);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', stack.serviceRoleKey);
  vi.stubEnv('CALENDAR_DRIVER', 'google');
  vi.stubEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET);
  vi.stubEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', GOOGLE_TOKEN_ENCRYPTION_KEY);
  resetEnvCacheForTests();
}

function unstubGoogleEnv(): void {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isGoogleUrl(url: string): boolean {
  try {
    return GOOGLE_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Intercepts only Google's own hosts; every other call (the shared local Supabase stack) reaches the real fetch. */
function stubGoogleFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = urlOf(input);
      if (!isGoogleUrl(url)) return realFetch(input as RequestInfo, init);
      calls.push({ url, method: init.method ?? 'GET', body: parseBody(init.body) });
      return handler(url, init);
    }),
  );
  return calls;
}

interface GoogleStub {
  busy?: Array<{ start: string; end: string }>;
  tokenStatus?: number;
  tokenBody?: unknown;
  insertResult?: { id: string };
  insertStatus?: number;
  insertBody?: unknown;
  deleteStatus?: number;
  deleteBody?: unknown;
}

/** Stubs the whole Google surface this suite touches: token refresh, free/busy, event insert, event delete. */
function stubGoogle(options: GoogleStub = {}): FetchCall[] {
  return stubGoogleFetch((url, init) => {
    if (url === TOKEN_URL) {
      if (options.tokenStatus && options.tokenStatus >= 400) return json(options.tokenBody ?? {}, options.tokenStatus);
      return json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url === FREEBUSY_URL) {
      return json({ calendars: { [GOOGLE_EMAIL]: { busy: options.busy ?? [] }, [APP_CALENDAR_ID]: { busy: [] } } });
    }
    const method = init.method ?? 'GET';
    if (url.startsWith(`${CALENDAR_API_BASE}/calendars/`) && url.includes('/events?') && method === 'POST') {
      if (options.insertStatus && options.insertStatus >= 400) return json(options.insertBody ?? {}, options.insertStatus);
      return json(options.insertResult ?? { id: `evt-${randomUUID()}` });
    }
    if (url.startsWith(`${CALENDAR_API_BASE}/calendars/`) && method === 'DELETE') {
      if (options.deleteStatus && options.deleteStatus >= 400) return json(options.deleteBody ?? {}, options.deleteStatus);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected Google network call to ${url}`);
  });
}

async function clearConnection(): Promise<void> {
  const { error } = await serviceClient().from('calendar_connection').delete().eq('id', true);
  if (error) throw new Error(`clearConnection failed: ${error.message}`);
}

/** Connects with a fresh, unique refresh token every time, so accessTokenFor's own cache never crosses tests. */
async function connect(overrides: { appCalendarId?: string | null } = {}): Promise<void> {
  const refreshToken = `refresh-${randomUUID()}`;
  const ciphertext = encryptRefreshToken(refreshToken, GOOGLE_TOKEN_ENCRYPTION_KEY);
  const { error } = await serviceClient()
    .from('calendar_connection')
    .upsert({
      id: true,
      google_email: GOOGLE_EMAIL,
      refresh_token_ciphertext: ciphertext,
      app_calendar_id: overrides.appCalendarId === undefined ? APP_CALENDAR_ID : overrides.appCalendarId,
      connected_by: adminUser.id,
      connected_at: new Date().toISOString(),
      broken_at: null,
    });
  if (error) throw new Error(`connect failed: ${error.message}`);
}

async function agentAndLead(name: string, overrides: Parameters<typeof createLead>[0] = {}) {
  const agent = await createUser({ name: `${name} ${TAG}` });
  const ctx = await contextForUser(agent);
  const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} ${name}`, state: 'FL', country: 'US', ...overrides });
  return { agent, ctx, lead };
}

const request = (leadId: string, start: Date, extra: { inCall?: boolean; clientRequestId?: string; note?: string } = {}) => ({
  leadId,
  start: start.toISOString(),
  note: extra.note ?? null,
  clientRequestId: extra.clientRequestId ?? randomUUID(),
  inCall: extra.inCall ?? false,
});

async function appointmentRow(id: string) {
  const { data, error } = await serviceClient().from('appointments').select('status, google_event_id').eq('id', id).maybeSingle();
  if (error) throw new Error(`appointmentRow failed: ${error.message}`);
  return data;
}

let adminUser: FixtureUser;
let admin: RequestContext;

beforeAll(async () => {
  stubGoogleEnv();
  adminUser = await createUser({ role: 'ADMIN', name: `GBK Admin ${TAG}` });
  admin = await contextForUser(adminUser);
});

afterAll(async () => {
  await clearConnection();
  unstubGoogleEnv();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearConnection();
});

describe('getAgentAvailability against Google', () => {
  it('returns slots inside the bookable hours and busy blocks from free/busy, and nothing but times', async () => {
    await connect();
    const { ctx, lead } = await agentAndLead('Avail');
    const busy = { start: at(4.5), end: at(5) }; // 14:30-15:00Z, inside the 14:00-16:00Z window
    const calls = stubGoogle({ busy: [{ start: busy.start.toISOString(), end: busy.end.toISOString() }] });

    const availability = await getAgentAvailability(ctx, lead.id, { now: () => at(0) });

    expect(calls.some((call) => call.url === FREEBUSY_URL)).toBe(true);
    expect(availability.busy).toContainEqual({ start: busy.start.toISOString(), end: busy.end.toISOString() });
    expect(Object.keys(availability.busy[0] ?? {}).sort()).toEqual(['end', 'start']);
    const starts = availability.slots.map((slot) => slot.start);
    expect(starts).toContain(at(4).toISOString());
    expect(starts).not.toContain(busy.start.toISOString());
  });
});

describe('bookAppointment against Google', () => {
  it('calls Google exactly once to create the event and stores the returned id', async () => {
    await connect();
    const { ctx, lead } = await agentAndLead('Book');
    const eventId = `evt-${randomUUID()}`;
    const calls = stubGoogle({ insertResult: { id: eventId } });

    const booked = await bookAppointment(ctx, request(lead.id, at(4)), { now: () => at(0) });

    const inserts = calls.filter((call) => call.method === 'POST' && call.url.includes('/events?'));
    expect(inserts).toHaveLength(1);
    expect(await appointmentRow(booked.id)).toMatchObject({ status: 'scheduled', google_event_id: eventId });
  });

  it('includes an attendee only when the lead has an email', async () => {
    await connect();
    const leadEmail = `lead-${TAG}@example.test`;
    const withEmail = await agentAndLead('WithEmail', { email: leadEmail });
    const withoutEmail = await agentAndLead('NoEmail');

    const calls1 = stubGoogle();
    await bookAppointment(withEmail.ctx, request(withEmail.lead.id, at(4.5)), { now: () => at(0) });
    const insert1 = calls1.find((call) => call.method === 'POST' && call.url.includes('/events?'));
    expect((insert1?.body as { attendees?: unknown })?.attendees).toEqual([{ email: leadEmail }]);

    const calls2 = stubGoogle();
    await bookAppointment(withoutEmail.ctx, request(withoutEmail.lead.id, at(5)), { now: () => at(0) });
    const insert2 = calls2.find((call) => call.method === 'POST' && call.url.includes('/events?'));
    expect(insert2?.body).not.toHaveProperty('attendees');
  });

  it('leaves nothing behind on a transient Google failure and does not mark the connection broken', async () => {
    await connect();
    const { ctx, lead } = await agentAndLead('Transient');
    stubGoogle({ insertStatus: 500, insertBody: { error: { errors: [{ reason: 'backendError' }] } } });

    await expect(bookAppointment(ctx, request(lead.id, at(5.5)), { now: () => at(0) })).rejects.toMatchObject({
      code: 'unavailable',
      message: BOOKING_FAILED_MESSAGE,
    });

    const { data: rows, error } = await serviceClient().from('appointments').select('id').eq('lead_id', lead.id);
    expect(error).toBeNull();
    expect(rows ?? []).toEqual([]);

    const status = await admin.supabase.rpc('get_calendar_status');
    expect(status.data?.[0]?.broken).toBe(false);
  });
});

describe('invalid_grant', () => {
  it('marks the connection broken and tells the agent booking is unavailable', async () => {
    await connect();
    const { ctx, lead } = await agentAndLead('Broken');
    stubGoogle({ tokenStatus: 400, tokenBody: { error: 'invalid_grant' } });

    await expect(getAgentAvailability(ctx, lead.id, { now: () => at(1) })).rejects.toMatchObject({
      code: 'unavailable',
      message: BOOKING_UNAVAILABLE_MESSAGE,
    });

    const status = await admin.supabase.rpc('get_calendar_status');
    expect(status.data?.[0]?.broken).toBe(true);
  });
});

describe('cancelAppointment against Google', () => {
  it('deletes the Google event, and still marks the appointment cancelled when the delete fails', async () => {
    await connect();

    const { ctx, lead } = await agentAndLead('Cancel');
    const eventId = `evt-${randomUUID()}`;
    stubGoogle({ insertResult: { id: eventId } });
    const booked = await bookAppointment(ctx, request(lead.id, at(8)), { now: () => at(0) });

    const deleteCalls = stubGoogle();
    await cancelAppointment(admin, booked.id);
    const deleteCall = deleteCalls.find((call) => call.method === 'DELETE');
    expect(deleteCall?.url).toBe(`${CALENDAR_API_BASE}/calendars/${APP_CALENDAR_ID}/events/${eventId}`);
    expect(await appointmentRow(booked.id)).toMatchObject({ status: 'cancelled' });

    const failing = await agentAndLead('CancelFail');
    const eventId2 = `evt-${randomUUID()}`;
    stubGoogle({ insertResult: { id: eventId2 } });
    const booked2 = await bookAppointment(failing.ctx, request(failing.lead.id, at(8.5)), { now: () => at(0) });

    stubGoogle({ deleteStatus: 500, deleteBody: {} });
    await cancelAppointment(admin, booked2.id);
    expect(await appointmentRow(booked2.id)).toMatchObject({ status: 'cancelled' });
  });
});

describe('no connection', () => {
  it('is unavailable and calls no Google endpoint', async () => {
    await clearConnection();
    const { ctx, lead } = await agentAndLead('NoConn');
    const calls = stubGoogle();

    await expect(getAgentAvailability(ctx, lead.id, { now: () => at(2) })).rejects.toMatchObject({
      code: 'unavailable',
      message: BOOKING_UNAVAILABLE_MESSAGE,
    });
    expect(calls).toEqual([]);
  });
});
