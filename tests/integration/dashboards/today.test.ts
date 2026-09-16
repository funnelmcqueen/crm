// The agent Today workspace data and the admin "Needs attention" counts through the service layer
// (docs/DEVIATIONS.md D43). Everything on the agent side is the caller's own.
import { beforeAll, describe, expect, it } from 'vitest';
import { startOfDayInTz } from '@/lib/domain/time';
import type { RequestContext } from '@/server/context';
import { getAdminDashboard, getAgentDashboard } from '@/server/services/dashboard';
import { skipLead } from '@/server/services/skipped-leads';
import { serviceClient } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import { createCall, createFollowUp, createLead, createUser, type FixtureUser } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

const TZ = 'America/Chicago';
const HOUR = 3_600_000;

let agent: FixtureUser;
let other: FixtureUser;
let ctxAgent: RequestContext;
let ctxOther: RequestContext;
let ctxAdmin: RequestContext;

beforeAll(async () => {
  [agent, other] = await Promise.all([
    createUser({ name: 'Today Agent', timezone: TZ, dailyCallTarget: 20 }),
    createUser({ name: 'Today Empty Agent', timezone: TZ }),
  ]);
  [ctxAgent, ctxOther, ctxAdmin] = await Promise.all([contextForUser(agent), contextForUser(other), signInSeeded('admin').then(contextFor)]);
});

describe('agent Today', () => {
  it("returns the agent's own week, queues and lead count", async () => {
    const [called, overdue, skipped] = await Promise.all([
      createLead({ assigned_to: agent.id }),
      createLead({ assigned_to: agent.id, status: 'FOLLOW_UP' }),
      createLead({ assigned_to: agent.id }),
    ]);
    const today = startOfDayInTz(TZ);
    await createCall({ lead_id: called.id, user_id: agent.id, outcome: 'CONNECTED', created_at: new Date(today.getTime() + HOUR).toISOString() });
    await createCall({ lead_id: called.id, user_id: agent.id, outcome: 'NO_ANSWER', created_at: new Date(today.getTime() - 2 * 24 * HOUR).toISOString() });
    await createFollowUp({ lead_id: overdue.id, user_id: agent.id, due_at: new Date(Date.now() - HOUR).toISOString() });
    await skipLead(ctxAgent, skipped.id, { reason: 'CALL_LATER' });

    const { stats, today: todayData } = await getAgentDashboard(ctxAgent);
    expect(todayData.callDays).toHaveLength(7);
    expect(todayData.callDays[6].dials).toBe(stats.dialsToday);
    expect(todayData.callDays[4].dials).toBe(1);
    expect(todayData.callDays.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.day))).toBe(true);
    expect(todayData).toMatchObject({ overdueFollowUps: 1, skipped: 1, leadsAssigned: 3 });
    expect(typeof todayData.callerIdAvailable).toBe('boolean');
  });

  it('reports the empty states for an agent with nothing yet', async () => {
    const { today, nextLead } = await getAgentDashboard(ctxOther);
    expect(nextLead).toBeNull();
    expect(today).toMatchObject({ overdueFollowUps: 0, skipped: 0, leadsAssigned: 0 });
    expect(today.callDays.map((day) => day.dials)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('caller ID availability follows the active numbers the agent could use', async () => {
    const { data: numbers } = await serviceClient().from('phone_numbers').select('id').eq('active', true).or(`assigned_to.is.null,assigned_to.eq.${other.id}`).limit(1);
    const { today } = await getAgentDashboard(ctxOther);
    expect(today.callerIdAvailable).toBe((numbers ?? []).length > 0);
  });
});

describe('admin Needs attention', () => {
  it('counts active phone numbers and open skips across the team', async () => {
    const { attention, totals } = await getAdminDashboard(ctxAdmin);
    const { count: active } = await serviceClient().from('phone_numbers').select('id', { count: 'exact', head: true }).eq('active', true);
    const { count: skips } = await serviceClient().from('lead_skips').select('id', { count: 'exact', head: true }).is('resolved_at', null);
    expect(attention).toEqual({ activePhoneNumbers: active ?? 0, skipped: skips ?? 0 });
    expect(totals.leadsUnassigned).toBeGreaterThanOrEqual(0);
  });

  it('is refused to agents', async () => {
    await expect(getAdminDashboard(ctxAgent)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
