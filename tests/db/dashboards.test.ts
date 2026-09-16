// Stage 6 dashboard RPCs: get_my_dashboard (caller only), admin_agent_rows and admin_team_totals (admin only),
// using the shared stat definitions, per-user timezones and calls.user_id attribution.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOfDayInTz, startOfDayInTz } from '@/lib/domain/time';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  createPhoneNumberRow,
  fakeTwilioSid,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

const MINUTE = 60_000;
const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

interface MyDashboard {
  timezone: string;
  daily_call_target: number;
  dials_today: number;
  remaining: number;
  target_hit: boolean;
  connected_today: number;
  interested_today: number;
  appointments_today: number;
  talk_seconds_today: number;
  follow_ups_due: number;
  unheard_voicemails: number;
}

interface AgentRow {
  user_id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  in_app_calling_enabled: boolean;
  timezone: string;
  daily_call_target: number;
  leads_assigned: number;
  dials_today: number;
  connected_today: number;
  interested_today: number;
  appointments_today: number;
  talk_seconds_today: number;
  assigned_numbers: string[];
}

interface TeamTotals {
  leads_total: number;
  leads_unassigned: number;
  calls_today: number;
  connected_today: number;
  interested_today: number;
  appointments_today: number;
  clients_total: number;
  clients_assigned: number;
  clients_unassigned: number;
  talk_seconds_today: number;
  talk_minutes_today: number;
  disabled_agents_with_leads: number;
  leads_on_disabled_agents: number;
}

const AGENT_ROW_SQL = `
  select user_id, name, email, role::text as role, active, in_app_calling_enabled, timezone, daily_call_target,
         leads_assigned::int as leads_assigned, dials_today::int as dials_today, connected_today::int as connected_today,
         interested_today::int as interested_today, appointments_today::int as appointments_today,
         talk_seconds_today::int as talk_seconds_today, assigned_numbers
    from public.admin_agent_rows()`;

let db: PGlite;
let admin = '';

async function myDashboard(userId: string): Promise<MyDashboard> {
  const rows = await userRows<{ d: MyDashboard }>(db, userId, 'select public.get_my_dashboard() as d');
  return rows[0].d;
}

async function agentRows(userId: string): Promise<AgentRow[]> {
  return userRows<AgentRow>(db, userId, AGENT_ROW_SQL);
}

async function agentRow(userId: string): Promise<AgentRow> {
  const row = (await agentRows(admin)).find((r) => r.user_id === userId);
  if (!row) throw new Error(`no admin_agent_rows row for ${userId}`);
  return row;
}

async function teamTotals(userId: string): Promise<TeamTotals> {
  const rows = await userRows<{ t: TeamTotals }>(db, userId, 'select public.admin_team_totals() as t');
  return rows[0].t;
}

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Dash Admin', timezone: 'America/New_York' });
});

afterAll(async () => {
  await db?.close();
});

describe('get_my_dashboard', () => {
  let agent = '';
  let other = '';
  let lead = '';

  beforeAll(async () => {
    agent = await createAuthUser(db, { name: 'LA Agent', timezone: LA, dailyCallTarget: 4 });
    other = await createAuthUser(db, { name: 'Other Agent', timezone: LA });
    lead = (await createLeadRow(db, { assigned_to: agent, status: 'TO_CALL' })).id;
    const otherLead = (await createLeadRow(db, { assigned_to: other })).id;

    const todayStart = startOfDayInTz(LA);
    const yesterday2330 = new Date(todayStart.getTime() - 30 * MINUTE);
    const today0030 = new Date(todayStart.getTime() + 30 * MINUTE);

    // Yesterday 23:30 local: not today, although it may be "today" in UTC or New York.
    await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'INTERESTED', duration_seconds: 900, created_at: yesterday2330 });
    // Today 00:30 local: counted.
    await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'INTERESTED', duration_seconds: 120, created_at: today0030 });
    // Pre-created in-app row that never reached Twilio and has no outcome: not a dial, no stats.
    await createCallRow(db, { lead_id: lead, user_id: agent, mode: 'IN_APP', created_at: today0030 });
    // In-app call that reached Twilio but was not logged yet: a dial, not connected.
    await createCallRow(db, {
      lead_id: lead,
      user_id: agent,
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      call_status: 'completed',
      duration_seconds: 30,
      created_at: today0030,
    });
    // Wrong number: a dial, not connected.
    await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'WRONG_NUMBER', created_at: today0030 });
    // Voicemail outcome: a dial, not connected.
    await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'VOICEMAIL', duration_seconds: 20, created_at: today0030 });
    // Answered inbound callback booked an appointment: connected + appointment + talk time, not a dial.
    await createCallRow(db, {
      lead_id: lead,
      user_id: agent,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      outcome: 'APPOINTMENT',
      duration_seconds: 60,
      created_at: today0030,
    });
    // Unheard voicemail on the agent's lead (inbound, no outcome): not a dial, counts as unheard.
    await createCallRow(db, {
      lead_id: lead,
      user_id: agent,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    });
    // Another agent's calls today, including one on this agent's lead: never counted for this agent.
    await createCallRow(db, { lead_id: lead, user_id: other, outcome: 'APPOINTMENT', duration_seconds: 500 });
    await createCallRow(db, { lead_id: otherLead, user_id: other, outcome: 'CONNECTED', duration_seconds: 400 });
    await createCallRow(db, {
      lead_id: otherLead,
      user_id: other,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    });

    const endOfToday = endOfDayInTz(LA);
    await createFollowUpRow(db, { lead_id: lead, user_id: agent, due_at: new Date(Date.now() - 3 * 86_400_000) }); // overdue
    await createFollowUpRow(db, { lead_id: lead, user_id: agent, due_at: new Date(endOfToday.getTime() - MINUTE) }); // later today
    await createFollowUpRow(db, { lead_id: lead, user_id: agent, due_at: new Date(endOfToday.getTime() + MINUTE) }); // tomorrow
    await createFollowUpRow(db, { lead_id: lead, user_id: agent, due_at: new Date(Date.now() - MINUTE), completed_at: new Date() });
    await createFollowUpRow(db, { lead_id: otherLead, user_id: other, due_at: new Date(Date.now() - MINUTE) });
  });

  it('counts only the caller\'s own calls today in their timezone, with the shared stat definitions', async () => {
    expect(await myDashboard(agent)).toEqual({
      timezone: LA,
      daily_call_target: 4,
      dials_today: 4,
      remaining: 0,
      target_hit: true,
      connected_today: 2,
      interested_today: 1,
      appointments_today: 1,
      talk_seconds_today: 230,
      follow_ups_due: 2,
      unheard_voicemails: 1,
    });
  });

  it('the other agent sees only their own numbers', async () => {
    expect(await myDashboard(other)).toMatchObject({
      dials_today: 2,
      remaining: 48,
      target_hit: false,
      connected_today: 2,
      interested_today: 0,
      appointments_today: 1,
      talk_seconds_today: 900,
      follow_ups_due: 1,
      unheard_voicemails: 1,
    });
  });

  it('the SQL day window is [local midnight, next local midnight), identical to startOfDayInTz/endOfDayInTz', async () => {
    const rows = await adminSqlRows<{ start: Date; end: Date }>(
      db,
      `select (date_trunc('day', now() at time zone $1) at time zone $1) as start,
              ((date_trunc('day', now() at time zone $1) + interval '1 day') at time zone $1) as end`,
      [LA],
    );
    expect(rows[0].start.getTime()).toBe(startOfDayInTz(LA).getTime());
    expect(rows[0].end.getTime()).toBe(endOfDayInTz(LA).getTime());
  });

  it('remaining is target minus dials, never negative; a zero target is never "hit"', async () => {
    const zero = await createAuthUser(db, { timezone: TOKYO, dailyCallTarget: 0 });
    expect(await myDashboard(zero)).toMatchObject({ daily_call_target: 0, dials_today: 0, remaining: 0, target_hit: false });

    const busy = await createAuthUser(db, { timezone: TOKYO, dailyCallTarget: 2 });
    const busyLead = (await createLeadRow(db, { assigned_to: busy })).id;
    await createCallRow(db, { lead_id: busyLead, user_id: busy, outcome: 'NO_ANSWER' });
    expect(await myDashboard(busy)).toMatchObject({ dials_today: 1, remaining: 1, target_hit: false });
    await createCallRow(db, { lead_id: busyLead, user_id: busy, outcome: 'NO_ANSWER' });
    await createCallRow(db, { lead_id: busyLead, user_id: busy, outcome: 'NO_ANSWER' });
    expect(await myDashboard(busy)).toMatchObject({ dials_today: 3, remaining: 0, target_hit: true });
  });

  it('an admin calling it gets only their own call stats, never team numbers', async () => {
    const soloAdmin = await createAuthUser(db, { role: 'ADMIN', timezone: TOKYO });
    const d = await myDashboard(soloAdmin);
    expect(d).toMatchObject({ dials_today: 0, connected_today: 0, interested_today: 0, appointments_today: 0, talk_seconds_today: 0, follow_ups_due: 0 });
  });

  it('inactive users and callers without a user get 42501', async () => {
    const disabled = await createAuthUser(db, { active: false });
    expect((await pgError(myDashboard(disabled))).code).toBe('42501');
    expect((await pgError(serviceRows(db, 'select public.get_my_dashboard()'))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select public.get_my_dashboard()'))).code).toBe('42501');
  });
});

describe('stats stay with calls.user_id after reassignment', () => {
  it('moves the lead but not the stats', async () => {
    const a = await createAuthUser(db, { name: 'Reassign A', timezone: TOKYO });
    const b = await createAuthUser(db, { name: 'Reassign B', timezone: TOKYO });
    const lead = (await createLeadRow(db, { assigned_to: a })).id;
    await createCallRow(db, { lead_id: lead, user_id: a, outcome: 'APPOINTMENT', duration_seconds: 45 });
    await createFollowUpRow(db, { lead_id: lead, user_id: a, due_at: new Date(Date.now() - MINUTE) });

    expect(await myDashboard(a)).toMatchObject({ dials_today: 1, appointments_today: 1, talk_seconds_today: 45, follow_ups_due: 1 });
    await userRows(db, admin, 'select public.reassign_leads(array[$1::uuid], $2::uuid)', [lead, b]);

    expect(await myDashboard(a)).toMatchObject({ dials_today: 1, connected_today: 1, appointments_today: 1, talk_seconds_today: 45, follow_ups_due: 0 });
    expect(await myDashboard(b)).toMatchObject({ dials_today: 0, connected_today: 0, appointments_today: 0, talk_seconds_today: 0, follow_ups_due: 1 });

    expect(await agentRow(a)).toMatchObject({ leads_assigned: 0, dials_today: 1, appointments_today: 1, talk_seconds_today: 45 });
    expect(await agentRow(b)).toMatchObject({ leads_assigned: 1, dials_today: 0, appointments_today: 0, talk_seconds_today: 0 });
  });
});

describe('admin_agent_rows', () => {
  it('uses each user\'s own timezone for "today"', async () => {
    const la = await createAuthUser(db, { name: 'Row LA', timezone: LA });
    const tokyo = await createAuthUser(db, { name: 'Row Tokyo', timezone: TOKYO });
    const laLead = (await createLeadRow(db, { assigned_to: la })).id;
    const tokyoLead = (await createLeadRow(db, { assigned_to: tokyo })).id;

    const laStart = startOfDayInTz(LA).getTime();
    await createCallRow(db, { lead_id: laLead, user_id: la, outcome: 'CONNECTED', duration_seconds: 10, created_at: new Date(laStart - 30 * MINUTE) });
    await createCallRow(db, { lead_id: laLead, user_id: la, outcome: 'CONNECTED', duration_seconds: 20, created_at: new Date(laStart + 30 * MINUTE) });

    const tokyoStart = startOfDayInTz(TOKYO).getTime();
    await createCallRow(db, { lead_id: tokyoLead, user_id: tokyo, outcome: 'INTERESTED', created_at: new Date(tokyoStart - 30 * MINUTE) });
    await createCallRow(db, { lead_id: tokyoLead, user_id: tokyo, outcome: 'INTERESTED', created_at: new Date(tokyoStart + 30 * MINUTE) });

    expect(await agentRow(la)).toMatchObject({ timezone: LA, dials_today: 1, connected_today: 1, talk_seconds_today: 20 });
    expect(await agentRow(tokyo)).toMatchObject({ timezone: TOKYO, dials_today: 1, connected_today: 1, interested_today: 1 });

    // The same numbers the users see on their own dashboards.
    expect(await myDashboard(la)).toMatchObject({ dials_today: 1, connected_today: 1, talk_seconds_today: 20 });
    expect(await myDashboard(tokyo)).toMatchObject({ dials_today: 1, connected_today: 1, interested_today: 1 });
  });

  it('includes every AGENT and ADMIN profile (active or not) with profile fields and active assigned numbers', async () => {
    const agent = await createAuthUser(db, { name: 'Numbers Agent', timezone: TOKYO, dailyCallTarget: 77, inAppCallingEnabled: false });
    const disabled = await createAuthUser(db, { name: 'Disabled Row', active: false });
    const n1 = await createPhoneNumberRow(db, { assigned_to: agent, e164: '+14155550188' });
    const n2 = await createPhoneNumberRow(db, { assigned_to: agent, e164: '+14155550187' });
    await createPhoneNumberRow(db, { assigned_to: agent, active: false, e164: '+14155550186' });
    await createPhoneNumberRow(db, { assigned_to: null, e164: '+14155550185' });

    const rows = await agentRows(admin);
    const profiles = await adminSqlRows<{ id: string }>(db, `select id from public.profiles where role in ('AGENT','ADMIN')`);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set(profiles.map((p) => p.id)));
    expect(rows).toHaveLength(profiles.length);

    const row = rows.find((r) => r.user_id === agent);
    expect(row).toMatchObject({
      name: 'Numbers Agent',
      role: 'AGENT',
      active: true,
      in_app_calling_enabled: false,
      timezone: TOKYO,
      daily_call_target: 77,
      leads_assigned: 0,
      dials_today: 0,
    });
    expect(row?.assigned_numbers).toEqual([n2.e164, n1.e164].sort());
    expect(rows.find((r) => r.user_id === disabled)).toMatchObject({ active: false, assigned_numbers: [] });
    expect(rows.find((r) => r.user_id === admin)).toMatchObject({ role: 'ADMIN', active: true });
  });

  it('agents, inactive admins, service role and anon cannot call admin RPCs (42501)', async () => {
    const agent = await createAuthUser(db);
    const inactiveAdmin = await createAuthUser(db, { role: 'ADMIN', active: false });
    for (const user of [agent, inactiveAdmin]) {
      expect((await pgError(userRows(db, user, 'select * from public.admin_agent_rows()'))).code).toBe('42501');
      expect((await pgError(userRows(db, user, 'select public.admin_team_totals()'))).code).toBe('42501');
    }
    expect((await pgError(serviceRows(db, 'select * from public.admin_agent_rows()'))).code).toBe('42501');
    expect((await pgError(serviceRows(db, 'select public.admin_team_totals()'))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select * from public.admin_agent_rows()'))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select public.admin_team_totals()'))).code).toBe('42501');
  });
});

describe('admin_team_totals', () => {
  it('lead counts match the table and today totals are sums of admin_agent_rows', async () => {
    const disabledA = await createAuthUser(db, { name: 'Gone A', active: false });
    const disabledB = await createAuthUser(db, { name: 'Gone B', active: false });
    await createAuthUser(db, { name: 'Gone C (no leads)', active: false });
    await createLeadRow(db, { assigned_to: disabledA });
    await createLeadRow(db, { assigned_to: disabledA, status: 'CLIENT' });
    await createLeadRow(db, { assigned_to: disabledB });
    await createLeadRow(db, { assigned_to: null, status: 'CLIENT' });

    const client = await createAuthUser(db, { name: 'Talker', timezone: TOKYO });
    const clientLead = (await createLeadRow(db, { assigned_to: client, status: 'CLIENT' })).id;
    await createCallRow(db, { lead_id: clientLead, user_id: client, outcome: 'CONNECTED', duration_seconds: 89 });
    // Admin-only voicemail (no user): belongs to nobody's stats.
    await createCallRow(db, {
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
      duration_seconds: 1000,
    });

    const totals = await teamTotals(admin);
    const [leadCounts] = await adminSqlRows<{
      total: number;
      unassigned: number;
      clients: number;
      clients_assigned: number;
      clients_unassigned: number;
      on_disabled: number;
      disabled_with: number;
    }>(
      db,
      `select count(*)::int as total,
              count(*) filter (where l.assigned_to is null)::int as unassigned,
              count(*) filter (where l.status = 'CLIENT')::int as clients,
              count(*) filter (where l.status = 'CLIENT' and l.assigned_to is not null)::int as clients_assigned,
              count(*) filter (where l.status = 'CLIENT' and l.assigned_to is null)::int as clients_unassigned,
              count(*) filter (where p.active = false)::int as on_disabled,
              count(distinct p.id) filter (where p.active = false)::int as disabled_with
         from public.leads l left join public.profiles p on p.id = l.assigned_to`,
    );
    const rows = await agentRows(admin);
    const sum = (key: keyof AgentRow) => rows.reduce((acc, r) => acc + Number(r[key]), 0);

    expect(totals).toEqual({
      leads_total: leadCounts.total,
      leads_unassigned: leadCounts.unassigned,
      clients_total: leadCounts.clients,
      clients_assigned: leadCounts.clients_assigned,
      clients_unassigned: leadCounts.clients_unassigned,
      leads_on_disabled_agents: leadCounts.on_disabled,
      disabled_agents_with_leads: leadCounts.disabled_with,
      calls_today: sum('dials_today'),
      connected_today: sum('connected_today'),
      interested_today: sum('interested_today'),
      appointments_today: sum('appointments_today'),
      talk_seconds_today: sum('talk_seconds_today'),
      talk_minutes_today: Math.round(sum('talk_seconds_today') / 60),
    });
    // The dashboard tile and the per-agent rows are read off the same seconds.
    expect(totals.clients_assigned + totals.clients_unassigned).toBe(totals.clients_total);
    expect(totals.disabled_agents_with_leads).toBeGreaterThanOrEqual(2);
    expect(totals.leads_on_disabled_agents).toBeGreaterThanOrEqual(3);
    expect(totals.clients_total).toBeGreaterThanOrEqual(3);
    expect(totals.calls_today).toBeGreaterThan(0);
  });
});

describe('grants', () => {
  it('the dashboard RPCs are executable by authenticated and service_role only', async () => {
    const rows = await adminSqlRows<{ proname: string; anon: boolean; authenticated: boolean; service: boolean; pub: boolean }>(
      db,
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('get_my_dashboard', 'admin_agent_rows', 'admin_team_totals')
        order by p.proname`,
    );
    expect(rows).toEqual([
      { proname: 'admin_agent_rows', anon: false, authenticated: true, service: true, pub: false },
      { proname: 'admin_team_totals', anon: false, authenticated: true, service: true, pub: false },
      { proname: 'get_my_dashboard', anon: false, authenticated: true, service: true, pub: false },
    ]);
    const config = await adminSqlRows<{ proname: string; prosecdef: boolean; proconfig: string[] }>(
      db,
      `select proname, prosecdef, proconfig from pg_proc
        where pronamespace = 'public'::regnamespace and proname in ('get_my_dashboard', 'admin_agent_rows', 'admin_team_totals')`,
    );
    for (const fn of config) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=""');
    }
  });
});
