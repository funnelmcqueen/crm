// Fixture creators for integration tests. Everything is written through the service-role client
// with unique emails and fictional 555-01xx phones, so tests never touch seeded rows.
import { randomUUID } from 'node:crypto';
import type { PostgrestError } from '@supabase/supabase-js';
import type { Tables, TablesInsert, TablesUpdate } from '../../src/lib/database.types';
import { serviceClient } from './clients';
import { createPhoneFactory, fakeTwilioSid } from './phones';

export { fakeTwilioSid };

export const FIXTURE_PASSWORD = 'Fixture-pass-2026!';
export const FIXTURE_EMAIL_DOMAIN = 'fixtures.funnelmcqueen.test';
/** ~100 years, like the seed's disabled agent. */
export const PERMANENT_BAN = '876000h';

const RUN_ID = randomUUID().slice(0, 8);
const WORKER = Number.parseInt(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1', 10) || 1;
const phones = createPhoneFactory({ partition: WORKER, partitions: 16 });
let counter = 0;

function nextSuffix(): string {
  counter += 1;
  return `${RUN_ID}-w${WORKER}-${counter}`;
}

/** Unique per test run and per worker. */
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${nextSuffix()}@${FIXTURE_EMAIL_DOMAIN}`;
}

/** A fictional +1 NXX 555-01xx number, unique within this run. */
export function fictionalPhone(): string {
  return phones.next();
}

function fail(what: string, error: PostgrestError | { message: string } | null): never {
  throw new Error(`fixture ${what} failed: ${error?.message ?? 'no data returned'}`);
}

export type Profile = Tables<'profiles'>;
export type Lead = Tables<'leads'>;
export type Call = Tables<'calls'>;
export type FollowUp = Tables<'follow_ups'>;
export type PhoneNumber = Tables<'phone_numbers'>;

export interface CreateUserOptions {
  role?: 'ADMIN' | 'AGENT';
  /** false disables the profile and bans the auth user (see disableUser). */
  active?: boolean;
  timezone?: string;
  inAppCallingEnabled?: boolean;
  dailyCallTarget?: number;
  name?: string;
  email?: string;
  password?: string;
}

export interface FixtureUser {
  id: string;
  email: string;
  password: string;
  role: 'ADMIN' | 'AGENT';
}

export async function createUser(options: CreateUserOptions = {}): Promise<FixtureUser> {
  const role = options.role ?? 'AGENT';
  const email = options.email ?? uniqueEmail(role === 'ADMIN' ? 'admin' : 'agent');
  const password = options.password ?? FIXTURE_PASSWORD;
  const service = serviceClient();
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: options.name ?? `Fixture ${role === 'ADMIN' ? 'Admin' : 'Agent'} ${counter}` },
  });
  if (error || !data.user) fail(`createUser ${email}`, error);
  const id = data.user.id;

  const patch: TablesUpdate<'profiles'> = {
    role,
    in_app_calling_enabled: options.inAppCallingEnabled ?? true,
  };
  if (options.timezone !== undefined) patch.timezone = options.timezone;
  if (options.dailyCallTarget !== undefined) patch.daily_call_target = options.dailyCallTarget;
  const updated = await service.from('profiles').update(patch).eq('id', id).select('id');
  if (updated.error || updated.data.length !== 1) fail(`profile update for ${email}`, updated.error);

  if (options.active === false) await disableUser(id);
  return { id, email, password, role };
}

/** What the admin "disable agent" flow does: profiles.active = false plus an Auth ban. */
export async function disableUser(userId: string): Promise<void> {
  const service = serviceClient();
  const updated = await service.from('profiles').update({ active: false }).eq('id', userId).select('id');
  if (updated.error || updated.data.length !== 1) fail(`disable profile ${userId}`, updated.error);
  const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: PERMANENT_BAN });
  if (error) fail(`ban ${userId}`, error);
}

export async function enableUser(userId: string): Promise<void> {
  const service = serviceClient();
  const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: 'none' });
  if (error) fail(`unban ${userId}`, error);
  const updated = await service.from('profiles').update({ active: true }).eq('id', userId).select('id');
  if (updated.error || updated.data.length !== 1) fail(`enable profile ${userId}`, updated.error);
}

export async function createLead(overrides: Partial<TablesInsert<'leads'>> = {}): Promise<Lead> {
  const suffix = nextSuffix();
  const row: TablesInsert<'leads'> = {
    business_name: `Fixture Lead ${suffix}`,
    phone: fictionalPhone(),
    city: 'Testville',
    state: 'TX',
    country: 'US',
    status: 'NEW',
    ...overrides,
  };
  const { data, error } = await serviceClient().from('leads').insert(row).select('*').single();
  if (error || !data) fail('createLead', error);
  return data;
}

/** Defaults to an OUTBOUND TEL call. OUTBOUND rows need lead_id and user_id (table CHECK). */
export async function createCall(overrides: Partial<TablesInsert<'calls'>> = {}): Promise<Call> {
  const row: TablesInsert<'calls'> = { direction: 'OUTBOUND', mode: 'TEL', ...overrides };
  const { data, error } = await serviceClient().from('calls').insert(row).select('*').single();
  if (error || !data) fail('createCall', error);
  return data;
}

export async function createFollowUp(
  overrides: Pick<TablesInsert<'follow_ups'>, 'lead_id' | 'user_id'> & Partial<TablesInsert<'follow_ups'>>,
): Promise<FollowUp> {
  const row: TablesInsert<'follow_ups'> = {
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
    note: 'Fixture follow-up',
    ...overrides,
  };
  const { data, error } = await serviceClient().from('follow_ups').insert(row).select('*').single();
  if (error || !data) fail('createFollowUp', error);
  return data;
}

export async function createPhoneNumber(overrides: Partial<TablesInsert<'phone_numbers'>> = {}): Promise<PhoneNumber> {
  for (let attempt = 1; ; attempt += 1) {
    const row: TablesInsert<'phone_numbers'> = {
      e164: fictionalPhone(),
      twilio_sid: fakeTwilioSid('PN'),
      label: `Fixture ${nextSuffix()}`,
      active: true,
      assigned_to: null,
      ...overrides,
    };
    const { data, error } = await serviceClient().from('phone_numbers').insert(row).select('*').single();
    if (!error && data) return data;
    // A persistent external stack may still hold a number from an earlier run.
    if (error?.code === '23505' && overrides.e164 === undefined && attempt < 5) continue;
    fail('createPhoneNumber', error);
  }
}
