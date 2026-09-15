// Assertion and attacker helpers for the agent-isolation suite (SPEC 13, tests/integration/isolation-*).
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect } from 'vitest';
import { SEED_PASSWORD } from '../../scripts/lib/seed-data';
import { anonClient, type TestClient } from './clients';
import { testStack } from './env';

interface ErrorLike {
  code?: string;
  message: string;
}

interface ResultLike {
  data: unknown;
  error: ErrorLike | null;
  status?: number;
}

/** The request was refused (optionally with one of the given codes) and returned no data. */
export function expectError(result: ResultLike, code?: string | readonly string[]): void {
  expect(result.error, `expected an error, got data ${JSON.stringify(result.data)}`).not.toBeNull();
  if (code !== undefined) {
    const codes: readonly string[] = typeof code === 'string' ? [code] : code;
    expect(codes, `unexpected error ${JSON.stringify(result.error)}`).toContain(result.error?.code);
  }
  expect(result.data ?? null).toBeNull();
}

/** The request succeeded and returned exactly `[]`. */
export function expectEmptyRows(result: ResultLike): void {
  expect(result.error, `unexpected error ${JSON.stringify(result.error)}`).toBeNull();
  expect(result.data).toEqual([]);
}

/**
 * A write that must have no effect: either refused, or matched zero rows. Always call it on a
 * mutation with `.select('id')`, and confirm the row with the service client afterwards.
 */
export function expectNoRowsAffected(result: ResultLike): void {
  if (result.error) return;
  expect(result.data, 'a write that must not match any row returned rows').toEqual([]);
}

let untypedCounter = 0;

/**
 * supabase-js without the generated Database types (anon key, optional bearer token), for probing
 * arbitrary table and function names in loops the way a dev-tools attacker would.
 */
export function untypedClient(accessToken?: string): SupabaseClient {
  untypedCounter += 1;
  const stack = testStack();
  return createClient(stack.url, stack.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `fmq-untyped-${process.pid}-${untypedCounter}`,
    },
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
  });
}

export interface SessionTokens {
  client: TestClient;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** Password sign-in that also returns the refresh token. Throws when sign-in fails. */
export async function signInWithTokens(email: string, password: string = SEED_PASSWORD): Promise<SessionTokens> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`signInWithTokens(${email}) failed: ${error?.message ?? 'no session returned'}`);
  }
  return {
    client,
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
}

/** Rewrites claims in a JWT payload but keeps the original header and signature. */
export function tamperJwtPayload(token: string, patch: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const forged = Buffer.from(JSON.stringify({ ...claims, ...patch }), 'utf8').toString('base64url');
  return `${header}.${forged}.${signature}`;
}

/** An unsigned `alg: none` token with the given claims. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 3600, ...claims }), 'utf8').toString('base64url');
  return `${header}.${payload}.`;
}

export const API_TABLES = ['profiles', 'settings', 'leads', 'phone_numbers', 'calls', 'follow_ups', 'rate_limit_hits'] as const;

export interface RpcProbe {
  name: string;
  args: Record<string, unknown>;
}

/** Every stage-1 public function with plausible arguments (random ids never match a real row). */
export function rpcProbes(): RpcProbe[] {
  const id = randomUUID();
  return [
    { name: 'is_privileged_role', args: {} },
    { name: 'is_admin', args: {} },
    { name: 'is_active_user', args: {} },
    { name: 'can_access_lead', args: { p_lead_id: id } },
    { name: 'outcome_to_status', args: { p_outcome: 'NO_ANSWER', p_current: 'NEW' } },
    { name: 'lead_earliest_open_follow_up', args: { p_lead_id: id } },
    { name: 'log_call', args: { p_outcome: 'CONNECTED', p_lead_id: id } },
    { name: 'get_next_lead', args: {} },
    { name: 'create_outbound_call', args: { p_lead_id: id } },
    { name: 'get_lead_call_history', args: { p_lead_id: id } },
    { name: 'get_voicemail_recording', args: { p_call_id: id, p_user_id: id } },
    { name: 'mark_voicemail_heard', args: { p_call_id: id } },
    { name: 'list_voicemails', args: {} },
    { name: 'unheard_voicemail_count', args: {} },
    { name: 'reassign_leads', args: { p_lead_ids: [id], p_to_user_id: id } },
    { name: 'search_leads', args: {} },
    { name: 'list_lead_sources', args: {} },
    { name: 'touch_device_presence', args: {} },
    { name: 'consume_rate_limit', args: { p_bucket: 'voice_token' } },
    { name: 'apply_rate_limit', args: { p_user_id: id, p_bucket: 'voice_token' } },
    { name: 'claim_caller_id', args: { p_user_id: id } },
    { name: 'apply_call_status', args: { p_call_sid: 'CAprobe', p_status: 'completed' } },
    { name: 'record_voicemail', args: { p_call_sid: 'CAprobe', p_recording_sid: 'REprobe', p_duration: 5 } },
  ];
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
