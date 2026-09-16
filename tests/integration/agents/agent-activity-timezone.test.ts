// Review round 2: the agent drill-down computed Today / 7 days / 30 days in the *viewing admin's*
// timezone, while the agents list, the admin dashboard and the agent's own dashboard all use the
// agent's timezone. One click therefore changed the same agent's numbers, and both screens label the
// window "Today".
//
// The shared stat definitions are explicit: "Admin per-agent rows use each agent's own timezone", so
// the drill-down is what has to change.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { startOfDayInTz } from '@/lib/domain/time';
import { getAgentActivity } from '@/server/services/agents';
import { contextForUser } from '../../helpers/context';
import { createCall, createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

const ADMIN_TZ = 'America/New_York';
const AGENT_TZ = 'Pacific/Auckland';

/**
 * 2026-09-15T06:00Z. In New York that is 02:00 on the 15th (the admin's today); in Auckland it is
 * 18:00 on the 15th, and at NOW the agent's local day is already the 16th, so it is the agent's
 * yesterday. Exactly the instant the two zones disagree about.
 */
const CALL_AT = '2026-09-15T06:00:00.000Z';
const NOW = new Date('2026-09-15T12:00:00.000Z');

let admin: FixtureUser;
let adminCtx: RequestContext;
let agent: FixtureUser;

beforeAll(async () => {
  [admin, agent] = await Promise.all([
    createUser({ role: 'ADMIN', name: 'Drilldown Admin', timezone: ADMIN_TZ }),
    createUser({ name: 'Auckland Agent', timezone: AGENT_TZ, dailyCallTarget: 50 }),
  ]);
  adminCtx = await contextForUser(admin);
  const lead = await createLead({ assigned_to: agent.id });
  await createCall({
    lead_id: lead.id,
    user_id: agent.id,
    outcome: 'CONNECTED',
    duration_seconds: 300,
    created_at: CALL_AT,
  });
});

describe('the drill-down range is the agent\'s day, not the viewing admin\'s', () => {
  it('starts Today at local midnight in the agent\'s timezone', async () => {
    const activity = await getAgentActivity(adminCtx, agent.id, 'today', NOW);
    expect(activity).not.toBeNull();
    expect(activity?.range.timezone).toBe(AGENT_TZ);
    expect(activity?.range.from).toBe(startOfDayInTz(AGENT_TZ, NOW.getTime()).toISOString());
  });

  it('excludes a call that falls on the agent\'s previous local day', async () => {
    const activity = await getAgentActivity(adminCtx, agent.id, 'today', NOW);
    // The call is inside the admin's New York day but is yesterday in Auckland, so the agent's own
    // dashboard shows nothing for it and the drill-down must agree.
    expect(activity?.stats.dials).toBe(0);
    expect(activity?.stats.talkSeconds).toBe(0);
  });

  it('includes it in a multi-day range that reaches the agent\'s previous day', async () => {
    const activity = await getAgentActivity(adminCtx, agent.id, '7d', NOW);
    expect(activity?.range.timezone).toBe(AGENT_TZ);
    expect(activity?.stats.dials).toBe(1);
    expect(activity?.stats.talkSeconds).toBe(300);
  });
});
