// supabase-js clients for integration tests, used exactly like a browser attacker would (anon key +
// real user JWT), plus the service-role client for arranging fixtures.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';
import type { Database } from '../../src/lib/database.types';
import { SEED_PASSWORD } from '../../scripts/lib/seed-data';
import { testStack } from './env';

export type TestClient = SupabaseClient<Database>;

let clientCounter = 0;

function makeClient(key: string, headers: Record<string, string> = {}): TestClient {
  clientCounter += 1;
  return createClient<Database>(testStack().url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `fmq-test-${process.pid}-${clientCounter}`,
    },
    global: { headers },
  });
}

/** Anonymous client (anon key, no session). */
export function anonClient(): TestClient {
  return makeClient(testStack().anonKey);
}

/** Service-role client. Bypasses RLS; use it only to arrange and inspect fixtures. */
export function serviceClient(): TestClient {
  return makeClient(testStack().serviceRoleKey);
}

/** Anon-key client that sends a fixed `Authorization: Bearer <accessToken>` on every REST/RPC call. */
export function clientWithAccessToken(accessToken: string): TestClient {
  return makeClient(testStack().anonKey, { Authorization: `Bearer ${accessToken}` });
}

export interface SignedInUser {
  client: TestClient;
  userId: string;
  accessToken: string;
}

/** Password sign-in through the Auth API. Throws when sign-in fails. */
export async function signInAs(email: string, password: string = SEED_PASSWORD): Promise<SignedInUser> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`signInAs(${email}) failed: ${error?.message ?? 'no session returned'}`);
  }
  return { client, userId: data.user.id, accessToken: data.session.access_token };
}

/** Password sign-in that returns the error instead of throwing (for negative tests). */
export async function trySignIn(
  email: string,
  password: string = SEED_PASSWORD,
): Promise<{ user: SignedInUser | null; error: { message: string; code?: string; status?: number } | null }> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    return { user: null, error: error ? { message: error.message, code: error.code, status: error.status } : { message: 'no session' } };
  }
  return { user: { client, userId: data.user.id, accessToken: data.session.access_token }, error: null };
}

/**
 * Mints an HS256 JWT with the stack's secret (localbase always; external stacks only with
 * SUPABASE_TEST_JWT_SECRET). Use it for forged/expired-token tests. Pass `secret` to sign with a wrong key.
 */
export async function mintJwt(
  claims: Record<string, unknown>,
  options: { expiresInSeconds?: number; secret?: string } = {},
): Promise<string> {
  const secret = options.secret ?? testStack().jwtSecret;
  if (!secret) throw new Error('mintJwt: no JWT secret for this stack (set SUPABASE_TEST_JWT_SECRET)');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: 'supabase-demo', aud: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 3600))
    .sign(new TextEncoder().encode(secret));
}
