// GET /api/google/start and GET /api/google/callback (docs/DEVIATIONS.md D47, design §5): the admin-only
// OAuth + PKCE round trip that connects the Google account. Google's HTTP surface is stubbed at the fetch
// layer — every non-Google call (Supabase auth/REST) passes through to the real fetch, so no test reaches
// the actual network for Google, but the shared local Supabase stack still works normally. Every credential
// below is an obvious placeholder; nothing here is a real client id, secret, code or token.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCacheForTests } from '@/server/env';
import { decryptRefreshToken } from '@/server/google/crypto';
import { GOOGLE_SCOPES } from '@/server/google/oauth';
import { handleGoogleCallback, handleGoogleStart } from '@/server/http/google-oauth';
import { serviceClient, signInAs, type SignedInUser } from '../../helpers/clients';
import { testStack } from '../../helpers/env';
import { createUser, type FixtureUser } from '../../helpers/fixtures';
import { APP_BASE_URL, browserRequest } from '../../routes/_helpers';

const GOOGLE_CLIENT_ID = 'test-client-id';
const GOOGLE_CLIENT_SECRET = 'test-client-secret';
const GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const FAKE_ACCESS_TOKEN = 'test-access-token';
const FAKE_REFRESH_TOKEN = 'test-refresh-token';
const FAKE_CALENDAR_ID = 'test-app-calendar-id';
const FAKE_GOOGLE_EMAIL = 'connected-owner@example.test';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const CALENDAR_INSERT_URL = 'https://www.googleapis.com/calendar/v3/calendars';
const GOOGLE_HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com', 'accounts.google.com']);

const START_PATH = '/api/google/start';
const CALLBACK_PATH = '/api/google/callback';
const COOKIE_NAME = 'gcal_oauth';

function stubGoogleEnv(): void {
  const stack = testStack();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', stack.url);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', stack.anonKey);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', stack.serviceRoleKey);
  vi.stubEnv('APP_BASE_URL', APP_BASE_URL);
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

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Intercepts only Google's own hosts; every other call (the shared local Supabase stack's auth/REST
 * endpoints, used by both the route handlers under test and this file's own assertions) reaches the real
 * fetch untouched.
 */
function stubGoogleFetch(googleHandler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = urlOf(input);
      if (!isGoogleUrl(url)) return realFetch(input as RequestInfo, init);
      calls.push({ url, init });
      return googleHandler(url, init);
    }),
  );
  return calls;
}

/** Guards that no Google endpoint is ever reached (used for branches that must write and fetch nothing). */
function noGoogleNetwork(): FetchCall[] {
  return stubGoogleFetch((url) => {
    throw new Error(`unexpected Google network call to ${url}`);
  });
}

function googleFlow(options: { includeRefreshToken?: boolean } = {}): FetchCall[] {
  const includeRefreshToken = options.includeRefreshToken ?? true;
  return stubGoogleFetch((url) => {
    if (url === TOKEN_URL) {
      const body: Record<string, unknown> = { access_token: FAKE_ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' };
      if (includeRefreshToken) body.refresh_token = FAKE_REFRESH_TOKEN;
      return json(body);
    }
    if (url === USERINFO_URL) return json({ email: FAKE_GOOGLE_EMAIL });
    if (url === CALENDAR_INSERT_URL) return json({ id: FAKE_CALENDAR_ID });
    throw new Error(`unexpected Google network call to ${url}`);
  });
}

function setCookieHeader(res: Response, name: string): string | null {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  return all.find((c) => c.startsWith(`${name}=`)) ?? null;
}

function maxAgeOf(setCookie: string): number {
  const match = /Max-Age=(\d+)/.exec(setCookie);
  return match ? Number(match[1]) : Number.NaN;
}

function expectClearsCookie(res: Response): void {
  const setCookie = setCookieHeader(res, COOKIE_NAME);
  expect(setCookie).toBeTruthy();
  expect(setCookie?.split(';')[0]?.trim()).toBe(`${COOKIE_NAME}=`);
  expect(maxAgeOf(setCookie ?? '')).toBe(0);
}

async function connectionRow() {
  const { data, error } = await serviceClient().from('calendar_connection').select('*').eq('id', true).maybeSingle();
  if (error) throw new Error(`connectionRow failed: ${error.message}`);
  return data;
}

async function clearConnection(): Promise<void> {
  const { error } = await serviceClient().from('calendar_connection').delete().eq('id', true);
  if (error) throw new Error(`clearConnection failed: ${error.message}`);
}

/** Runs a real GET /api/google/start as the admin and returns the consent state plus the cookie it set. */
async function startFlow(): Promise<{ cookie: string; state: string }> {
  const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET', token: adminSession.accessToken }));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  const cookie = setCookieHeader(res, COOKIE_NAME)?.split(';')[0] ?? '';
  expect(state).not.toBe('');
  expect(cookie).not.toBe('');
  return { cookie, state };
}

function callbackAs(session: SignedInUser, query: string, cookie: string): Request {
  return browserRequest(`${CALLBACK_PATH}?${query}`, { method: 'GET', token: session.accessToken, headers: { Cookie: cookie } });
}

let admin: FixtureUser;
let agent: FixtureUser;
let adminSession: SignedInUser;
let agentSession: SignedInUser;

beforeAll(async () => {
  stubGoogleEnv();
  const tag = randomUUID().slice(0, 8);
  admin = await createUser({ role: 'ADMIN', name: `OAuth Admin ${tag}` });
  agent = await createUser({ role: 'AGENT', name: `OAuth Agent ${tag}` });
  [adminSession, agentSession] = await Promise.all([signInAs(admin.email, admin.password), signInAs(agent.email, agent.password)]);
});

afterAll(async () => {
  await clearConnection();
  unstubGoogleEnv();
});

beforeEach(async () => {
  await clearConnection();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleGoogleStart', () => {
  it('refuses an agent with 403 and writes nothing', async () => {
    noGoogleNetwork();
    const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET', token: agentSession.accessToken }));
    expect(res.status).toBe(403);
    expect(await connectionRow()).toBeNull();
  });

  it("redirects an admin to Google's consent URL with the four scopes and PKCE, and sets a short-lived state cookie", async () => {
    noGoogleNetwork();
    const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET', token: adminSession.accessToken }));
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP_BASE_URL}${CALLBACK_PATH}`);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('state')).toBeTruthy();
    expect((location.searchParams.get('scope') ?? '').split(' ').sort()).toEqual([...GOOGLE_SCOPES].sort());

    const setCookie = setCookieHeader(res, COOKIE_NAME);
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    const maxAge = maxAgeOf(setCookie ?? '');
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);

    expect(await connectionRow()).toBeNull();
  });
});

describe('handleGoogleCallback', () => {
  it('rejects a mismatched state, writes nothing, reaches no Google endpoint, and clears the cookie', async () => {
    noGoogleNetwork();
    const { cookie } = await startFlow();
    const res = await handleGoogleCallback(callbackAs(adminSession, 'state=wrong-state&code=test-auth-code', cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=error`);
    expect(await connectionRow()).toBeNull();
    expectClearsCookie(res);
  });

  it('redirects error=access_denied to calendar=denied and writes nothing', async () => {
    noGoogleNetwork();
    const { cookie, state } = await startFlow();
    const res = await handleGoogleCallback(callbackAs(adminSession, `error=access_denied&state=${encodeURIComponent(state)}`, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=denied`);
    expect(await connectionRow()).toBeNull();
    expectClearsCookie(res);
  });

  it('re-checks the admin session on the callback: a non-admin caller is refused and writes nothing', async () => {
    noGoogleNetwork();
    const { cookie, state } = await startFlow();
    const res = await handleGoogleCallback(callbackAs(agentSession, `state=${encodeURIComponent(state)}&code=test-auth-code`, cookie));
    expect(res.status).toBe(403);
    expect(await connectionRow()).toBeNull();
    expectClearsCookie(res);
  });

  it('exchanges the code, creates the app calendar, stores the connection, and redirects to calendar=connected', async () => {
    const { cookie, state } = await startFlow();
    const calls = googleFlow();

    const res = await handleGoogleCallback(callbackAs(adminSession, `state=${encodeURIComponent(state)}&code=test-auth-code`, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=connected`);
    expectClearsCookie(res);
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, USERINFO_URL, CALENDAR_INSERT_URL]);

    const row = await connectionRow();
    expect(row).toMatchObject({ google_email: FAKE_GOOGLE_EMAIL, app_calendar_id: FAKE_CALENDAR_ID, broken_at: null });
    expect(row?.refresh_token_ciphertext ?? '').not.toContain(FAKE_REFRESH_TOKEN);
    expect(decryptRefreshToken(row?.refresh_token_ciphertext ?? '')).toBe(FAKE_REFRESH_TOKEN);

    const status = await adminSession.client.rpc('get_calendar_status');
    expect(status.error).toBeNull();
    expect(status.data?.[0]).toMatchObject({
      connected: true,
      google_email: FAKE_GOOGLE_EMAIL,
      app_calendar_id: FAKE_CALENDAR_ID,
      broken: false,
    });
  });

  it('a token response with no refresh_token redirects to calendar=error and writes nothing', async () => {
    const { cookie, state } = await startFlow();
    const calls = googleFlow({ includeRefreshToken: false });

    const res = await handleGoogleCallback(callbackAs(adminSession, `state=${encodeURIComponent(state)}&code=test-auth-code`, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=error`);
    expect(await connectionRow()).toBeNull();
    expectClearsCookie(res);
    // Only the token exchange should have run: no email/calendar call once the refresh token is missing.
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
  });
});
