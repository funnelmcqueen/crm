// Admin phone number rows and reports (migration 20260915001100): admin-only access, exact numbers under the
// shared stat definitions, range boundaries in the admin's timezone, attribution after reassignment,
// totals equal to the per-agent sums, and invalid ranges.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOfDayInTz, startOfDayInTz } from '@/lib/domain/time';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', tokyoAdmin: '', idleAdmin: '', disabledAdmin: '', agent: '', disabledAgent: '' };

const NUMERIC_KEYS = new Set(['connect_rate', 'avg_call_seconds', 'answer_rate']);

/** PGlite returns numeric as strings and may return bigint as bigint. */
function norm<T extends object>(row: T): T {
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : NUMERIC_KEYS.has(key) && value !== null ? Number(value) : value,
    ]),
  ) as T;
}

interface AgentRow {
  user_id: string;
  name: string;
  active: boolean;
  dials: number;
  connected: number;
  connect_rate: number;
  talk_seconds: number;
  avg_call_seconds: number;
  interested: number;
  appointments: number;
  clients: number;
}

interface NumberRow {
  phone_number_id: string;
  e164: string;
  label: string | null;
  active: boolean;
  dials: number;
  answered: number;
  answer_rate: number;
}

interface Totals {
  agents: number;
  dials: number;
  connected: number;
  connect_rate: number;
  talk_seconds: number;
  avg_call_seconds: number;
  interested: number;
  appointments: number;
  clients: number;
}

async function reportAgents(userId: string, from: string, to: string): Promise<AgentRow[]> {
  const rows = await userRows<AgentRow>(db, userId, 'select * from public.admin_report_agents($1::timestamptz, $2::timestamptz)', [from, to]);
  return rows.map(norm);
}

async function reportNumbers(userId: string, from: string, to: string): Promise<NumberRow[]> {
  const rows = await userRows<NumberRow>(db, userId, 'select * from public.admin_report_numbers($1::timestamptz, $2::timestamptz)', [from, to]);
  return rows.map(norm);
}

async function reportTotals(userId: string, from: string, to: string): Promise<Totals> {
  const [row] = await userRows<{ t: Totals }>(db, userId, 'select public.admin_report_totals($1::timestamptz, $2::timestamptz) as t', [from, to]);
  return row.t;
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Report Admin', timezone: 'America/New_York' });
  u.tokyoAdmin = await createAuthUser(db, { role: 'ADMIN', name: 'Tokyo Admin', timezone: 'Pacific/Kiritimati' });
  u.idleAdmin = await createAuthUser(db, { role: 'ADMIN', name: 'Idle Admin' });
  u.disabledAdmin = await createAuthUser(db, { role: 'ADMIN', name: 'Disabled Admin', active: false });
  u.agent = await createAuthUser(db, { name: 'Plain Agent' });
  u.disabledAgent = await createAuthUser(db, { name: 'Disabled Agent', active: false });
});

afterAll(async () => {
  await db?.close();
});

const DAY_FROM = '2026-01-10T05:00:00Z';
const DAY_TO = '2026-01-11T05:00:00Z';

describe('admin-only access', () => {
  const calls = [
    { sql: 'select * from public.admin_phone_number_rows()', params: [] as unknown[] },
    { sql: 'select * from public.admin_report_agents($1::timestamptz, $2::timestamptz)', params: [DAY_FROM, DAY_TO] },
    { sql: 'select * from public.admin_report_numbers($1::timestamptz, $2::timestamptz)', params: [DAY_FROM, DAY_TO] },
    { sql: 'select public.admin_report_totals($1::timestamptz, $2::timestamptz)', params: [DAY_FROM, DAY_TO] },
  ];

  it.each(calls)('agents, disabled users, anon and service_role get 42501: $sql', async ({ sql, params }) => {
    for (const userId of [u.agent, u.disabledAgent, u.disabledAdmin]) {
      expect((await pgError(userRows(db, userId, sql, params))).code).toBe('42501');
    }
    expect((await pgError(anonRows(db, sql, params))).code).toBe('42501');
    expect((await pgError(serviceRows(db, sql, params))).code).toBe('42501');
  });

  it('checks the role before validating the range', async () => {
    const err = await pgError(
      userRows(db, u.agent, 'select * from public.admin_report_agents($1::timestamptz, $2::timestamptz)', [DAY_TO, DAY_FROM]),
    );
    expect(err.code).toBe('42501');
  });

  it('are SECURITY DEFINER with an empty search_path, executable by authenticated but not anon or PUBLIC', async () => {
    const rows = await adminSqlRows<{ proname: string; secdef: boolean; config: string[]; anon: boolean; auth: boolean; pub: boolean }>(
      db,
      `select p.proname, p.prosecdef as secdef, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('admin_phone_number_rows', 'admin_report_agents', 'admin_report_numbers', 'admin_report_totals')
        order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      'admin_phone_number_rows',
      'admin_report_agents',
      'admin_report_numbers',
      'admin_report_totals',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ secdef: true, config: ['search_path=""'], anon: false, auth: true, pub: false });
    }
  });
});

describe('admin_phone_number_rows', () => {
  interface PhoneRow {
    id: string;
    e164: string;
    label: string | null;
    twilio_sid: string;
    active: boolean;
    assigned_to: string | null;
    assigned_name: string | null;
    calls_today: number;
    last_used_at: Date | null;
    created_at: Date;
  }

  const rowsFor = async (userId: string) =>
    (await userRows<PhoneRow>(db, userId, 'select * from public.admin_phone_number_rows()')).map((r) => norm(r));

  it('lists every number with its agent (or pool), active flag and last use', async () => {
    const owner = await createAuthUser(db, { name: 'Number Owner' });
    const lastUsed = new Date('2026-09-01T12:00:00Z');
    const assigned = await createPhoneNumberRow(db, { assigned_to: owner, label: 'Owner line', last_used_at: lastUsed });
    const pool = await createPhoneNumberRow(db, { label: null, active: false });

    const rows = await rowsFor(u.admin);
    expect(rows.find((r) => r.id === assigned.id)).toMatchObject({
      e164: assigned.e164,
      label: 'Owner line',
      active: true,
      assigned_to: owner,
      assigned_name: 'Number Owner',
      calls_today: 0,
    });
    expect(rows.find((r) => r.id === assigned.id)?.last_used_at?.toISOString()).toBe(lastUsed.toISOString());
    expect(rows.find((r) => r.id === pool.id)).toMatchObject({ active: false, assigned_to: null, assigned_name: null, label: null });
  });

  it("counts calls in both directions since midnight in the calling admin's timezone", async () => {
    const agent = await createAuthUser(db, { name: 'Today Agent' });
    const lead = await createLeadRow(db, { assigned_to: agent });
    const number = await createPhoneNumberRow(db, { assigned_to: agent });
    const now = Date.now();
    const nyStart = startOfDayInTz('America/New_York', now).getTime();
    const nyEnd = endOfDayInTz('America/New_York', now).getTime();
    const kiStart = startOfDayInTz('Pacific/Kiritimati', now).getTime();
    const kiEnd = endOfDayInTz('Pacific/Kiritimati', now).getTime();

    const instants = [
      nyStart - 1000,
      nyStart,
      nyStart + 1000,
      nyEnd - 1000,
      nyEnd,
      kiStart - 1000,
      kiStart,
      kiEnd - 1000,
      kiEnd,
      now,
    ];
    for (const [index, time] of instants.entries()) {
      await createCallRow(db, {
        lead_id: lead.id,
        user_id: agent,
        phone_number_id: number.id,
        direction: index % 2 === 0 ? 'OUTBOUND' : 'INBOUND',
        mode: 'TEL',
        outcome: 'CONNECTED',
        created_at: new Date(time),
      });
    }
    // A call on another number never counts here.
    const other = await createPhoneNumberRow(db);
    await createCallRow(db, { lead_id: lead.id, user_id: agent, phone_number_id: other.id, created_at: new Date(now) });

    const within = (start: number, end: number) => instants.filter((t) => t >= start && t < end);
    const expected = (start: number, end: number) => within(start, end).length;
    expect((await rowsFor(u.admin)).find((r) => r.id === number.id)?.calls_today).toBe(expected(nyStart, nyEnd));
    expect((await rowsFor(u.tokyoAdmin)).find((r) => r.id === number.id)?.calls_today).toBe(expected(kiStart, kiEnd));
    // The two days must really select different calls, or the two assertions above would also pass for
    // a function that ignored the caller's timezone entirely. Compare the selected *sets*, not their
    // sizes: the windows are 24h offset by 18h, so they overlap by 6h and their counts coincide for six
    // hours out of every twenty-four (measured: 48 of 192 quarter-hours across a 48h sweep). Comparing
    // counts therefore failed this test whenever the suite happened to run inside that window, which is
    // also why equal counts would not have proved the rows were the same anyway.
    expect(within(nyStart, nyEnd)).not.toEqual(within(kiStart, kiEnd));
  });
});

describe('reports on one New York day with a DST change (2026-03-08, 23 hours)', () => {
  // Local midnight to local midnight in America/New_York.
  const FROM = '2026-03-08T05:00:00Z';
  const TO = '2026-03-09T04:00:00Z';
  const r = { a: '', b: '', admin: '', disabled: '', nR: '', nS: '', nOff: '' };

  beforeAll(async () => {
    r.a = await createAuthUser(db, { name: 'Range Alpha', timezone: 'America/Chicago' });
    r.b = await createAuthUser(db, { name: 'Range Bravo', timezone: 'America/Los_Angeles' });
    r.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Range Admin' });
    r.disabled = await createAuthUser(db, { name: 'Range Disabled', active: false });

    const leadA = await createLeadRow(db, { assigned_to: r.a });
    const leadB = await createLeadRow(db, { assigned_to: r.b });
    await createLeadRow(db, { assigned_to: r.a, status: 'CLIENT' });
    await createLeadRow(db, { assigned_to: r.a, status: 'APPOINTMENT' });

    const nR = await createPhoneNumberRow(db, { label: 'Rotation', assigned_to: r.a });
    const nS = await createPhoneNumberRow(db, { label: 'Silent' });
    const nOff = await createPhoneNumberRow(db, { label: 'Off', active: false });
    r.nR = nR.id;
    r.nS = nS.id;
    r.nOff = nOff.id;

    const at = (iso: string) => new Date(iso);
    const inApp = (values: Record<string, string | number | Date | null>) => ({
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      ...values,
    });
    const base = { lead_id: leadA.id, user_id: r.a };

    // 1. before the range
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 100, created_at: at('2026-03-08T04:59:59Z') }));
    // 2. first instant: TEL dial, no answer
    await createCallRow(db, { ...base, outcome: 'NO_ANSWER', created_at: at('2026-03-08T05:00:00Z') });
    // 3. in-app dial not logged yet (provider sid), answered on the number
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', duration_seconds: 60, created_at: at('2026-03-08T06:00:00Z') }));
    // 4. interested, answered
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', outcome: 'INTERESTED', duration_seconds: 120, created_at: at('2026-03-08T07:00:00Z') }));
    // 5. TEL appointment
    await createCallRow(db, { ...base, outcome: 'APPOINTMENT', duration_seconds: 30, created_at: at('2026-03-08T08:00:00Z') });
    // 6. pre-created in-app row that never reached Twilio: not a dial
    await createCallRow(db, { ...base, mode: 'IN_APP', phone_number_id: nR.id, created_at: at('2026-03-08T09:00:00Z') });
    // 7. inbound connected: talk time and connected, not a dial
    await createCallRow(db, { ...base, direction: 'INBOUND', mode: 'IN_APP', phone_number_id: nR.id, call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 45, created_at: at('2026-03-08T10:00:00Z') });
    // 8. wrong number, zero duration: dial on the number, not answered
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', outcome: 'WRONG_NUMBER', duration_seconds: 0, created_at: at('2026-03-08T11:00:00Z') }));
    // 9. last second of the local day: voicemail, answered by the machine
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', outcome: 'VOICEMAIL', duration_seconds: 20, created_at: at('2026-03-09T03:59:59Z') }));
    // 10. next local midnight: excluded
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'completed', outcome: 'CONNECTED', duration_seconds: 500, created_at: at('2026-03-09T04:00:00Z') }));
    // 11. busy on the number: dial, not answered
    await createCallRow(db, inApp({ ...base, phone_number_id: nR.id, call_status: 'busy', outcome: 'NO_ANSWER', duration_seconds: 0, created_at: at('2026-03-08T12:30:00Z') }));

    // Bravo: one connected call on their own lead.
    await createCallRow(db, { lead_id: leadB.id, user_id: r.b, outcome: 'CONNECTED', duration_seconds: 90, created_at: at('2026-03-08T12:00:00Z') });
    // An admin dialing Bravo's lead: the admin gets a row because they have calls in range.
    await createCallRow(db, { lead_id: leadB.id, user_id: r.admin, outcome: 'NO_ANSWER', created_at: at('2026-03-08T13:00:00Z') });
    // Admin-only unmatched voicemail (user_id null): in nobody's stats.
    await createCallRow(db, { lead_id: null, user_id: null, direction: 'INBOUND', mode: 'IN_APP', duration_seconds: 33, created_at: at('2026-03-08T14:00:00Z') });

    // Reassign Alpha's called lead to Bravo and make it a client: calls stay with Alpha, the client counts for Bravo.
    await db.query(`update public.leads set assigned_to = $1, status = 'CLIENT' where id = $2`, [r.b, leadA.id]);
  });

  const alpha = {
    dials: 7,
    connected: 3,
    connect_rate: 0.4286,
    talk_seconds: 275,
    avg_call_seconds: 55,
    interested: 1,
    appointments: 1,
    clients: 1,
  };

  it('computes exact per-agent numbers with half-open local-midnight bounds, attributed to calls.user_id', async () => {
    const rows = await reportAgents(u.admin, FROM, TO);
    expect(rows.find((row) => row.user_id === r.a)).toEqual({ user_id: r.a, name: 'Range Alpha', active: true, ...alpha });
    expect(rows.find((row) => row.user_id === r.b)).toEqual({
      user_id: r.b,
      name: 'Range Bravo',
      active: true,
      dials: 1,
      connected: 1,
      connect_rate: 1,
      talk_seconds: 90,
      avg_call_seconds: 90,
      interested: 0,
      appointments: 0,
      clients: 1,
    });
    expect(rows.find((row) => row.user_id === r.admin)).toEqual({
      user_id: r.admin,
      name: 'Range Admin',
      active: true,
      dials: 1,
      connected: 0,
      connect_rate: 0,
      talk_seconds: 0,
      avg_call_seconds: 0,
      interested: 0,
      appointments: 0,
      clients: 0,
    });
  });

  it('lists every agent (disabled ones too) with zeros, and admins only when they made calls in range', async () => {
    const rows = await reportAgents(u.admin, FROM, TO);
    expect(rows.find((row) => row.user_id === r.disabled)).toMatchObject({ active: false, dials: 0, talk_seconds: 0, clients: 0 });
    expect(rows.find((row) => row.user_id === u.agent)).toMatchObject({ dials: 0 });
    expect(rows.some((row) => row.user_id === u.idleAdmin)).toBe(false);
    expect(rows.some((row) => row.user_id === u.admin)).toBe(false);
    expect(rows.some((row) => row.user_id === null)).toBe(false);
  });

  it('moves the boundary calls into the neighbouring days', async () => {
    const before = (await reportAgents(u.admin, '2026-03-07T05:00:00Z', FROM)).find((row) => row.user_id === r.a);
    expect(before).toMatchObject({ dials: 1, connected: 1, talk_seconds: 100, avg_call_seconds: 100 });
    const after = (await reportAgents(u.admin, TO, '2026-03-10T04:00:00Z')).find((row) => row.user_id === r.a);
    expect(after).toMatchObject({ dials: 1, connected: 1, talk_seconds: 500 });
    // One second narrower on each side drops calls 2 and 9.
    const narrow = (await reportAgents(u.admin, '2026-03-08T05:00:01Z', '2026-03-09T03:59:59Z')).find((row) => row.user_id === r.a);
    expect(narrow).toMatchObject({ dials: 5, connected: 3, talk_seconds: 255 });
  });

  it('does not change when a lead is reassigned again', async () => {
    const lead = await adminSqlRows<{ id: string }>(db, `select id from public.leads where assigned_to = $1 and status = 'CLIENT' limit 1`, [r.b]);
    await db.query('update public.leads set assigned_to = $1 where id = $2', [r.disabled, lead[0].id]);
    try {
      const rows = await reportAgents(u.admin, FROM, TO);
      expect(rows.find((row) => row.user_id === r.a)).toMatchObject({ dials: 7, talk_seconds: 275 });
      expect(rows.find((row) => row.user_id === r.b)).toMatchObject({ dials: 1, clients: 0 });
      expect(rows.find((row) => row.user_id === r.disabled)).toMatchObject({ dials: 0, clients: 1 });
    } finally {
      await db.query('update public.leads set assigned_to = $1 where id = $2', [r.b, lead[0].id]);
    }
  });

  it('computes per-number dials, answered and answer rate', async () => {
    const rows = await reportNumbers(u.admin, FROM, TO);
    // nR dials: 3, 4, 8, 9, 11. Answered (completed with duration): 3, 4, 9.
    expect(rows.find((row) => row.phone_number_id === r.nR)).toMatchObject({ label: 'Rotation', active: true, dials: 5, answered: 3, answer_rate: 0.6 });
    expect(rows.find((row) => row.phone_number_id === r.nS)).toMatchObject({ dials: 0, answered: 0, answer_rate: 0 });
    expect(rows.find((row) => row.phone_number_id === r.nOff)).toMatchObject({ active: false, dials: 0 });
  });

  it('team totals equal the sums of the per-agent rows, with rates recomputed from the sums', async () => {
    const rows = await reportAgents(u.admin, FROM, TO);
    const totals = await reportTotals(u.admin, FROM, TO);
    const sum = (key: keyof AgentRow) => rows.reduce((acc, row) => acc + Number(row[key]), 0);
    expect(totals).toMatchObject({
      agents: rows.length,
      dials: sum('dials'),
      connected: sum('connected'),
      talk_seconds: sum('talk_seconds'),
      interested: sum('interested'),
      appointments: sum('appointments'),
      clients: sum('clients'),
    });
    // Only this block's fixtures have calls on this day.
    expect(totals).toMatchObject({ dials: 9, connected: 4, connect_rate: 0.4444, talk_seconds: 365, interested: 1, appointments: 1 });
    // 365 talk seconds over 6 timed calls (5 of Alpha's, 1 of Bravo's).
    expect(totals.avg_call_seconds).toBe(60.83);
  });

  it('returns zeros, not errors, for an empty range', async () => {
    const rows = await reportAgents(u.admin, '2001-01-01T05:00:00Z', '2001-01-02T05:00:00Z');
    expect(rows.every((row) => row.dials === 0 && row.connected === 0 && row.talk_seconds === 0)).toBe(true);
    const numbers = await reportNumbers(u.admin, '2001-01-01T05:00:00Z', '2001-01-02T05:00:00Z');
    expect(numbers.every((row) => row.dials === 0 && row.answer_rate === 0)).toBe(true);
    const totals = await reportTotals(u.admin, '2001-01-01T05:00:00Z', '2001-01-02T05:00:00Z');
    expect(totals).toMatchObject({ dials: 0, connected: 0, connect_rate: 0, talk_seconds: 0, avg_call_seconds: 0 });
  });
});

describe('range validation', () => {
  const fns = [
    (from: string | null, to: string | null) => reportAgents(u.admin, from as string, to as string),
    (from: string | null, to: string | null) => reportNumbers(u.admin, from as string, to as string),
    (from: string | null, to: string | null) => reportTotals(u.admin, from as string, to as string),
  ];

  it.each(fns.map((fn, index) => ({ fn, index })))('rejects empty, reversed, null and over-366-day ranges with 22023 (#$index)', async ({ fn }) => {
    const cases: Array<[string | null, string | null]> = [
      ['2026-03-08T05:00:00Z', '2026-03-08T05:00:00Z'],
      ['2026-03-09T05:00:00Z', '2026-03-08T05:00:00Z'],
      [null, '2026-03-08T05:00:00Z'],
      ['2026-03-08T05:00:00Z', null],
      ['2025-01-01T00:00:00Z', '2026-01-02T01:00:01Z'],
    ];
    for (const [from, to] of cases) {
      expect((await pgError(fn(from, to))).code, `${from} .. ${to}`).toBe('22023');
    }
  });

  it('accepts 366 days plus one hour of DST slack', async () => {
    await expect(reportAgents(u.admin, '2025-01-01T00:00:00Z', '2026-01-02T01:00:00Z')).resolves.toBeInstanceOf(Array);
    await expect(reportNumbers(u.admin, '2024-01-01T05:00:00Z', '2025-01-01T05:00:00Z')).resolves.toBeInstanceOf(Array);
    await expect(reportTotals(u.admin, '2024-01-01T05:00:00Z', '2025-01-01T05:00:00Z')).resolves.toMatchObject({ dials: 0 });
  });
});
