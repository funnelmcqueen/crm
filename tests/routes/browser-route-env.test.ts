// The three cookie-authenticated POST routes read the server environment as their first statement,
// outside the try block:  const env = deps.env ?? getServerEnv();
// A ServerEnv validation error therefore escaped the handler entirely and Next rendered a generic 500 —
// with no mapped error code for the client, and *before* isAllowedOrigin ran, so the documented CSRF
// check never happened. The Twilio path already does the opposite and is the in-repo precedent:
// runTwilioWebhook wraps the same call in try/catch and answers with its own contract.
//
// AppError('unavailable') → 503 is the mapped answer for "this server cannot serve this right now",
// and it is what ARCHITECTURE section 7 promises for a dialer route that has no working configuration.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleCallsOutbound, handleVoicePresence, handleVoiceToken } from '@/server/http/voice';
import { resetEnvCacheForTests } from '@/server/env';
import { testStack } from '../helpers/env';
import { APP_BASE_URL, browserRequest, stubSessionEnv, unstubSessionEnv } from './_helpers';

type Handler = (req: Request) => Promise<Response>;

const HANDLERS: Array<[string, Handler, string]> = [
  ['/api/voice/token', handleVoiceToken, '/api/voice/token'],
  ['/api/voice/presence', handleVoicePresence, '/api/voice/presence'],
  ['/api/calls/outbound', handleCallsOutbound, '/api/calls/outbound'],
];

/**
 * A server environment that parses today but is invalid: D24 refuses the mock dialer in production.
 * This is exactly the shape an operator hits by copying a dev .env into a deployment.
 */
function stubInvalidEnv(overrides: Record<string, string | undefined> = {}): void {
  const stack = testStack();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', stack.url);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', stack.anonKey);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', stack.serviceRoleKey);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DIALER_DRIVER', 'mock');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  resetEnvCacheForTests();
}

beforeAll(() => stubSessionEnv());

afterEach(() => {
  unstubSessionEnv();
  stubSessionEnv();
});

describe('browser POST routes with an invalid server environment', () => {
  it.each(HANDLERS)('%s answers 503 unavailable instead of an unhandled 500', async (_name, handle, path) => {
    stubInvalidEnv();
    const res = await handle(browserRequest(path, { body: JSON.stringify({ leadId: crypto.randomUUID() }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each(HANDLERS)('%s answers a cross-origin request with the same 503, never a 500', async (_name, handle, path) => {
    stubInvalidEnv();
    const res = await handle(browserRequest(path, { origin: 'https://evil.example', body: '{}' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it.each(HANDLERS)('%s answers 503 when a required variable is missing entirely', async (_name, handle, path) => {
    stubInvalidEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined, DIALER_DRIVER: undefined, NODE_ENV: 'test' });
    const res = await handle(browserRequest(path, { body: '{}' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('keeps the documented answers when the environment is valid', async () => {
    // Same requests, valid environment: the origin check and the session check do run.
    const stack = testStack();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', stack.url);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', stack.anonKey);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', stack.serviceRoleKey);
    vi.stubEnv('APP_BASE_URL', APP_BASE_URL);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DIALER_DRIVER', 'tel');
    resetEnvCacheForTests();
    const forbidden = await handleVoiceToken(browserRequest('/api/voice/token', { origin: 'https://evil.example' }));
    expect(forbidden.status).toBe(403);
    const unauthorized = await handleVoiceToken(browserRequest('/api/voice/token'));
    expect(unauthorized.status).toBe(401);
  });
});
