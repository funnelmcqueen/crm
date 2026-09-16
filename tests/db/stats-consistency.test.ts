// Stages 6-10 integration: every stats surface uses the same definitions, so the same agent and day give the
// same numbers on the agent dashboard (get_my_dashboard), the admin dashboard (admin_agent_rows), the agent
// drill-down (admin_agent_activity) and reports (admin_report_agents / admin_report_totals / admin_report_numbers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOfDayInTz, startOfDayInTz } from '@/lib/domain/time';
import {
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  userRows,
  type PGlite,
} from '../helpers/pglite';

const MINUTE = 60_000;

interface Stats {
  dials: number;
  connected: number;
  interested: number;
  appointments: number;
  talk_seconds: number;
}

let db: PGlite;
let admin = '';

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Consistency Admin', timezone: 'America/New_York' });
});

afterAll(async () => {
  await db?.close();
});

async function seedDay(tz: string, name: string) {
  const agent = await createAuthUser(db, { name, timezone: tz, dailyCallTarget: 10 });
  const other = await createAuthUser(db, { name: `${name} Other`, timezone: tz });
  const lead = (await createLeadRow(db, { assigned_to: agent, status: 'CLIENT' })).id;
  const movedLead = (await createLeadRow(db, { assigned_to: other })).id;
  const number = (await createPhoneNumberRow(db, { assigned_to: agent })).id;
  const start = startOfDayInTz(tz);
  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE);

  // Yesterday (local): excluded everywhere.
  await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'APPOINTMENT', duration_seconds: 500, created_at: at(-1) });
  // Logged TEL dial, connected + interested.
  await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'INTERESTED', duration_seconds: 90, created_at: at(1) });
  // In-app dial that reached Twilio and was answered but not logged yet.
  await createCallRow(db, {
    lead_id: lead,
    user_id: agent,
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    phone_number_id: number,
    call_status: 'completed',
    duration_seconds: 45,
    created_at: at(2),
  });
  // In-app dial on the number, no answer.
  await createCallRow(db, {
    lead_id: lead,
    user_id: agent,
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    phone_number_id: number,
    call_status: 'no-answer',
    outcome: 'NO_ANSWER',
    created_at: at(3),
  });
  // Pre-created in-app row that never reached Twilio: not a dial.
  await createCallRow(db, { lead_id: lead, user_id: agent, mode: 'IN_APP', phone_number_id: number, created_at: at(4) });
  // Answered inbound callback, appointment: connected + appointment + talk, not a dial.
  await createCallRow(db, {
    lead_id: lead,
    user_id: agent,
    direction: 'INBOUND',
    mode: 'IN_APP',
    provider_call_sid: fakeTwilioSid('CA'),
    call_status: 'completed',
    outcome: 'APPOINTMENT',
    duration_seconds: 300,
    created_at: at(5),
  });
  // Wrong number: a dial, not connected.
  await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'WRONG_NUMBER', created_at: at(6) });
  // A call the agent made on a lead that now belongs to someone else: still the agent's stat.
  await createCallRow(db, { lead_id: movedLead, user_id: agent, outcome: 'CONNECTED', duration_seconds: 15, created_at: at(7) });
  // The other user's calls never count for the agent.
  await createCallRow(db, { lead_id: movedLead, user_id: other, outcome: 'APPOINTMENT', duration_seconds: 999, created_at: at(8) });

  const expected: Stats = { dials: 5, connected: 3, interested: 1, appointments: 1, talk_seconds: 450 };
  return { agent, number, from: start, to: endOfDayInTz(tz), expected };
}

describe.each(['America/New_York', 'America/Los_Angeles', 'Pacific/Auckland'])('same agent and day in %s', (tz) => {
  let ctx: Awaited<ReturnType<typeof seedDay>>;

  beforeAll(async () => {
    ctx = await seedDay(tz, `Consistency ${tz}`);
  });

  it('get_my_dashboard, admin_agent_rows, admin_agent_activity and admin_report_agents agree', async () => {
    const [{ d }] = await userRows<{ d: Record<string, number> }>(db, ctx.agent, 'select public.get_my_dashboard() as d');
    const dashboard: Stats = {
      dials: d.dials_today,
      connected: d.connected_today,
      interested: d.interested_today,
      appointments: d.appointments_today,
      talk_seconds: d.talk_seconds_today,
    };

    const rows = await userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_agent_rows() where user_id = $1', [ctx.agent]);
    const row = rows[0];
    const adminRow: Stats = {
      dials: Number(row.dials_today),
      connected: Number(row.connected_today),
      interested: Number(row.interested_today),
      appointments: Number(row.appointments_today),
      talk_seconds: Number(row.talk_seconds_today),
    };

    const [{ a }] = await userRows<{ a: { stats: Stats & Record<string, number>; profile: { clients: number } } }>(
      db,
      admin,
      'select public.admin_agent_activity($1, $2, $3) as a',
      [ctx.agent, ctx.from, ctx.to],
    );
    const activity: Stats = {
      dials: a.stats.dials,
      connected: a.stats.connected,
      interested: a.stats.interested,
      appointments: a.stats.appointments,
      talk_seconds: a.stats.talk_seconds,
    };

    const reportRows = await userRows<Record<string, unknown>>(
      db,
      admin,
      'select * from public.admin_report_agents($1, $2) where user_id = $3',
      [ctx.from, ctx.to, ctx.agent],
    );
    const r = reportRows[0];
    const report: Stats = {
      dials: Number(r.dials),
      connected: Number(r.connected),
      interested: Number(r.interested),
      appointments: Number(r.appointments),
      talk_seconds: Number(r.talk_seconds),
    };

    expect(dashboard).toEqual(ctx.expected);
    expect(adminRow).toEqual(ctx.expected);
    expect(activity).toEqual(ctx.expected);
    expect(report).toEqual(ctx.expected);
    expect(Number(r.connect_rate)).toBeCloseTo(3 / 5, 4);
    // Four calls with a positive duration: 90 + 45 + 300 + 15.
    expect(a.stats.calls_with_duration).toBe(4);
    expect(Number(r.avg_call_seconds)).toBeCloseTo(450 / 4, 2);
    expect(Number(r.clients)).toBe(a.profile.clients);
    expect(d.remaining).toBe(10 - ctx.expected.dials);
  });

  it('admin_report_numbers counts the same outbound dials placed on the number', async () => {
    const [n] = await userRows<Record<string, unknown>>(
      db,
      admin,
      'select * from public.admin_report_numbers($1, $2) where phone_number_id = $3',
      [ctx.from, ctx.to, ctx.number],
    );
    expect({ dials: Number(n.dials), answered: Number(n.answered) }).toEqual({ dials: 2, answered: 1 });
    expect(Number(n.answer_rate)).toBeCloseTo(0.5, 4);
  });
});

describe('team totals', () => {
  it('admin_report_totals equals the sum of admin_report_agents rows', async () => {
    const from = new Date(Date.now() - 3 * 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const rows = await userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_report_agents($1, $2)', [from, to]);
    const [{ t }] = await userRows<{ t: Record<string, number> }>(db, admin, 'select public.admin_report_totals($1, $2) as t', [from, to]);
    const sum = (key: string) => rows.reduce((acc, row) => acc + Number(row[key]), 0);
    expect(t.agents).toBe(rows.length);
    for (const key of ['dials', 'connected', 'interested', 'appointments', 'talk_seconds', 'clients']) {
      expect(Number(t[key]), key).toBe(sum(key));
    }
  });

  it('admin_team_totals today numbers equal the sum of admin_agent_rows', async () => {
    const rows = await userRows<Record<string, unknown>>(db, admin, 'select * from public.admin_agent_rows()');
    const [{ t }] = await userRows<{ t: Record<string, number> }>(db, admin, 'select public.admin_team_totals() as t');
    const sum = (key: string) => rows.reduce((acc, row) => acc + Number(row[key]), 0);
    expect(Number(t.calls_today)).toBe(sum('dials_today'));
    expect(Number(t.connected_today)).toBe(sum('connected_today'));
    expect(Number(t.appointments_today)).toBe(sum('appointments_today'));
    expect(Number(t.talk_minutes_today)).toBe(Math.round(sum('talk_seconds_today') / 60));
  });
});
