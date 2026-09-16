// admin_agent_activity (migration 20260915001000_admin_agents.sql): admin only, stats attributed to
// calls.user_id with the shared stat definitions, half-open [p_from, p_to) range.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createLeadRow,
  fakeTwilioSid,
  insertRow,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

interface Activity {
  profile: Record<string, unknown>;
  stats: {
    dials: number;
    connected: number;
    interested: number;
    appointments: number;
    talk_seconds: number;
    calls_with_duration: number;
    inbound_calls: number;
    total_calls: number;
  };
  outcomes: Record<string, number>;
  recent_calls: Array<Record<string, unknown>>;
}

let db: PGlite;
const u = { admin: '', agentA: '', agentB: '', disabledAdmin: '' };
const T0 = new Date('2026-09-10T12:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

async function activity(userId: string, from: string, to: string, caller = u.admin): Promise<Activity> {
  const [row] = await userRows<{ j: Activity }>(
    db,
    caller,
    `select public.admin_agent_activity($1::uuid, $2::timestamptz, $3::timestamptz) as j`,
    [userId, from, to],
  );
  return row.j;
}

async function call(values: Record<string, string | number | null>) {
  return insertRow(db, 'calls', { direction: 'OUTBOUND', mode: 'TEL', ...values });
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Drill Admin' });
  u.agentA = await createAuthUser(db, { name: 'Agent A', timezone: 'America/Chicago', dailyCallTarget: 70 });
  u.agentB = await createAuthUser(db, { name: 'Agent B' });
  u.disabledAdmin = await createAuthUser(db, { role: 'ADMIN', active: false });

  // A's lead, later reassigned to B: A's calls on it stay A's.
  const reassigned = await createLeadRow(db, { assigned_to: u.agentA, business_name: 'Moved Roofing' });
  const aLead = await createLeadRow(db, { assigned_to: u.agentA, status: 'CLIENT', business_name: 'A Client Co' });
  await createLeadRow(db, { assigned_to: u.agentA, status: 'CLIENT' });
  await createLeadRow(db, { assigned_to: u.agentA, status: 'NEW' });

  // Inside [T0, T0 + 60m): A's calls.
  await call({ lead_id: aLead.id, user_id: u.agentA, outcome: 'INTERESTED', duration_seconds: 120, created_at: at(0) });
  await call({ lead_id: aLead.id, user_id: u.agentA, outcome: 'APPOINTMENT', duration_seconds: 300, created_at: at(5) });
  await call({ lead_id: aLead.id, user_id: u.agentA, outcome: 'NO_ANSWER', duration_seconds: 0, created_at: at(10) });
  await call({ lead_id: aLead.id, user_id: u.agentA, outcome: 'WRONG_NUMBER', created_at: at(15) });
  await call({ lead_id: reassigned.id, user_id: u.agentA, outcome: 'CONNECTED', duration_seconds: 60, created_at: at(20) });
  // In-app call placed with Twilio but never logged: a dial, not connected.
  await call({
    lead_id: aLead.id,
    user_id: u.agentA,
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    call_status: 'no-answer',
    created_at: at(25),
  });
  // Pre-created in-app row that never reached Twilio: not a dial.
  await call({ lead_id: aLead.id, user_id: u.agentA, mode: 'IN_APP', created_at: at(30) });
  // Answered inbound callback: talk time and inbound count, not a dial.
  await call({
    lead_id: aLead.id,
    user_id: u.agentA,
    direction: 'INBOUND',
    mode: 'IN_APP',
    outcome: 'INTERESTED',
    duration_seconds: 45,
    created_at: at(35),
  });
  // Exactly at p_to: excluded. One millisecond before p_from: excluded.
  await call({ lead_id: aLead.id, user_id: u.agentA, outcome: 'CONNECTED', duration_seconds: 999, created_at: at(60) });
  await call({
    lead_id: aLead.id,
    user_id: u.agentA,
    outcome: 'CONNECTED',
    duration_seconds: 999,
    created_at: new Date(T0.getTime() - 1).toISOString(),
  });

  await adminSqlRows(db, `update public.leads set assigned_to = $1 where id = $2`, [u.agentB, reassigned.id]);
  // B's call on the reassigned lead is B's, never A's.
  await call({ lead_id: reassigned.id, user_id: u.agentB, outcome: 'APPOINTMENT', duration_seconds: 500, created_at: at(40) });
});

afterAll(async () => {
  await db?.close();
});

describe('admin_agent_activity', () => {
  it('computes the shared stat definitions over the caller-chosen half-open range', async () => {
    const result = await activity(u.agentA, at(0), at(60));
    expect(result.stats).toEqual({
      dials: 6,
      connected: 4,
      interested: 2,
      appointments: 1,
      talk_seconds: 525,
      calls_with_duration: 4,
      inbound_calls: 1,
      total_calls: 8,
    });
    expect(result.outcomes).toEqual({ INTERESTED: 2, APPOINTMENT: 1, NO_ANSWER: 1, WRONG_NUMBER: 1, CONNECTED: 1 });
  });

  it('returns the profile summary with currently assigned leads and clients', async () => {
    const result = await activity(u.agentA, at(0), at(60));
    expect(result.profile).toMatchObject({
      user_id: u.agentA,
      name: 'Agent A',
      role: 'AGENT',
      active: true,
      timezone: 'America/Chicago',
      daily_call_target: 70,
      leads_assigned: 3,
      clients: 2,
    });
  });

  it('attributes calls to calls.user_id even after the lead was reassigned', async () => {
    const a = await activity(u.agentA, at(0), at(60));
    const moved = a.recent_calls.filter((c) => c.business_name === 'Moved Roofing');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ outcome: 'CONNECTED', duration_seconds: 60 });

    const b = await activity(u.agentB, at(0), at(60));
    expect(b.stats).toMatchObject({ dials: 1, connected: 1, appointments: 1, talk_seconds: 500, total_calls: 1 });
    expect(b.recent_calls.map((c) => c.business_name)).toEqual(['Moved Roofing']);
    expect(b.profile).toMatchObject({ leads_assigned: 1, clients: 0 });
  });

  it('includes the start instant and excludes the end instant', async () => {
    const edge = await activity(u.agentA, at(60), at(61));
    expect(edge.stats.total_calls).toBe(1);
    const before = await activity(u.agentA, new Date(T0.getTime() - 1).toISOString(), at(0));
    expect(before.stats.total_calls).toBe(1);
    const empty = await activity(u.agentA, at(61), at(120));
    expect(empty.stats).toMatchObject({ dials: 0, connected: 0, talk_seconds: 0, total_calls: 0 });
    expect(empty.outcomes).toEqual({});
    expect(empty.recent_calls).toEqual([]);
  });

  it('lists recent calls newest first with lead business names', async () => {
    const result = await activity(u.agentA, at(0), at(60));
    const times = result.recent_calls.map((c) => Date.parse(String(c.created_at)));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(result.recent_calls[0]).toMatchObject({ direction: 'INBOUND', mode: 'IN_APP', outcome: 'INTERESTED', business_name: 'A Client Co' });
    expect(Object.keys(result.recent_calls[0]).sort()).toEqual(
      ['business_name', 'call_status', 'created_at', 'direction', 'duration_seconds', 'id', 'lead_id', 'mode', 'outcome'].sort(),
    );
  });

  it('caps recent calls at 50', async () => {
    const lead = await createLeadRow(db, { assigned_to: u.agentB });
    for (let i = 0; i < 55; i += 1) {
      await call({ lead_id: lead.id, user_id: u.agentB, outcome: 'NO_ANSWER', created_at: at(200 + i) });
    }
    const result = await activity(u.agentB, at(200), at(300));
    expect(result.stats.total_calls).toBe(55);
    expect(result.recent_calls).toHaveLength(50);
  });

  it('is admin only: agents (even about themselves) and disabled admins get 42501', async () => {
    for (const caller of [u.agentA, u.agentB, u.disabledAdmin]) {
      const err = await pgError(
        userRows(db, caller, `select public.admin_agent_activity($1::uuid, $2::timestamptz, $3::timestamptz)`, [u.agentA, at(0), at(60)]),
      );
      expect(err.code).toBe('42501');
    }
  });

  it('refuses anon and service_role callers', async () => {
    expect(
      (await pgError(anonRows(db, `select public.admin_agent_activity($1::uuid, now() - interval '1 day', now())`, [u.agentA]))).code,
    ).toBe('42501');
    expect(
      (await pgError(serviceRows(db, `select public.admin_agent_activity($1::uuid, now() - interval '1 day', now())`, [u.agentA]))).code,
    ).toBe('42501');
  });

  it('an unknown user is not_found (P0002) and invalid ranges are 22023', async () => {
    const sql = `select public.admin_agent_activity($1::uuid, $2::timestamptz, $3::timestamptz)`;
    expect((await pgError(userRows(db, u.admin, sql, ['00000000-0000-4000-8000-000000000000', at(0), at(60)]))).code).toBe('P0002');
    expect((await pgError(userRows(db, u.admin, sql, [u.agentA, at(60), at(0)]))).code).toBe('22023');
    expect((await pgError(userRows(db, u.admin, sql, [u.agentA, at(0), at(0)]))).code).toBe('22023');
    expect((await pgError(userRows(db, u.admin, sql, [u.agentA, null, at(0)]))).code).toBe('22023');
    expect(
      (await pgError(userRows(db, u.admin, sql, [u.agentA, '2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z']))).code,
    ).toBe('22023');
  });

  it('is SECURITY DEFINER with an empty search_path and no anon grant', async () => {
    const [fn] = await adminSqlRows<{ definer: boolean; config: string[]; anon: boolean; auth: boolean }>(
      db,
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
         from pg_proc p where p.proname = 'admin_agent_activity'`,
    );
    expect(fn).toEqual({ definer: true, config: ['search_path=""'], anon: false, auth: true });
  });
});
