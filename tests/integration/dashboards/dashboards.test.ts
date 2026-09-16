// Dashboard services over HTTP with real sessions (SPEC 8 dashboards, SPEC 1 isolation): the agent dashboard holds
// only the agent's own numbers, and the admin dashboard is admin-only with per-agent rows in each agent's timezone.
import { beforeAll, describe, expect, it } from 'vitest';
import { endOfDayInTz, startOfDayInTz } from '@/lib/domain/time';
import type { RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import { getAdminDashboard, getAgentDashboard, getMyDashboardStats, getTeamTotals, listAgentStatsRows } from '@/server/services/dashboard';
import { serviceClient } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import { createCall, createFollowUp, createLead, createUser, disableUser, fakeTwilioSid, type FixtureUser } from '../../helpers/fixtures';
import { expectError } from '../../helpers/isolation';
import { signInSeeded } from '../../helpers/seeded';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const MINUTE = 60_000;

let agentA: FixtureUser;
let agentB: FixtureUser;
let disabled: FixtureUser;
let ctxA: RequestContext;
let ctxB: RequestContext;
let ctxAdmin: RequestContext;
const leadsA: string[] = [];

interface Expected {
  dials: number;
  connected: number;
  interested: number;
  appointments: number;
  talkSeconds: number;
}

/** Recomputes the shared stat definitions with the service client, independently of the RPCs. */
async function computeToday(userId: string, tz: string): Promise<Expected> {
  const { data, error } = await serviceClient()
    .from('calls')
    .select('direction, outcome, provider_call_sid, duration_seconds, created_at')
    .eq('user_id', userId)
    .gte('created_at', startOfDayInTz(tz).toISOString())
    .lt('created_at', endOfDayInTz(tz).toISOString());
  if (error || !data) throw new Error(`calls for ${userId}: ${error?.message}`);
  const notConnected = new Set(['NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER']);
  return {
    dials: data.filter((c) => c.direction === 'OUTBOUND' && (c.outcome !== null || c.provider_call_sid !== null)).length,
    connected: data.filter((c) => c.outcome !== null && !notConnected.has(c.outcome)).length,
    interested: data.filter((c) => c.outcome === 'INTERESTED').length,
    appointments: data.filter((c) => c.outcome === 'APPOINTMENT').length,
    talkSeconds: data.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0),
  };
}

beforeAll(async () => {
  [agentA, agentB, disabled] = await Promise.all([
    createUser({ name: 'Dash Agent A', timezone: LA, dailyCallTarget: 3 }),
    createUser({ name: 'Dash Agent B', timezone: TOKYO, dailyCallTarget: 40 }),
    createUser({ name: 'Dash Disabled' }),
  ]);

  const [a1, a2, b1] = await Promise.all([
    createLead({ assigned_to: agentA.id, status: 'NEW' }),
    createLead({ assigned_to: agentA.id, status: 'TO_CALL' }),
    createLead({ assigned_to: agentB.id, status: 'NEW' }),
    createLead({ assigned_to: disabled.id }),
    createLead({ assigned_to: disabled.id }),
  ]);
  leadsA.push(a1.id, a2.id);

  const laStart = startOfDayInTz(LA).getTime();
  await Promise.all([
    // Agent A, today in LA.
    createCall({ lead_id: a1.id, user_id: agentA.id, outcome: 'INTERESTED', duration_seconds: 125, created_at: new Date(laStart + 30 * MINUTE).toISOString() }),
    createCall({ lead_id: a1.id, user_id: agentA.id, outcome: 'NO_ANSWER' }),
    createCall({ lead_id: a2.id, user_id: agentA.id, mode: 'IN_APP', provider_call_sid: fakeTwilioSid('CA'), call_status: 'completed', duration_seconds: 40 }),
    createCall({ lead_id: a2.id, user_id: agentA.id, mode: 'IN_APP' }), // pre-created, never dialed: not a dial
    // Agent A, 23:30 yesterday in LA: not today.
    createCall({ lead_id: a1.id, user_id: agentA.id, outcome: 'APPOINTMENT', duration_seconds: 600, created_at: new Date(laStart - 30 * MINUTE).toISOString() }),
    // Agent B, including a call on A's lead that must never show on A's dashboard.
    createCall({ lead_id: b1.id, user_id: agentB.id, outcome: 'APPOINTMENT', duration_seconds: 300 }),
    createCall({ lead_id: a1.id, user_id: agentB.id, outcome: 'CONNECTED', duration_seconds: 700 }),
    createFollowUp({ lead_id: a1.id, user_id: agentA.id, due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    createFollowUp({ lead_id: b1.id, user_id: agentB.id, due_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
  ]);

  [ctxA, ctxB, ctxAdmin] = await Promise.all([contextForUser(agentA), contextForUser(agentB), signInSeeded('admin').then(contextFor)]);
  // Disabled after the leads exist, like an admin disabling an agent who still has leads.
  await disableUser(disabled.id);
});

describe('agent dashboard', () => {
  it('holds exactly the agent\'s own numbers, matching an independent computation', async () => {
    const expected = await computeToday(agentA.id, LA);
    expect(expected).toEqual({ dials: 3, connected: 1, interested: 1, appointments: 0, talkSeconds: 165 });

    const { stats, nextLead } = await getAgentDashboard(ctxA);
    expect(stats).toEqual({
      timezone: LA,
      dailyCallTarget: 3,
      dialsToday: expected.dials,
      remaining: 0,
      targetHit: true,
      connectedToday: expected.connected,
      interestedToday: expected.interested,
      appointmentsToday: expected.appointments,
      talkSecondsToday: expected.talkSeconds,
      followUpsDue: 1,
      unheardVoicemails: 0,
    });
    expect(nextLead).not.toBeNull();
    expect(leadsA).toContain(nextLead?.leadId);
  });

  it('agent B sees their own numbers only', async () => {
    const expected = await computeToday(agentB.id, TOKYO);
    const stats = await getMyDashboardStats(ctxB);
    expect(stats).toMatchObject({
      timezone: TOKYO,
      dialsToday: expected.dials,
      remaining: 40 - expected.dials,
      targetHit: false,
      connectedToday: expected.connected,
      appointmentsToday: expected.appointments,
      talkSecondsToday: expected.talkSeconds,
      followUpsDue: 1,
    });
    expect(stats.dialsToday).toBe(2);
  });

  it('the raw RPC response has no team fields', async () => {
    const { data, error } = await ctxA.supabase.rpc('get_my_dashboard');
    expect(error).toBeNull();
    expect(Object.keys(data as object).sort()).toEqual(
      [
        'appointments_today',
        'connected_today',
        'daily_call_target',
        'dials_today',
        'follow_ups_due',
        'interested_today',
        'remaining',
        'talk_seconds_today',
        'target_hit',
        'timezone',
        'unheard_voicemails',
      ].sort(),
    );
  });
});

describe('admin dashboard access', () => {
  it('agents are forbidden in the service and in the database', async () => {
    for (const fn of [getAdminDashboard, getTeamTotals, listAgentStatsRows]) {
      const err = await fn(ctxA).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('forbidden');
    }
    expectError(await ctxA.supabase.rpc('admin_agent_rows'), '42501');
    expectError(await ctxA.supabase.rpc('admin_team_totals'), '42501');
  });
});

describe('admin dashboard', () => {
  it('per-agent rows include fixture agents with their today counts in their own timezones', async () => {
    const { totals, agents } = await getAdminDashboard(ctxAdmin);
    const rowA = agents.find((r) => r.userId === agentA.id);
    const rowB = agents.find((r) => r.userId === agentB.id);
    const rowDisabled = agents.find((r) => r.userId === disabled.id);

    const [expA, expB] = await Promise.all([computeToday(agentA.id, LA), computeToday(agentB.id, TOKYO)]);
    expect(rowA).toMatchObject({
      name: 'Dash Agent A',
      email: agentA.email,
      role: 'AGENT',
      active: true,
      timezone: LA,
      dailyCallTarget: 3,
      leadsAssigned: 2,
      dialsToday: expA.dials,
      connectedToday: expA.connected,
      interestedToday: expA.interested,
      appointmentsToday: expA.appointments,
      talkSecondsToday: expA.talkSeconds,
      assignedNumbers: [],
    });
    expect(rowB).toMatchObject({
      timezone: TOKYO,
      leadsAssigned: 1,
      dialsToday: expB.dials,
      connectedToday: expB.connected,
      appointmentsToday: expB.appointments,
      talkSecondsToday: expB.talkSeconds,
    });
    expect(rowDisabled).toMatchObject({ active: false, leadsAssigned: 2 });

    // The agent's own dashboard and the admin row agree.
    const own = await getMyDashboardStats(ctxA);
    expect([own.dialsToday, own.connectedToday, own.talkSecondsToday]).toEqual([rowA?.dialsToday, rowA?.connectedToday, rowA?.talkSecondsToday]);

    expect(totals.disabledAgentsWithLeads).toBeGreaterThanOrEqual(1);
    expect(totals.leadsOnDisabledAgents).toBeGreaterThanOrEqual(2);
    expect(totals.callsToday).toBeGreaterThanOrEqual(expA.dials + expB.dials);
    expect(totals.leadsTotal).toBeGreaterThanOrEqual(totals.leadsUnassigned + 5);
  });

  it('seeded agents appear with the seeded timezones and assigned numbers', async () => {
    const rows = await listAgentStatsRows(ctxAdmin);
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    expect(byEmail.get('alex@funnelmcqueen.test')).toMatchObject({ name: 'Alex Rivera', timezone: 'America/New_York', assignedNumbers: ['+14155550150'] });
    expect(byEmail.get('blair@funnelmcqueen.test')).toMatchObject({ timezone: 'America/Chicago', assignedNumbers: ['+14155550151'] });
    expect(byEmail.get('casey@funnelmcqueen.test')).toMatchObject({ timezone: LA, assignedNumbers: [] });
    expect(byEmail.get('dana@funnelmcqueen.test')).toMatchObject({ active: false });
    expect(byEmail.get('admin@funnelmcqueen.test')).toMatchObject({ role: 'ADMIN' });
  });
});
