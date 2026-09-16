// Direct PGlite helpers for the `db` vitest project: raw SQL against the real migrations, executed
// as the Supabase API roles exactly like PostgREST does (SET LOCAL ROLE + request.jwt.claims).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { createDatabase } from '../../localbase/db';
import { createPhoneFactory, fakeTwilioSid } from './phones';

export type { PGlite, Transaction };

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

/** A fresh in-memory database with bootstrap.sql and every migration applied. */
export function bootDb(): Promise<PGlite> {
  return createDatabase({ migrationsDir: MIGRATIONS_DIR });
}

type ApiRole = 'anon' | 'authenticated' | 'service_role';

async function runAs<T>(
  db: PGlite,
  role: ApiRole,
  claims: Record<string, unknown>,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    return fn(tx);
  });
}

/** Runs fn in one transaction as `authenticated` with the user's JWT claims. Commits unless fn throws. */
export function asUser<T>(db: PGlite, userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return runAs(db, 'authenticated', { sub: userId, role: 'authenticated', aud: 'authenticated' }, fn);
}

export function asAnon<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return runAs(db, 'anon', { role: 'anon' }, fn);
}

export function asService<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return runAs(db, 'service_role', { role: 'service_role' }, fn);
}

/** Query rows as a user (one transaction per call). */
export async function userRows<T>(db: PGlite, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, userId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

export async function anonRows<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return asAnon(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

export async function serviceRows<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Query rows as postgres (superuser, bypasses RLS). For arranging data and checking results. */
export async function adminSqlRows<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export interface PgErrorInfo {
  code: string;
  message: string;
}

/** Awaits a promise that must reject with a Postgres error and returns its SQLSTATE and message. */
export async function pgError(promise: Promise<unknown>): Promise<PgErrorInfo> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code !== 'string') throw error;
    return { code: e.code, message: typeof e.message === 'string' ? e.message : '' };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

// ---------------------------------------------------------------------------------------------
// Arrange helpers (run as postgres)
// ---------------------------------------------------------------------------------------------

const phones = createPhoneFactory();
let sequence = 0;

export function nextPhone(): string {
  return phones.next();
}

export { fakeTwilioSid };

type SqlValue = string | number | boolean | null | Date | string[];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** INSERT ... RETURNING * as postgres. Identifiers come from test code and are validated. */
export async function insertRow<T = Record<string, unknown>>(
  db: PGlite,
  table: 'profiles' | 'leads' | 'calls' | 'follow_ups' | 'phone_numbers' | 'rate_limit_hits',
  values: Record<string, SqlValue | undefined>,
): Promise<T> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  for (const [column] of entries) {
    if (!IDENTIFIER.test(column)) throw new Error(`bad column name ${column}`);
  }
  const columns = entries.map(([column]) => `"${column}"`).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
  const sql =
    entries.length === 0
      ? `insert into public.${table} default values returning *`
      : `insert into public.${table} (${columns}) values (${placeholders}) returning *`;
  const { rows } = await db.query<T>(sql, entries.map(([, value]) => value));
  return rows[0];
}

export interface CreateAuthUserOptions {
  email?: string;
  name?: string;
  role?: 'ADMIN' | 'AGENT';
  active?: boolean;
  timezone?: string;
  inAppCallingEnabled?: boolean;
  dailyCallTarget?: number;
}

/**
 * Inserts an auth.users row (the on_auth_user_created trigger creates the profile), then applies
 * role/flags as postgres. Returns the user id.
 */
export async function createAuthUser(db: PGlite, options: CreateAuthUserOptions = {}): Promise<string> {
  const id = randomUUID();
  sequence += 1;
  const email = options.email ?? `user-${sequence}-${id.slice(0, 8)}@db.funnelmcqueen.test`;
  await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(),
             '{"provider":"email","providers":["email"]}'::jsonb, $3::jsonb, now(), now())`,
    [id, email, JSON.stringify(options.name === undefined ? {} : { name: options.name })],
  );
  await db.query(
    `update public.profiles
        set role = $2::public.user_role,
            active = $3,
            timezone = coalesce($4, timezone),
            in_app_calling_enabled = $5,
            daily_call_target = coalesce($6, daily_call_target)
      where id = $1`,
    [
      id,
      options.role ?? 'AGENT',
      options.active ?? true,
      options.timezone ?? null,
      options.inAppCallingEnabled ?? true,
      options.dailyCallTarget ?? null,
    ],
  );
  return id;
}

export interface LeadRow {
  id: string;
  created_at: string;
  business_name: string;
  phone: string;
  city: string | null;
  status: string;
  assigned_to: string | null;
  last_contacted_at: Date | null;
  next_follow_up_at: Date | null;
  call_count: number;
  notes: string | null;
  source: string | null;
  dedupe_name_key: string;
}

export function createLeadRow(db: PGlite, values: Record<string, SqlValue | undefined> = {}): Promise<LeadRow> {
  sequence += 1;
  return insertRow<LeadRow>(db, 'leads', {
    business_name: `Lead ${sequence}`,
    phone: nextPhone(),
    city: 'Testville',
    ...values,
  });
}

export interface CallRow {
  id: string;
  lead_id: string | null;
  user_id: string | null;
  outcome: string | null;
  notes: string | null;
  call_status: string | null;
  duration_seconds: number | null;
  provider_call_sid: string | null;
  voicemail_recording_sid: string | null;
  voicemail_duration_seconds: number | null;
  handled_at: Date | null;
  phone_number_id: string | null;
  direction: string;
  mode: string;
}

export function createCallRow(db: PGlite, values: Record<string, SqlValue | undefined>): Promise<CallRow> {
  return insertRow<CallRow>(db, 'calls', { direction: 'OUTBOUND', mode: 'TEL', ...values });
}

export interface FollowUpRow {
  id: string;
  lead_id: string;
  user_id: string;
  due_at: Date;
  completed_at: Date | null;
  note: string | null;
}

export function createFollowUpRow(db: PGlite, values: Record<string, SqlValue | undefined>): Promise<FollowUpRow> {
  return insertRow<FollowUpRow>(db, 'follow_ups', { due_at: new Date(Date.now() + 86_400_000), ...values });
}

export interface PhoneNumberRow {
  id: string;
  e164: string;
  active: boolean;
  assigned_to: string | null;
  last_used_at: Date | null;
}

export function createPhoneNumberRow(db: PGlite, values: Record<string, SqlValue | undefined> = {}): Promise<PhoneNumberRow> {
  return insertRow<PhoneNumberRow>(db, 'phone_numbers', {
    e164: nextPhone(),
    twilio_sid: fakeTwilioSid('PN'),
    ...values,
  });
}
