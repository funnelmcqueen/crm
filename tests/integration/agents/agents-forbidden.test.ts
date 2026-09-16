// An active agent (and a signed-out caller) calling every admin agent/settings service and server action gets
// forbidden/unauthorized, and nothing changes: no Auth user, no profile, lead, follow-up or settings write,
// and the Auth admin client is never even created.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ refresh: vi.fn(), revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock('@/server/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/context')>();
  return { ...actual, getActionContext: vi.fn() };
});

import { getActionContext, type RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import * as agentActions from '@/server/actions/agents';
import * as settingsActions from '@/server/actions/settings';
import {
  bulkReassign,
  countReassignableLeads,
  createAgent,
  deleteAgent,
  getAgentActivity,
  getAgentDeleteCheck,
  listAgents,
  reassignSelected,
  setAgentActive,
  setInAppCalling,
  updateAgentProfile,
} from '@/server/services/agents';
import { getSettingsPageData, updateAgentTarget, updateCompanySettings } from '@/server/services/settings';
import { serviceClient } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { createFollowUp, createLead, createUser, uniqueEmail, type FixtureUser, type Lead } from '../../helpers/fixtures';

const mockedContext = vi.mocked(getActionContext);

let agent: FixtureUser;
let other: FixtureUser;
// No leads or follow-ups: the delete probes target an agent that really could be deleted.
let idle: FixtureUser;
let agentCtx: RequestContext;
let agentLead: Lead;
let otherLead: Lead;
let followUpId: string;

const probeEmail = uniqueEmail('never-created');
const authAdminNeverCalled = () => {
  throw new Error('the Auth admin client must not be created for a non-admin');
};

async function snapshot() {
  const service = serviceClient();
  const profiles = await service
    .from('profiles')
    .select('id, name, email, role, active, deleted_at, daily_call_target, timezone, in_app_calling_enabled')
    .in('id', [agent.id, other.id, idle.id])
    .order('id');
  const leads = await service.from('leads').select('id, assigned_to, status').in('id', [agentLead.id, otherLead.id]).order('id');
  const followUp = await service.from('follow_ups').select('id, user_id').eq('id', followUpId).single();
  const settings = await service.from('settings').select('company_name, default_daily_target, default_timezone, voicemail_greeting').single();
  const created = await service.from('profiles').select('id').eq('email', probeEmail);
  return { profiles: profiles.data, leads: leads.data, followUp: followUp.data, settings: settings.data, created: created.data };
}

beforeAll(async () => {
  [agent, other, idle] = await Promise.all([
    createUser({ name: 'Forbidden Agent', dailyCallTarget: 40, timezone: 'America/Chicago' }),
    createUser({ name: 'Other Agent' }),
    createUser({ name: 'Idle Agent' }),
  ]);
  agentCtx = await contextForUser(agent);
  [agentLead, otherLead] = await Promise.all([createLead({ assigned_to: agent.id }), createLead({ assigned_to: other.id })]);
  followUpId = (await createFollowUp({ lead_id: otherLead.id, user_id: other.id })).id;
});

beforeEach(() => {
  mockedContext.mockReset();
});

const companyInput = {
  company_name: 'Pwned Co',
  default_daily_target: 1,
  default_timezone: 'Europe/Paris',
  voicemail_greeting: 'pwned',
};

describe('admin services refuse an agent', () => {
  it('every admin service throws forbidden and changes nothing', async () => {
    const before = await snapshot();
    const deps = { authAdmin: authAdminNeverCalled };
    const calls: Array<() => Promise<unknown>> = [
      () => listAgents(agentCtx),
      () => createAgent(agentCtx, { name: 'Sneaky', email: probeEmail, dailyCallTarget: 50, timezone: 'America/New_York' }, deps),
      () => setAgentActive(agentCtx, other.id, false, deps),
      () => setAgentActive(agentCtx, agent.id, false, deps),
      () => setInAppCalling(agentCtx, other.id, false),
      () => setInAppCalling(agentCtx, agent.id, false),
      () => updateAgentProfile(agentCtx, agent.id, { dailyCallTarget: 999, timezone: 'Europe/Paris', name: 'x' }),
      () => updateAgentProfile(agentCtx, other.id, { name: 'Renamed' }),
      () => bulkReassign(agentCtx, { fromUserId: other.id, toUserId: agent.id }),
      () => reassignSelected(agentCtx, [otherLead.id], agent.id),
      () => reassignSelected(agentCtx, [agentLead.id], other.id),
      () => countReassignableLeads(agentCtx, other.id),
      () => getAgentActivity(agentCtx, other.id, 'today'),
      () => getAgentActivity(agentCtx, agent.id, 'today'),
      () => getAgentDeleteCheck(agentCtx, idle.id),
      () => deleteAgent(agentCtx, idle.id, deps),
      () => deleteAgent(agentCtx, agent.id, deps),
      () => updateCompanySettings(agentCtx, companyInput),
      () => updateAgentTarget(agentCtx, agent.id, 999),
      () => updateAgentTarget(agentCtx, other.id, 1),
    ];
    for (const call of calls) {
      const error = await call().then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('forbidden');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('the settings page data for an agent has no admin section', async () => {
    const data = await getSettingsPageData(agentCtx);
    expect(data.admin).toBeNull();
    expect(data.profile).toMatchObject({ userId: agent.id, role: 'AGENT', dailyCallTarget: 40, timezone: 'America/Chicago' });
  });

  it('a null context is unauthorized', async () => {
    await expect(listAgents(null)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(getSettingsPageData(null)).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('admin server actions refuse an agent', () => {
  const adminActionCalls: Array<[string, () => Promise<{ ok: boolean; error?: { code: string } }>]> = [
    ['createAgentAction', () => agentActions.createAgentAction({ name: 'Sneaky', email: probeEmail, dailyCallTarget: 50, timezone: 'America/New_York' })],
    ['setAgentActiveAction', () => agentActions.setAgentActiveAction(other.id, false)],
    ['setInAppCallingAction', () => agentActions.setInAppCallingAction(agent.id, false)],
    ['updateAgentProfileAction', () => agentActions.updateAgentProfileAction(agent.id, { dailyCallTarget: 999 })],
    ['countReassignableLeadsAction', () => agentActions.countReassignableLeadsAction(other.id)],
    ['bulkReassignAction', () => agentActions.bulkReassignAction({ fromUserId: other.id, toUserId: agent.id })],
    ['reassignSelectedAction', () => agentActions.reassignSelectedAction([otherLead.id], agent.id)],
    ['agentDeleteCheckAction', () => agentActions.agentDeleteCheckAction(idle.id)],
    ['deleteAgentAction', () => agentActions.deleteAgentAction(idle.id)],
    ['updateCompanySettingsAction', () => settingsActions.updateCompanySettingsAction(companyInput)],
    ['updateAgentTargetAction', () => settingsActions.updateAgentTargetAction(agent.id, 999)],
  ];

  it('covers every exported admin action', () => {
    const adminActions = new Set(adminActionCalls.map(([name]) => name));
    const selfService = new Set(['updateOwnNameAction', 'changePasswordAction', 'requestEmailChangeAction']);
    const exported = [...Object.keys(agentActions), ...Object.keys(settingsActions)].filter((name) => !selfService.has(name));
    expect(new Set(exported)).toEqual(adminActions);
  });

  it('every admin action returns forbidden for an agent session and changes nothing', async () => {
    mockedContext.mockResolvedValue(agentCtx);
    const before = await snapshot();
    for (const [name, call] of adminActionCalls) {
      const result = await call();
      expect(result, name).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('every action (admin and self-service) returns unauthorized without a session', async () => {
    mockedContext.mockResolvedValue(null);
    const calls = [
      ...adminActionCalls.map(([, call]) => call),
      () => settingsActions.updateOwnNameAction('Nobody'),
      () => settingsActions.changePasswordAction({ currentPassword: 'x', newPassword: 'long-enough-password' }),
      () => settingsActions.requestEmailChangeAction(uniqueEmail('nobody')),
    ];
    for (const call of calls) {
      expect(await call()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    }
  });

  it('an agent cannot change their own target, timezone or in-app flag through the self-service settings actions', async () => {
    mockedContext.mockResolvedValue(agentCtx);
    const before = await snapshot();
    // Extra fields are rejected by the Zod schemas, never passed on.
    const sneaky = { name: 'Still Me', daily_call_target: 999, timezone: 'Europe/Paris', in_app_calling_enabled: false, role: 'ADMIN' };
    expect(await settingsActions.updateOwnNameAction(sneaky as unknown as string)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(await settingsActions.updateAgentTargetAction(agent.id, 999)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await agentActions.setInAppCallingAction(agent.id, false)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await agentActions.updateAgentProfileAction(agent.id, { timezone: 'Europe/Paris' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await snapshot()).toEqual(before);

    // The only field an agent may change is the name.
    expect(await settingsActions.updateOwnNameAction('Renamed Agent')).toEqual({ ok: true, data: { name: 'Renamed Agent' } });
    const after = await snapshot();
    const mine = after.profiles?.find((p) => p.id === agent.id);
    expect(mine).toMatchObject({ name: 'Renamed Agent', role: 'AGENT', active: true, daily_call_target: 40, timezone: 'America/Chicago', in_app_calling_enabled: true });
  });
});
