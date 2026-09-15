// npm run db:seed: dev/test data through the Supabase Auth admin API and service-role table
// writes only (no raw SQL), so it behaves the same on localbase and on a real Supabase stack.
import { TZDate } from '@date-fns/tz';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from '../src/lib/domain/phone';
import { normalizeWebsiteDomain } from '../src/lib/domain/website';
import { isMainModule } from './lib/main-module';
import { mulberry32, randHex, randInt, type Rng } from './lib/prng';
import {
  COMPANY_NAME,
  DISABLED_BAN_DURATION,
  SEED_ADMIN_EMAIL,
  SEED_LEADS,
  SEED_PASSWORD,
  SEED_PHONE_NUMBERS,
  SEED_USERS,
  UNMATCHED_VOICEMAIL,
  callerNumberFor,
  leadE164,
  leadPhoneRaw,
  seedUser,
  validateSeedPlan,
  type AgentKey,
  type CallOutcome,
  type CallPlan,
  type FollowUpDue,
  type NumberKey,
  type SeedLead,
  type UserKey,
} from './lib/seed-data';

export const SEED_PRNG_SEED = 20260915;

export interface SeedOptions {
  url: string;
  serviceRoleKey: string;
  log?: (msg: string) => void;
  /** Reference time for all relative timestamps. Defaults to the current time. */
  now?: Date;
  /**
   * The seed creates accounts with a published password, including an ADMIN, so it refuses
   * any host other than localhost/127.0.0.1 unless this is true (CLI: SEED_ALLOW_REMOTE=1).
   */
  allowRemote?: boolean;
}

export interface SeedCounts {
  users: number;
  phoneNumbers: number;
  leads: number;
  calls: number;
  openFollowUps: number;
  completedFollowUps: number;
  voicemails: number;
}

export interface SeedSummary {
  /** True when admin@funnelmcqueen.test already existed and nothing was written. */
  alreadySeeded: boolean;
  /** Profile/auth user id by email, for every seed user found or created. */
  userIds: Record<string, string>;
  /** phone_numbers.id by e164. */
  phoneNumberIds: Record<string, string>;
  /** Rows written by this run; table totals when alreadySeeded. */
  counts: SeedCounts;
}

type Db = SupabaseClient;

type CallStatus = 'completed' | 'busy' | 'no-answer';

interface CallInsert {
  created_at: string;
  lead_id: string | null;
  user_id: string | null;
  direction: 'OUTBOUND' | 'INBOUND';
  mode: 'IN_APP' | 'TEL';
  phone_number_id: string | null;
  remote_e164: string;
  provider_call_sid: string | null;
  call_status: CallStatus | null;
  outcome: CallOutcome | null;
  notes: string | null;
  duration_seconds: number | null;
  voicemail_recording_sid: string | null;
  voicemail_duration_seconds: number | null;
  handled_at: string | null;
}

interface FollowUpInsert {
  lead_id: string;
  user_id: string;
  created_at: string;
  due_at: string;
  completed_at: string | null;
  note: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LEAD_CREATED_TIMEZONE = 'America/New_York';
const WRITE_CONCURRENCY = 6;

/** Talk time range per outcome, in seconds. */
const TALK_SECONDS: Record<CallOutcome, readonly [number, number]> = {
  NO_ANSWER: [0, 0],
  VOICEMAIL: [25, 55],
  WRONG_NUMBER: [25, 40],
  NOT_INTERESTED: [25, 150],
  FOLLOW_UP: [45, 240],
  CONNECTED: [60, 300],
  INTERESTED: [180, 600],
  APPOINTMENT: [300, 900],
};

export function isLocalSupabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

class SeedClock {
  readonly nowMs: number;

  constructor(now: Date) {
    this.nowMs = now.getTime();
  }

  /** Wall-clock time in `timeZone`, `dayOffset` days from today there (negative = past). */
  local(timeZone: string, dayOffset: number, hour: number, minute = 0): number {
    const today = new TZDate(this.nowMs, timeZone);
    return new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hour, minute, 0, 0, timeZone).getTime();
  }

  endOfToday(timeZone: string): number {
    return this.local(timeZone, 1, 0);
  }

  /**
   * Window for "earlier today" calls: business hours up to a few minutes ago when the day is
   * far enough along, otherwise midnight..now so the rows still land on today's dashboard.
   */
  todayWindow(timeZone: string): { start: number; end: number } {
    const midnight = this.local(timeZone, 0, 0);
    const businessStart = midnight + 9 * HOUR_MS;
    const end = this.nowMs - 5 * MINUTE_MS;
    if (end - businessStart >= 30 * MINUTE_MS) return { start: businessStart, end };
    return { start: midnight, end: Math.max(midnight, end > midnight ? end : this.nowMs) };
  }

  /** Time of a planned call: 0..1 across today's window, or across 09:00-17:30 local on a past day. */
  callTime(timeZone: string, day: number, at: number): number {
    if (day === 0) {
      const { start, end } = this.todayWindow(timeZone);
      return truncateToSecond(start + at * (end - start));
    }
    return truncateToSecond(this.local(timeZone, -day, 9) + at * 8.5 * HOUR_MS);
  }
}

function truncateToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fail(label: string, error: { message: string; code?: string }): never {
  throw new Error(`seed: ${label} failed: ${error.code ? `[${error.code}] ` : ''}${error.message}`);
}

async function insertRow(db: Db, table: string, row: object, label: string): Promise<string> {
  // One row per request: supabase-js adds a `columns=` query parameter to array inserts,
  // which is outside the localbase PostgREST subset.
  const { data, error } = await db.from(table).insert(row).select('id');
  if (error) fail(label, error);
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`seed: ${label} returned ${rows.length} rows`);
  return rows[0].id;
}

async function updateRows(db: Db, table: string, patch: object, column: string, value: string | boolean, label: string): Promise<void> {
  const { data, error } = await db.from(table).update(patch).eq(column, value).select('id');
  if (error) fail(label, error);
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`seed: ${label} matched ${rows.length} rows (expected 1; are the migrations applied?)`);
}

async function forEachLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function countRows(db: Db, table: string, filter?: 'open' | 'completed' | 'voicemail'): Promise<number> {
  let query = db.from(table).select('id', { count: 'exact', head: true });
  if (filter === 'open') query = query.is('completed_at', null);
  if (filter === 'completed') query = query.not('completed_at', 'is', null);
  if (filter === 'voicemail') query = query.not('voicemail_recording_sid', 'is', null);
  const { count, error } = await query;
  if (error) fail(`count ${table}`, error);
  return count ?? 0;
}

async function existingSummary(db: Db): Promise<SeedSummary> {
  const users = await db
    .from('profiles')
    .select('id, email')
    .in(
      'email',
      SEED_USERS.map((u) => u.email),
    );
  if (users.error) fail('read seed profiles', users.error);
  const numbers = await db
    .from('phone_numbers')
    .select('id, e164')
    .in(
      'e164',
      SEED_PHONE_NUMBERS.map((n) => n.e164),
    );
  if (numbers.error) fail('read seed phone numbers', numbers.error);

  const userIds: Record<string, string> = {};
  for (const row of (users.data ?? []) as Array<{ id: string; email: string }>) userIds[row.email] = row.id;
  const phoneNumberIds: Record<string, string> = {};
  for (const row of (numbers.data ?? []) as Array<{ id: string; e164: string }>) phoneNumberIds[row.e164] = row.id;

  return {
    alreadySeeded: true,
    userIds,
    phoneNumberIds,
    counts: {
      users: await countRows(db, 'profiles'),
      phoneNumbers: await countRows(db, 'phone_numbers'),
      leads: await countRows(db, 'leads'),
      calls: await countRows(db, 'calls'),
      openFollowUps: await countRows(db, 'follow_ups', 'open'),
      completedFollowUps: await countRows(db, 'follow_ups', 'completed'),
      voicemails: await countRows(db, 'calls', 'voicemail'),
    },
  };
}

function talkSeconds(rng: Rng, outcome: CallOutcome): number {
  const [min, max] = TALK_SECONDS[outcome];
  return randInt(rng, min, max);
}

function twilioSid(rng: Rng, prefix: 'PN' | 'CA' | 'RE'): string {
  return `${prefix}${randHex(rng, 32)}`;
}

interface PlannedCall {
  row: CallInsert;
  leadRef: string | null;
}

function buildCallRow(
  rng: Rng,
  clock: SeedClock,
  lead: SeedLead,
  call: CallPlan,
  ids: { leadId: string; users: Record<UserKey, string>; numbers: Record<NumberKey, string> },
): CallInsert {
  const owner = lead.owner;
  const caller: AgentKey | undefined = call.by ?? owner ?? undefined;
  if (!caller) throw new Error(`seed: ${lead.ref} has a call without a caller`);
  const direction = call.direction ?? 'OUTBOUND';
  const mode = call.mode ?? 'IN_APP';
  const timeZone = seedUser(caller).timezone;
  const at = call.at ?? 0.05 + rng() * 0.9;
  const createdAt = clock.callTime(timeZone, call.day, at);
  const remote = leadE164(lead);
  const number = ids.numbers[callerNumberFor(caller)];

  const base: CallInsert = {
    created_at: iso(createdAt),
    lead_id: ids.leadId,
    user_id: ids.users[caller],
    direction,
    mode,
    phone_number_id: null,
    remote_e164: remote,
    provider_call_sid: null,
    call_status: null,
    outcome: call.outcome,
    notes: call.notes ?? null,
    duration_seconds: null,
    voicemail_recording_sid: null,
    voicemail_duration_seconds: null,
    handled_at: null,
  };

  if (call.voicemailSeconds !== undefined) {
    return {
      ...base,
      phone_number_id: number,
      provider_call_sid: twilioSid(rng, 'CA'),
      call_status: 'completed',
      voicemail_recording_sid: twilioSid(rng, 'RE'),
      voicemail_duration_seconds: call.voicemailSeconds,
    };
  }

  const outcome = call.outcome;
  if (outcome === null) throw new Error(`seed: ${lead.ref} has an unlogged call that is not a voicemail`);

  if (mode === 'TEL') {
    // Tel calls have no Twilio leg; duration is whatever the agent typed, if anything.
    let duration: number | null = null;
    if (outcome === 'NO_ANSWER') duration = 0;
    else if (outcome !== 'VOICEMAIL' && outcome !== 'WRONG_NUMBER') duration = Math.max(60, Math.round(talkSeconds(rng, outcome) / 60) * 60);
    return { ...base, duration_seconds: duration };
  }

  let status: CallStatus = 'completed';
  if (outcome === 'NO_ANSWER') status = rng() < 0.25 ? 'busy' : 'no-answer';
  return {
    ...base,
    phone_number_id: number,
    provider_call_sid: twilioSid(rng, 'CA'),
    call_status: status,
    duration_seconds: talkSeconds(rng, outcome),
  };
}

function followUpTimes(clock: SeedClock, due: FollowUpDue, timeZone: string, callTimes: readonly number[]): { created: number; due: number; completed: number | null } {
  let dueMs: number;
  let completed: number | null = null;
  switch (due.kind) {
    case 'now':
      return { created: clock.nowMs, due: clock.nowMs, completed: null };
    case 'overdue':
      dueMs = clock.local(timeZone, -due.daysAgo, 10);
      break;
    case 'later-today': {
      const end = clock.endOfToday(timeZone);
      dueMs = truncateToSecond(clock.nowMs + due.fraction * (end - clock.nowMs));
      break;
    }
    case 'upcoming':
      dueMs = clock.local(timeZone, due.daysAhead, due.hour);
      break;
    case 'completed':
      dueMs = clock.local(timeZone, -due.daysAgo, 10);
      completed = dueMs + 5 * HOUR_MS;
      break;
  }
  const limit = Math.min(dueMs, clock.nowMs);
  const earlierCalls = callTimes.filter((t) => t <= limit);
  const created = earlierCalls.length > 0 ? Math.max(...earlierCalls) : limit - 2 * HOUR_MS;
  return { created, due: dueMs, completed };
}

export async function seed(opts: SeedOptions): Promise<SeedSummary> {
  const log = opts.log ?? (() => undefined);
  if (!opts.url || !opts.serviceRoleKey) throw new Error('seed: url and serviceRoleKey are required');
  if (!opts.allowRemote && !isLocalSupabaseUrl(opts.url)) {
    throw new Error('seed: refusing to seed a non-local Supabase URL (it creates accounts with a published password). Pass allowRemote / SEED_ALLOW_REMOTE=1 for a disposable project.');
  }

  const problems = validateSeedPlan();
  if (problems.length > 0) throw new Error(`seed: invalid seed plan:\n  ${problems.join('\n  ')}`);

  const db: Db = createClient(opts.url, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const existing = await db.from('profiles').select('id').eq('email', SEED_ADMIN_EMAIL).limit(1);
  if (existing.error) fail('check for existing admin', existing.error);
  if ((existing.data ?? []).length > 0) {
    log('already seeded');
    return existingSummary(db);
  }

  const clock = new SeedClock(opts.now ?? new Date());
  const rng = mulberry32(SEED_PRNG_SEED);

  // Normalize with the same helpers as CSV import so duplicate checks agree with seeded rows.
  // Done before any write so a mismatch leaves the database untouched.
  const normalizedLeads = SEED_LEADS.map((lead) => {
    const normalized = normalizePhone(leadPhoneRaw(lead), 'US');
    if (!normalized.ok || normalized.e164 !== leadE164(lead)) {
      throw new Error(`seed: normalizePhone gave an unexpected result for lead ${lead.ref}`);
    }
    const phone = normalized.e164;
    let websiteDomain: string | null = null;
    if (lead.website) {
      websiteDomain = normalizeWebsiteDomain(lead.website);
      if (!websiteDomain) throw new Error(`seed: normalizeWebsiteDomain returned nothing for lead ${lead.ref}`);
    }
    return { lead, phone, websiteDomain };
  });

  // Users. The on_auth_user_created trigger creates each profile; role and limits are set after.
  const users = {} as Record<UserKey, string>;
  const userIds: Record<string, string> = {};
  for (const user of SEED_USERS) {
    const { data, error } = await db.auth.admin.createUser({
      email: user.email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: { name: user.name },
    });
    if (error || !data.user) fail(`create user ${user.email}`, error ?? { message: 'no user returned' });
    users[user.key] = data.user.id;
    userIds[user.email] = data.user.id;
    await updateRows(
      db,
      'profiles',
      { name: user.name, role: user.role, timezone: user.timezone, daily_call_target: user.dailyCallTarget },
      'id',
      data.user.id,
      `update profile ${user.email}`,
    );
  }
  log(`created ${SEED_USERS.length} users`);

  await updateRows(db, 'settings', { company_name: COMPANY_NAME }, 'id', true, 'update settings');

  const numbers = {} as Record<NumberKey, string>;
  const phoneNumberIds: Record<string, string> = {};
  for (const phoneNumber of SEED_PHONE_NUMBERS) {
    const id = await insertRow(
      db,
      'phone_numbers',
      {
        e164: phoneNumber.e164,
        twilio_sid: twilioSid(rng, 'PN'),
        label: phoneNumber.label,
        active: true,
        assigned_to: phoneNumber.assignedTo ? users[phoneNumber.assignedTo] : null,
      },
      `insert phone number ${phoneNumber.label}`,
    );
    numbers[phoneNumber.key] = id;
    phoneNumberIds[phoneNumber.e164] = id;
  }
  log(`created ${SEED_PHONE_NUMBERS.length} phone numbers`);

  const leadIds = new Map<string, string>();
  for (const [index, { lead, phone, websiteDomain }] of normalizedLeads.entries()) {
    const id = await insertRow(
      db,
      'leads',
      {
        created_at: iso(clock.local(LEAD_CREATED_TIMEZONE, -lead.createdDaysAgo, 8, 30 + (index % 7) * 4)),
        business_name: lead.businessName,
        contact_name: lead.contactName,
        phone,
        phone_raw: leadPhoneRaw(lead),
        email: lead.email ?? null,
        website: lead.website ?? null,
        website_domain: websiteDomain,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        country: 'US',
        source: lead.source,
        status: lead.status,
        notes: lead.notes ?? null,
        assigned_to: lead.owner ? users[lead.owner] : null,
      },
      `insert lead ${lead.ref}`,
    );
    leadIds.set(lead.ref, id);
  }
  log(`created ${SEED_LEADS.length} leads`);

  const plannedCalls: PlannedCall[] = [];
  for (const lead of SEED_LEADS) {
    const leadId = leadIds.get(lead.ref);
    if (!leadId) throw new Error(`seed: missing id for ${lead.ref}`);
    for (const call of lead.calls ?? []) {
      plannedCalls.push({ leadRef: lead.ref, row: buildCallRow(rng, clock, lead, call, { leadId, users, numbers }) });
    }
  }
  plannedCalls.push({
    leadRef: null,
    row: {
      created_at: iso(clock.local(UNMATCHED_VOICEMAIL.timezone, -UNMATCHED_VOICEMAIL.daysAgo, UNMATCHED_VOICEMAIL.localHour, UNMATCHED_VOICEMAIL.localMinute)),
      lead_id: null,
      user_id: null,
      direction: 'INBOUND',
      mode: 'IN_APP',
      phone_number_id: numbers[UNMATCHED_VOICEMAIL.number],
      remote_e164: UNMATCHED_VOICEMAIL.remoteE164,
      provider_call_sid: twilioSid(rng, 'CA'),
      call_status: 'completed',
      outcome: null,
      notes: null,
      duration_seconds: null,
      voicemail_recording_sid: twilioSid(rng, 'RE'),
      voicemail_duration_seconds: UNMATCHED_VOICEMAIL.voicemailSeconds,
      handled_at: null,
    },
  });

  const futureCall = plannedCalls.find((c) => Date.parse(c.row.created_at) > clock.nowMs);
  if (futureCall) throw new Error(`seed: planned call for ${futureCall.leadRef ?? 'unmatched voicemail'} is in the future`);

  await forEachLimit(plannedCalls, WRITE_CONCURRENCY, async ({ row, leadRef }) => {
    await insertRow(db, 'calls', row, `insert call for ${leadRef ?? 'unmatched voicemail'}`);
  });
  log(`created ${plannedCalls.length} calls`);

  const followUps: Array<{ ref: string; row: FollowUpInsert }> = [];
  for (const lead of SEED_LEADS) {
    if (!lead.owner) continue;
    const leadId = leadIds.get(lead.ref);
    if (!leadId) throw new Error(`seed: missing id for ${lead.ref}`);
    const callTimes = plannedCalls.filter((c) => c.leadRef === lead.ref).map((c) => Date.parse(c.row.created_at));
    for (const followUp of lead.followUps ?? []) {
      const times = followUpTimes(clock, followUp.due, seedUser(lead.owner).timezone, callTimes);
      followUps.push({
        ref: lead.ref,
        row: {
          lead_id: leadId,
          user_id: users[lead.owner],
          created_at: iso(times.created),
          due_at: iso(times.due),
          completed_at: times.completed === null ? null : iso(times.completed),
          note: followUp.note,
        },
      });
    }
  }
  await forEachLimit(followUps, WRITE_CONCURRENCY, async ({ ref, row }) => {
    await insertRow(db, 'follow_ups', row, `insert follow-up for ${ref}`);
  });
  log(`created ${followUps.length} follow-ups`);

  // Mirror what log_call maintains: one count per logged call, last contact = latest logged call.
  const leadStats = new Map<string, { callCount: number; lastContactedAt: number }>();
  for (const { row, leadRef } of plannedCalls) {
    if (!leadRef || row.outcome === null) continue;
    const stats = leadStats.get(leadRef) ?? { callCount: 0, lastContactedAt: 0 };
    stats.callCount += 1;
    stats.lastContactedAt = Math.max(stats.lastContactedAt, Date.parse(row.created_at));
    leadStats.set(leadRef, stats);
  }
  await forEachLimit([...leadStats.entries()], WRITE_CONCURRENCY, async ([ref, stats]) => {
    const leadId = leadIds.get(ref);
    if (!leadId) throw new Error(`seed: missing id for ${ref}`);
    await updateRows(
      db,
      'leads',
      { call_count: stats.callCount, last_contacted_at: iso(stats.lastContactedAt) },
      'id',
      leadId,
      `update call stats for ${ref}`,
    );
  });

  for (const phoneNumber of SEED_PHONE_NUMBERS) {
    const id = numbers[phoneNumber.key];
    const used = plannedCalls
      .filter((c) => c.row.phone_number_id === id && c.row.direction === 'OUTBOUND')
      .map((c) => Date.parse(c.row.created_at));
    if (used.length === 0) continue;
    await updateRows(db, 'phone_numbers', { last_used_at: iso(Math.max(...used)) }, 'id', id, `update last_used_at for ${phoneNumber.label}`);
  }

  // Disable last so every row above could reference an active profile.
  for (const user of SEED_USERS.filter((u) => u.disabled)) {
    const id = users[user.key];
    await updateRows(db, 'profiles', { active: false }, 'id', id, `disable profile ${user.email}`);
    const { error } = await db.auth.admin.updateUserById(id, { ban_duration: DISABLED_BAN_DURATION });
    if (error) fail(`ban ${user.email}`, error);
  }
  log('disabled and banned inactive agents');

  return {
    alreadySeeded: false,
    userIds,
    phoneNumberIds,
    counts: {
      users: SEED_USERS.length,
      phoneNumbers: SEED_PHONE_NUMBERS.length,
      leads: SEED_LEADS.length,
      calls: plannedCalls.length,
      openFollowUps: followUps.filter((f) => f.row.completed_at === null).length,
      completedFollowUps: followUps.filter((f) => f.row.completed_at !== null).length,
      voicemails: plannedCalls.filter((c) => c.row.voicemail_recording_sid !== null).length,
    },
  };
}

export function formatSeedSummary(summary: SeedSummary): string {
  const c = summary.counts;
  const lines = [
    summary.alreadySeeded ? 'Database was already seeded; nothing changed. Current totals:' : 'Seed complete:',
    `  users ${c.users} · phone numbers ${c.phoneNumbers} · leads ${c.leads} · calls ${c.calls} · follow-ups ${c.openFollowUps} open / ${c.completedFollowUps} completed · voicemails ${c.voicemails}`,
    '',
    `Dev logins (password for all: ${SEED_PASSWORD})`,
  ];
  const table = [
    ['EMAIL', 'NAME', 'ROLE', 'TIMEZONE', 'TARGET', 'STATUS'],
    ...SEED_USERS.map((u) => [u.email, u.name, u.role, u.timezone, String(u.dailyCallTarget), u.disabled ? 'disabled (banned)' : 'active']),
  ];
  const widths = table[0].map((_, col) => Math.max(...table.map((row) => row[col].length)));
  for (const row of table) lines.push(`  ${row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local (npm run localbase prints the local values).');
    process.exitCode = 1;
    return;
  }
  const summary = await seed({
    url,
    serviceRoleKey,
    allowRemote: process.env.SEED_ALLOW_REMOTE === '1',
    log: (msg) => console.log(msg),
  });
  console.log(formatSeedSummary(summary));
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
