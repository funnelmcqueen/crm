// SPEC 7a.2 / 12 / 13: POST /api/voice/token and POST /api/voice/presence.
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleVoicePresence, handleVoiceToken } from '@/server/http/voice';
import { serviceClient, signInAs, type SignedInUser } from '../helpers/clients';
import { createUser, disableUser } from '../helpers/fixtures';
import {
  APP_BASE_URL,
  INTERNAL_ORIGIN,
  TEST_ACCOUNT_SID,
  TEST_API_KEY_SID,
  TEST_TWIML_APP_SID,
  UNCONFIGURED,
  browserRequest,
  routeEnv,
  stubSessionEnv,
  unstubSessionEnv,
} from './_helpers';

const TOKEN_PATH = '/api/voice/token';
const PRESENCE_PATH = '/api/voice/presence';

async function freshAgent(options: Parameters<typeof createUser>[0] = {}): Promise<SignedInUser> {
  const user = await createUser(options);
  return signInAs(user.email, user.password);
}

async function errorBody(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

beforeAll(() => stubSessionEnv());
afterAll(() => unstubSessionEnv());

describe('POST /api/voice/token', () => {
  it('issues a Voice token for identity = user id with the TwiML App voice grant', async () => {
    const agent = await freshAgent();
    const res = await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken }), { env: routeEnv() });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { token: string; identity: string; ttl: number };
    expect(body.identity).toBe(agent.userId);
    expect(body.ttl).toBe(3600);

    const claims = decodeJwt(body.token) as { iss?: string; sub?: string; exp?: number; iat?: number; grants?: { identity?: string; voice?: { incoming?: { allow?: boolean }; outgoing?: { application_sid?: string } } } };
    expect(claims.iss).toBe(TEST_API_KEY_SID);
    expect(claims.sub).toBe(TEST_ACCOUNT_SID);
    expect(claims.grants?.identity).toBe(agent.userId);
    expect(claims.grants?.voice?.outgoing?.application_sid).toBe(TEST_TWIML_APP_SID);
    expect(claims.grants?.voice?.incoming?.allow).toBe(true);
    expect((claims.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
  });

  it('401 without a session', async () => {
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH), { env: routeEnv() }), 401, 'unauthorized');
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { token: 'not-a-jwt' }), { env: routeEnv() }), 401, 'unauthorized');
  });

  it('401 for a disabled agent whose access token is still valid', async () => {
    const user = await createUser();
    const session = await signInAs(user.email, user.password);
    await disableUser(user.id);
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { token: session.accessToken }), { env: routeEnv() }), 401, 'unauthorized');
  });

  it('403 when in-app calling is disabled for the agent', async () => {
    const agent = await freshAgent({ inAppCallingEnabled: false });
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken }), { env: routeEnv() }), 403, 'forbidden');
  });

  it('503 when Twilio is not configured or the dialer driver is not twilio', async () => {
    const agent = await freshAgent();
    for (const env of [routeEnv(UNCONFIGURED), routeEnv({ DIALER_DRIVER: 'mock' }), routeEnv({ DIALER_DRIVER: 'tel' })]) {
      await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken }), { env }), 503, 'unavailable');
    }
  });

  it('429 once the voice_token limit (20 per 10 minutes, fixed in SQL) is used up', async () => {
    const agent = await freshAgent();
    for (let i = 0; i < 20; i += 1) {
      const res = await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken }), { env: routeEnv() });
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken }), { env: routeEnv() }), 429, 'rate_limited');
  });

  it('403 for a cross-site Origin; same-origin and the public origin are accepted', async () => {
    const agent = await freshAgent();
    await errorBody(
      await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken, origin: 'https://evil.example' }), { env: routeEnv() }),
      403,
      'forbidden',
    );
    await errorBody(await handleVoiceToken(browserRequest(TOKEN_PATH, { origin: 'null' }), { env: routeEnv() }), 403, 'forbidden');
    const ok = await handleVoiceToken(browserRequest(TOKEN_PATH, { token: agent.accessToken, origin: APP_BASE_URL }), { env: routeEnv() });
    expect(ok.status).toBe(200);
    const proxied = new Request(`${INTERNAL_ORIGIN}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.accessToken}`, Origin: INTERNAL_ORIGIN },
    });
    expect((await handleVoiceToken(proxied, { env: routeEnv() })).status).toBe(200);
  });
});

describe('POST /api/voice/presence', () => {
  async function deviceSeenAt(userId: string): Promise<string | null> {
    const { data } = await serviceClient().from('profiles').select('device_seen_at').eq('id', userId).single();
    return data?.device_seen_at ?? null;
  }

  it('204 and updates device_seen_at', async () => {
    const agent = await freshAgent();
    expect(await deviceSeenAt(agent.userId)).toBeNull();
    const before = Date.now();
    const res = await handleVoicePresence(browserRequest(PRESENCE_PATH, { token: agent.accessToken }), { env: routeEnv() });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(Date.parse((await deviceSeenAt(agent.userId)) ?? '')).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('401 without a session or for a disabled agent, 403 for a cross-site Origin (no update)', async () => {
    await errorBody(await handleVoicePresence(browserRequest(PRESENCE_PATH), { env: routeEnv() }), 401, 'unauthorized');

    const user = await createUser();
    const session = await signInAs(user.email, user.password);
    await disableUser(user.id);
    await errorBody(await handleVoicePresence(browserRequest(PRESENCE_PATH, { token: session.accessToken }), { env: routeEnv() }), 401, 'unauthorized');
    expect(await deviceSeenAt(user.id)).toBeNull();

    const agent = await freshAgent();
    await errorBody(
      await handleVoicePresence(browserRequest(PRESENCE_PATH, { token: agent.accessToken, origin: 'https://evil.example' }), { env: routeEnv() }),
      403,
      'forbidden',
    );
    expect(await deviceSeenAt(agent.userId)).toBeNull();
  });
});
