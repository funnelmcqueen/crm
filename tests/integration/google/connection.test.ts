// Google Calendar connection (docs/DEVIATIONS.md D47, design §5): the admin-only OAuth + PKCE round trip that
// connects the account ('connect flow'), and availability/booking/cancel wired to the real Google-backed
// calendar client once connected ('booking against Google'). Both share one file (fix round 1, item 1) because
// calendar_connection is a locked-down singleton no API role — admin included — may select directly, and every
// test here connects or disconnects that one row; two separate integration test files each doing that raced
// across Vitest's parallel workers (vitest.config.ts sets no fileParallelism: false for the integration
// project). One file's tests already run sequentially within it, which is all the isolation this needs — unlike
// company settings (tests/integration/settings/settings-services.test.ts), nothing else in the suite reads this
// table's content for comparison, so the heavier private-localbase pattern that file uses is not needed here.
// Google's HTTP surface is stubbed at the fetch layer throughout — every non-Google call (the shared local
// Supabase stack) passes through to the real fetch, so no test here reaches the actual network for Google.
// Every credential below is an obvious placeholder; nothing here is a real client id, secret, code or token.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_FAILED_MESSAGE, BOOKING_UNAVAILABLE_MESSAGE } from '@/lib/domain/booking-messages';
import type { CalendarClient } from '@/server/calendar/types';
import type { RequestContext } from '@/server/context';
import { resetEnvCacheForTests } from '@/server/env';
import { decryptRefreshToken, encryptRefreshToken } from '@/server/google/crypto';
import { GOOGLE_SCOPES } from '@/server/google/oauth';
import { handleGoogleCallback, handleGoogleStart } from '@/server/http/google-oauth';
import { bookAppointment, cancelAppointment, getAgentAvailability } from '@/server/services/calendar-booking';
import { serviceClient, signInAs, type SignedInUser } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { testStack } from '../../helpers/env';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';
import { APP_BASE_URL, browserRequest } from '../../routes/_helpers';

describe('connect flow', () => {
  const GOOGLE_CLIENT_ID = 'test-client-id';
  const GOOGLE_CLIENT_SECRET = 'test-client-secret';
  const GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const FAKE_ACCESS_TOKEN = 'test-access-token';
  const FAKE_REFRESH_TOKEN = 'test-refresh-token';
  const FAKE_CALENDAR_ID = 'test-app-calendar-id';
  const FAKE_GOOGLE_EMAIL = 'connected-owner@example.test';
  const TEST_AUTH_CODE = 'test-auth-code';

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

  function googleFlow(options: { includeRefreshToken?: boolean; calendarId?: string; email?: string } = {}): FetchCall[] {
    const includeRefreshToken = options.includeRefreshToken ?? true;
    const calendarId = options.calendarId ?? FAKE_CALENDAR_ID;
    const email = options.email ?? FAKE_GOOGLE_EMAIL;
    return stubGoogleFetch((url) => {
      if (url === TOKEN_URL) {
        const body: Record<string, unknown> = { access_token: FAKE_ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' };
        if (includeRefreshToken) body.refresh_token = FAKE_REFRESH_TOKEN;
        return json(body);
      }
      if (url === USERINFO_URL) return json({ email });
      if (url === CALENDAR_INSERT_URL) return json({ id: calendarId });
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

  /** Decodes this file's own view of the cookie: name=base64url(JSON({state, verifier})). */
  function decodeStateCookie(cookie: string): { state: string; verifier: string } {
    const value = cookie.slice(cookie.indexOf('=') + 1);
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return JSON.parse(decoded) as { state: string; verifier: string };
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

  /** Runs a real GET /api/google/start as the admin and returns everything the callback flow needs. */
  async function startFlow(): Promise<{ cookie: string; state: string; verifier: string; codeChallenge: string }> {
    const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET', token: adminSession.accessToken }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const codeChallenge = location.searchParams.get('code_challenge') ?? '';
    const cookie = setCookieHeader(res, COOKIE_NAME)?.split(';')[0] ?? '';
    expect(state).not.toBe('');
    expect(cookie).not.toBe('');
    const { verifier } = decodeStateCookie(cookie);
    return { cookie, state, verifier, codeChallenge };
  }

  function callbackAs(session: SignedInUser | null, query: string, cookie: string): Request {
    return browserRequest(`${CALLBACK_PATH}?${query}`, { method: 'GET', token: session?.accessToken, headers: { Cookie: cookie } });
  }

  let admin: FixtureUser;
  let agent: FixtureUser;
  let adminSession: SignedInUser;
  let agentSession: SignedInUser;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

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
    // Keeps the run pristine (the handler does log a sanitized line on a failed connection attempt) and
    // gives every test a record to check for secrets in — see expectNoSecretsLogged below (fix round 1, #4).
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleErrorSpy.mockRestore();
  });

  /** The only test coverage "no token may reach a log" actually has: inspects what was really logged. */
  function expectNoSecretsLogged(): void {
    const text = consoleErrorSpy.mock.calls
      .flat()
      .map((arg: unknown) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(text).not.toContain(FAKE_REFRESH_TOKEN);
    expect(text).not.toContain(FAKE_ACCESS_TOKEN);
    expect(text).not.toContain(GOOGLE_CLIENT_SECRET);
    expect(text).not.toContain(TEST_AUTH_CODE);
  }

  describe('handleGoogleStart', () => {
    it('refuses an agent with 403 and writes nothing', async () => {
      const calls = noGoogleNetwork();
      const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET', token: agentSession.accessToken }));
      expect(res.status).toBe(403);
      expect(await connectionRow()).toBeNull();
      expect(calls).toEqual([]);
    });

    it('refuses a signed-out caller with 401 and writes nothing', async () => {
      const calls = noGoogleNetwork();
      const res = await handleGoogleStart(browserRequest(START_PATH, { method: 'GET' }));
      expect(res.status).toBe(401);
      expect(await connectionRow()).toBeNull();
      expect(calls).toEqual([]);
    });

    it("redirects an admin to Google's consent URL with the four scopes and PKCE, and sets a short-lived state cookie", async () => {
      const calls = noGoogleNetwork();
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
      expect(calls).toEqual([]);
    });

    it("binds the consent URL's code_challenge to the state cookie's verifier (S256), and the token exchange later sends that same verifier", async () => {
      const { cookie, state, verifier, codeChallenge } = await startFlow();
      expect(codeChallenge).toBe(createHash('sha256').update(verifier).digest('base64url'));

      const calls = googleFlow();
      const res = await handleGoogleCallback(callbackAs(adminSession, `state=${encodeURIComponent(state)}&code=${TEST_AUTH_CODE}`, cookie));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=connected`);

      const tokenCall = calls.find((c) => c.url === TOKEN_URL);
      expect(tokenCall).toBeTruthy();
      const body = new URLSearchParams((tokenCall?.init.body as string) ?? '');
      expect(body.get('code_verifier')).toBe(verifier);
      expectNoSecretsLogged();
    });
  });

  describe('handleGoogleCallback', () => {
    it('rejects a mismatched state, writes nothing, reaches no Google endpoint, and clears the cookie', async () => {
      const calls = noGoogleNetwork();
      const { cookie } = await startFlow();
      const res = await handleGoogleCallback(callbackAs(adminSession, 'state=wrong-state&code=test-auth-code', cookie));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=error`);
      expect(await connectionRow()).toBeNull();
      expectClearsCookie(res);
      expect(calls).toEqual([]);
      expectNoSecretsLogged();
    });

    it('redirects error=access_denied to calendar=denied and writes nothing', async () => {
      const calls = noGoogleNetwork();
      const { cookie, state } = await startFlow();
      const res = await handleGoogleCallback(callbackAs(adminSession, `error=access_denied&state=${encodeURIComponent(state)}`, cookie));
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=denied`);
      expect(await connectionRow()).toBeNull();
      expectClearsCookie(res);
      expect(calls).toEqual([]);
      expectNoSecretsLogged();
    });

    it('re-checks the admin session on the callback: a non-admin caller is refused and writes nothing', async () => {
      const calls = noGoogleNetwork();
      const { cookie, state } = await startFlow();
      const res = await handleGoogleCallback(callbackAs(agentSession, `state=${encodeURIComponent(state)}&code=test-auth-code`, cookie));
      expect(res.status).toBe(403);
      expect(await connectionRow()).toBeNull();
      expectClearsCookie(res);
      expect(calls).toEqual([]);
      expectNoSecretsLogged();
    });

    it('refuses a signed-out caller with 401, writes nothing, and still clears the cookie', async () => {
      const calls = noGoogleNetwork();
      const { cookie, state } = await startFlow();
      const res = await handleGoogleCallback(callbackAs(null, `state=${encodeURIComponent(state)}&code=${TEST_AUTH_CODE}`, cookie));
      expect(res.status).toBe(401);
      expect(await connectionRow()).toBeNull();
      expectClearsCookie(res);
      expect(calls).toEqual([]);
      expectNoSecretsLogged();
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
      expectNoSecretsLogged();
    });

    it('reconnecting reuses the existing app calendar instead of creating a second one', async () => {
      const first = await startFlow();
      googleFlow();
      const firstRes = await handleGoogleCallback(
        callbackAs(adminSession, `state=${encodeURIComponent(first.state)}&code=${TEST_AUTH_CODE}`, first.cookie),
      );
      expect(firstRes.status).toBe(302);
      expect(firstRes.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=connected`);
      expect((await connectionRow())?.app_calendar_id).toBe(FAKE_CALENDAR_ID);

      // A distinct id: if the callback wrongly creates a second calendar, both assertions below catch it —
      // the insert call itself, and the stored id changing to this one.
      const second = await startFlow();
      const calls = googleFlow({ calendarId: `${FAKE_CALENDAR_ID}-should-not-be-created` });
      const secondRes = await handleGoogleCallback(
        callbackAs(adminSession, `state=${encodeURIComponent(second.state)}&code=${TEST_AUTH_CODE}`, second.cookie),
      );
      expect(secondRes.status).toBe(302);
      expect(secondRes.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=connected`);

      expect(calls.some((c) => c.url === CALENDAR_INSERT_URL)).toBe(false);
      expect((await connectionRow())?.app_calendar_id).toBe(FAKE_CALENDAR_ID);
    });

    it('reconnecting with a different Google account creates a new calendar and replaces app_calendar_id, instead of reusing a calendar unreachable under the new grant', async () => {
      const first = await startFlow();
      googleFlow();
      const firstRes = await handleGoogleCallback(
        callbackAs(adminSession, `state=${encodeURIComponent(first.state)}&code=${TEST_AUTH_CODE}`, first.cookie),
      );
      expect(firstRes.status).toBe(302);
      expect(await connectionRow()).toMatchObject({ google_email: FAKE_GOOGLE_EMAIL, app_calendar_id: FAKE_CALENDAR_ID });

      const DIFFERENT_GOOGLE_EMAIL = 'a-different-owner@example.test';
      const DIFFERENT_CALENDAR_ID = 'test-app-calendar-id-2';
      const second = await startFlow();
      const calls = googleFlow({ email: DIFFERENT_GOOGLE_EMAIL, calendarId: DIFFERENT_CALENDAR_ID });
      const secondRes = await handleGoogleCallback(
        callbackAs(adminSession, `state=${encodeURIComponent(second.state)}&code=${TEST_AUTH_CODE}`, second.cookie),
      );
      expect(secondRes.status).toBe(302);
      expect(secondRes.headers.get('location')).toBe(`${APP_BASE_URL}/settings?calendar=connected`);

      // The old calendar id belongs to the first account's calendar.app.created grant and is unreachable under
      // the new account, so reusing it (rather than creating a fresh one) would make every later booking fail.
      expect(calls.some((c) => c.url === CALENDAR_INSERT_URL)).toBe(true);
      expect(await connectionRow()).toMatchObject({ google_email: DIFFERENT_GOOGLE_EMAIL, app_calendar_id: DIFFERENT_CALENDAR_ID });
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
      // This is the one branch that does log (exchange_code) — the real coverage for "never logs a token".
      expect(consoleErrorSpy).toHaveBeenCalled();
      expectNoSecretsLogged();
    });
  });
});

describe('booking against Google', () => {
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
    vi.stubEnv('APP_BASE_URL', APP_BASE_URL);
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
        // Answers for exactly the calendars the request asked about, so the assertions about WHICH calendar is
        // queried live in the tests rather than here (D48: each agent's own, never the owner's primary).
        const items = (parseBody(init.body) as { items?: Array<{ id: string }> } | null)?.items ?? [];
        return json({ calendars: Object.fromEntries(items.map((item) => [item.id, { busy: options.busy ?? [] }])) });
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

  /** Provisioned by default: without a calendar of their own an agent cannot book at all (D48). */
  async function agentAndLead(name: string, overrides: Parameters<typeof createLead>[0] = {}) {
    const agent = await createUser({ name: `${name} ${TAG}` });
    const calendarId = `agent-cal-${randomUUID()}`;
    await giveCalendar(agent.id, calendarId);
    const ctx = await contextForUser(agent);
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} ${name}`, state: 'FL', country: 'US', ...overrides });
    return { agent, ctx, lead, calendarId };
  }

  async function giveCalendar(userId: string, calendarId: string | null): Promise<void> {
    const { error } = await serviceClient().from('profiles').update({ google_calendar_id: calendarId }).eq('id', userId);
    if (error) throw new Error(`giveCalendar failed: ${error.message}`);
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
      expect(insert2).toBeDefined();
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

    it('does not let a database error during the post-confirm cleanup replace the mapped confirm failure', async () => {
      // The main calendar comes from a fake (not Google) so only the post-confirm cleanup's own connection read
      // touches createAdminClient — the one seam this suite can break deterministically, by making its service
      // role key wrong for just this test. confirm_appointment is made to fail by handing it an oversized event
      // id (over 1024 chars, the RPC's own limit), a fake-calendar detail already fully under this test's control
      // — no timing race against a concurrent write was needed.
      await connect();
      const { ctx, lead } = await agentAndLead('CleanupDbFails');
      const oversizedEventId = 'x'.repeat(1100);
      const fakeCalendar: CalendarClient = {
        async readAvailability() {
          return { windows: [{ start: at(9), end: at(9.5) }], busy: [] };
        },
        async createMeeting() {
          return { eventId: oversizedEventId };
        },
      };
      const calls = stubGoogle();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'broken-service-role-key-for-this-test-only');
      resetEnvCacheForTests();
      let cleanupLogged = false;
      try {
        // Pre-fix, the cleanup's own database error escaped uncaught and replaced this rejection.
        await expect(
          bookAppointment(ctx, request(lead.id, at(9)), { calendar: fakeCalendar, now: () => at(0) }),
        ).rejects.toMatchObject({ code: 'validation' });
        // Read the spy's calls before mockRestore() below, which also resets its recorded call history.
        cleanupLogged = consoleErrorSpy.mock.calls.some(
          (call) => call[0] === '[booking] cancelMeeting failed' && (call[1] as { eventId?: unknown })?.eventId === oversizedEventId,
        );
      } finally {
        stubGoogleEnv(); // Restores the real service role key before any later test in this file runs.
        consoleErrorSpy.mockRestore();
      }

      // Nothing here ever reaches Google: the fake calendar covers the booking, and the cleanup's own database
      // read fails before it would call Google at all.
      expect(calls).toEqual([]);
      expect(cleanupLogged).toBe(true);

      const { data: rows } = await serviceClient().from('appointments').select('status').eq('lead_id', lead.id);
      expect(rows?.every((row) => row.status !== 'scheduled')).toBe(true);
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

  describe('a connection already marked broken', () => {
    it('is unavailable without paying for a Google round trip that is guaranteed to fail', async () => {
      await connect();
      await serviceClient().from('calendar_connection').update({ broken_at: new Date().toISOString() }).eq('id', true);
      const { ctx, lead } = await agentAndLead('AlreadyBroken');
      const calls = stubGoogle();

      await expect(getAgentAvailability(ctx, lead.id, { now: () => at(3) })).rejects.toMatchObject({
        code: 'unavailable',
        message: BOOKING_UNAVAILABLE_MESSAGE,
      });
      expect(calls).toEqual([]);
    });
  });

  describe('an agent with no calendar of their own', () => {
    it('is unavailable and calls no Google endpoint, even on a healthy connection', async () => {
      await connect();
      const { ctx, lead, agent } = await agentAndLead('NoAgentCal');
      await giveCalendar(agent.id, null);
      const calls = stubGoogle();

      await expect(getAgentAvailability(ctx, lead.id, { now: () => at(4) })).rejects.toMatchObject({
        code: 'unavailable',
        message: BOOKING_UNAVAILABLE_MESSAGE,
      });
      expect(calls).toEqual([]);
    });
  });

  describe('cancelAppointment against Google', () => {
    it('deletes the Google event, and still marks the appointment cancelled when the delete fails', async () => {
      await connect();

      const { ctx, lead, calendarId } = await agentAndLead('Cancel');
      const eventId = `evt-${randomUUID()}`;
      const insertCalls = stubGoogle({ insertResult: { id: eventId } });
      const booked = await bookAppointment(ctx, request(lead.id, at(8)), { now: () => at(0) });
      // The meeting is written to the booking agent's own calendar, not a shared one (D48).
      expect(insertCalls.find((call) => call.method === 'POST' && call.url.includes('/events?'))?.url).toContain(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
      );

      const deleteCalls = stubGoogle();
      await cancelAppointment(admin, booked.id);
      const deleteCall = deleteCalls.find((call) => call.method === 'DELETE');
      // Cancelled by an ADMIN, so the calendar has to come from the appointment's booked_by, not the caller.
      expect(deleteCall?.url).toBe(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
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
});
