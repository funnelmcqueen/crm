// Stage 10a admin agent services against localbase with real sessions: create, disable/reactivate with the
// Auth ban, in-app flag, profile edits, bulk reassignment and the drill-down. The service role is used only as
// the Auth admin client (what createAdminClient() provides in the app) and to arrange/inspect fixtures.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import {
  bulkReassign,
  countReassignableLeads,
  createAgent,
  getAgentActivity,
  listAgents,
  reassignSelected,
  setAgentActive,
  setInAppCalling,
  updateAgentProfile,
  type AgentServiceDeps,
} from '@/server/services/agents';
import { clientWithAccessToken, serviceClient, signInAs, trySignIn } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import {
  createCall,
  createFollowUp,
  createLead,
  createUser,
  fictionalPhone,
  uniqueEmail,
  type FixtureUser,
} from '../../helpers/fixtures';

const deps: Partial<AgentServiceDeps> = { authAdmin: () => serviceClient() };

async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, `expected AppError(${code})`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

async function profileRow(id: string) {
  const { data, error } = await serviceClient()
    .from('profiles')
    .select('id, email, name, role, active, daily_call_target, timezone, in_app_calling_enabled')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`profile ${id}: ${error?.message ?? 'missing'}`);
  return data;
}

async function leadOwner(id: string) {
  const { data, error } = await serviceClient().from('leads').select('assigned_to').eq('id', id).single();
  if (error || !data) throw new Error(`lead ${id}: ${error?.message ?? 'missing'}`);
  return data.assigned_to;
}

let admin: FixtureUser;
let adminCtx: RequestContext;

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN', name: 'Agents Admin', timezone: 'America/Denver' });
  adminCtx = await contextForUser(admin);
});

describe('createAgent', () => {
  it('creates an AGENT profile with the form values that can sign in with the one-time password', async () => {
    const email = uniqueEmail('Created Agent');
    const result = await createAgent(
      adminCtx,
      { name: '  New Hire  ', email: email.toUpperCase(), dailyCallTarget: 65, timezone: 'America/Chicago' },
      deps,
    );

    expect(result).toMatchObject({ name: 'New Hire', email, warning: null });
    expect(result.password.length).toBeGreaterThanOrEqual(20);

    expect(await profileRow(result.userId)).toMatchObject({
      email,
      name: 'New Hire',
      role: 'AGENT',
      active: true,
      daily_call_target: 65,
      timezone: 'America/Chicago',
      in_app_calling_enabled: true,
    });

    const session = await signInAs(email, result.password);
    expect(session.userId).toBe(result.userId);
    expect((await session.client.rpc('is_admin')).data).toBe(false);

    const list = await listAgents(adminCtx);
    expect(list.agents.find((a) => a.userId === result.userId)).toMatchObject({ name: 'New Hire', active: true, leadsAssigned: 0 });
  });

  it('generates a different password for every agent', async () => {
    const [a, b] = await Promise.all([
      createAgent(adminCtx, { name: 'Pw A', email: uniqueEmail('pw-a'), dailyCallTarget: 50, timezone: 'America/New_York' }, deps),
      createAgent(adminCtx, { name: 'Pw B', email: uniqueEmail('pw-b'), dailyCallTarget: 50, timezone: 'America/New_York' }, deps),
    ]);
    expect(a.password).not.toBe(b.password);
  });

  it('reports a duplicate email as a conflict', async () => {
    const existing = await createUser({ name: 'Already Here' });
    const error = await expectAppError(
      createAgent(adminCtx, { name: 'Dup', email: existing.email, dailyCallTarget: 50, timezone: 'America/New_York' }, deps),
      'conflict',
    );
    expect(error.message).toBe('An account with this email already exists.');
    expect((await profileRow(existing.id)).name).toBe('Already Here');
  });

  it('validates the timezone, target and email before creating anything', async () => {
    const email = uniqueEmail('invalid-agent');
    for (const input of [
      { name: 'Tz', email, dailyCallTarget: 50, timezone: 'Mars/Olympus' },
      { name: 'Tz', email, dailyCallTarget: 50, timezone: 'utc' },
      { name: 'Target', email, dailyCallTarget: 1001, timezone: 'America/New_York' },
      { name: 'Target', email, dailyCallTarget: 1.5, timezone: 'America/New_York' },
      { name: '', email, dailyCallTarget: 50, timezone: 'America/New_York' },
      { name: 'Email', email: 'not-an-email', dailyCallTarget: 50, timezone: 'America/New_York' },
    ]) {
      await expectAppError(
        createAgent(adminCtx, input, deps).catch((err: unknown) => {
          throw err instanceof AppError ? err : new AppError('validation');
        }),
        'validation',
      );
    }
    const { data } = await serviceClient().from('profiles').select('id').eq('email', email);
    expect(data).toEqual([]);
  });
});

describe('setAgentActive', () => {
  it('disables: profile inactive, sign-in refused, a still-valid token sees zero rows; reactivating restores sign-in', async () => {
    const agent = await createUser({ name: 'Disable Me' });
    const lead = await createLead({ assigned_to: agent.id });
    const before = await signInAs(agent.email, agent.password);
    expect((await before.client.from('leads').select('id').eq('id', lead.id)).data).toHaveLength(1);

    await expect(setAgentActive(adminCtx, agent.id, false, deps)).resolves.toEqual({ userId: agent.id, active: false });
    expect((await profileRow(agent.id)).active).toBe(false);

    const refused = await trySignIn(agent.email, agent.password);
    expect(refused.user).toBeNull();

    const stale = clientWithAccessToken(before.accessToken);
    expect((await stale.from('leads').select('id')).data ?? []).toEqual([]);
    expect((await stale.from('profiles').select('id')).data ?? []).toEqual([]);
    // Leads stay assigned until an admin reassigns them.
    expect(await leadOwner(lead.id)).toBe(agent.id);

    const list = await listAgents(adminCtx);
    expect(list.disabledWithLeads.agents).toContainEqual({ userId: agent.id, name: 'Disable Me', leadsAssigned: 1 });
    expect(list.disabledWithLeads.leadCount).toBeGreaterThanOrEqual(1);
    expect(list.reassignTargets.map((t) => t.userId)).not.toContain(agent.id);

    await expect(setAgentActive(adminCtx, agent.id, true, deps)).resolves.toEqual({ userId: agent.id, active: true });
    expect((await profileRow(agent.id)).active).toBe(true);
    const again = await signInAs(agent.email, agent.password);
    expect((await again.client.from('leads').select('id').eq('id', lead.id)).data).toHaveLength(1);
  });

  it('is idempotent and re-applies the ban when the profile is already disabled', async () => {
    const agent = await createUser();
    await setAgentActive(adminCtx, agent.id, false, deps);
    await expect(setAgentActive(adminCtx, agent.id, false, deps)).resolves.toEqual({ userId: agent.id, active: false });
    expect((await trySignIn(agent.email, agent.password)).user).toBeNull();
  });

  it('rolls the profile flag back when the Auth ban fails', async () => {
    const agent = await createUser({ name: 'Ban Fails' });
    const failingAuth = () => {
      const client = serviceClient();
      client.auth.admin.updateUserById = async () => ({
        data: { user: null },
        error: Object.assign(new Error('auth down'), { status: 500, code: 'unexpected_failure' }),
      }) as never;
      return client;
    };
    const error = await expectAppError(setAgentActive(adminCtx, agent.id, false, { authAdmin: failingAuth }), 'unavailable');
    expect(error.message).toContain('stays active');
    expect((await profileRow(agent.id)).active).toBe(true);
    await expect(signInAs(agent.email, agent.password)).resolves.toBeTruthy();

    await setAgentActive(adminCtx, agent.id, false, deps);
    const reactivate = await expectAppError(setAgentActive(adminCtx, agent.id, true, { authAdmin: failingAuth }), 'unavailable');
    expect(reactivate.message).toContain('stays disabled');
    expect((await profileRow(agent.id)).active).toBe(false);
    expect((await trySignIn(agent.email, agent.password)).user).toBeNull();
  });

  it('an admin cannot disable themselves', async () => {
    const self = await createUser({ role: 'ADMIN' });
    const ctx = await contextForUser(self);
    await expectAppError(setAgentActive(ctx, self.id, false, deps), 'forbidden');
    expect((await profileRow(self.id)).active).toBe(true);
    await expect(signInAs(self.email, self.password)).resolves.toBeTruthy();
    // profiles_guard blocks it in the database too.
    const direct = await ctx.supabase.from('profiles').update({ active: false }).eq('id', self.id).select('id');
    expect(direct.error?.code).toBe('42501');
  });

  it('unknown and malformed ids are not_found without touching Auth', async () => {
    let authCalls = 0;
    const counting = () => {
      authCalls += 1;
      return serviceClient();
    };
    await expectAppError(setAgentActive(adminCtx, '00000000-0000-4000-8000-000000000000', false, { authAdmin: counting }), 'not_found');
    await expectAppError(setAgentActive(adminCtx, 'nope', false, { authAdmin: counting }), 'not_found');
    expect(authCalls).toBe(0);
  });
});

describe('profile edits', () => {
  it('toggles in-app calling and edits name, target and timezone', async () => {
    const agent = await createUser({ name: 'Edit Me' });
    await expect(setInAppCalling(adminCtx, agent.id, false)).resolves.toEqual({ userId: agent.id, inAppCallingEnabled: false });
    expect((await profileRow(agent.id)).in_app_calling_enabled).toBe(false);

    await expect(
      updateAgentProfile(adminCtx, agent.id, { name: 'Edited', dailyCallTarget: 80, timezone: 'Europe/London' }),
    ).resolves.toEqual({ userId: agent.id, name: 'Edited', dailyCallTarget: 80, timezone: 'Europe/London' });
    expect(await profileRow(agent.id)).toMatchObject({ name: 'Edited', daily_call_target: 80, timezone: 'Europe/London' });

    await expect(updateAgentProfile(adminCtx, agent.id, { dailyCallTarget: 0 })).resolves.toMatchObject({ dailyCallTarget: 0 });
  });

  it('rejects invalid values, unknown fields and unknown ids', async () => {
    const agent = await createUser();
    await expect(updateAgentProfile(adminCtx, agent.id, { timezone: 'Nowhere/Land' })).rejects.toThrow();
    await expect(updateAgentProfile(adminCtx, agent.id, {})).rejects.toThrow();
    await expect(updateAgentProfile(adminCtx, agent.id, { role: 'ADMIN' })).rejects.toThrow();
    expect((await profileRow(agent.id)).role).toBe('AGENT');
    await expectAppError(updateAgentProfile(adminCtx, '00000000-0000-4000-8000-000000000000', { name: 'Ghost' }), 'not_found');
    await expectAppError(setInAppCalling(adminCtx, '00000000-0000-4000-8000-000000000000', true), 'not_found');
  });
});

describe('reassignment', () => {
  it('bulk reassigns every lead of an agent with open follow-ups; history and completed follow-ups stay', async () => {
    const [from, to] = await Promise.all([createUser({ name: 'From Agent' }), createUser({ name: 'To Agent' })]);
    const leads = await Promise.all([
      createLead({ assigned_to: from.id, status: 'NEW' }),
      createLead({ assigned_to: from.id, status: 'INTERESTED' }),
      createLead({ assigned_to: from.id, status: 'CLIENT' }),
    ]);
    const open = await createFollowUp({ lead_id: leads[0].id, user_id: from.id });
    const done = await createFollowUp({ lead_id: leads[0].id, user_id: from.id, completed_at: new Date().toISOString() });
    const history = await createCall({ lead_id: leads[1].id, user_id: from.id, outcome: 'INTERESTED', duration_seconds: 90 });

    await expect(countReassignableLeads(adminCtx, from.id)).resolves.toEqual({ count: 3 });
    await expect(bulkReassign(adminCtx, { fromUserId: from.id, toUserId: to.id })).resolves.toEqual({ count: 3 });

    for (const lead of leads) expect(await leadOwner(lead.id)).toBe(to.id);
    const service = serviceClient();
    const followUps = await service.from('follow_ups').select('id, user_id').in('id', [open.id, done.id]);
    expect(Object.fromEntries((followUps.data ?? []).map((f) => [f.id, f.user_id]))).toEqual({ [open.id]: to.id, [done.id]: from.id });
    const call = await service.from('calls').select('user_id, lead_id').eq('id', history.id).single();
    expect(call.data).toEqual({ user_id: from.id, lead_id: leads[1].id });

    const toSession = await signInAs(to.email, to.password);
    expect((await toSession.client.from('leads').select('id').in('id', leads.map((l) => l.id))).data).toHaveLength(3);
    const fromSession = await signInAs(from.email, from.password);
    expect((await fromSession.client.from('leads').select('id').in('id', leads.map((l) => l.id))).data).toEqual([]);
    await expect(countReassignableLeads(adminCtx, from.id)).resolves.toEqual({ count: 0 });
  });

  it('filters by status, unassigns with a null target, and works from a disabled agent', async () => {
    const from = await createUser({ name: 'Leaving Agent' });
    const keep = await createLead({ assigned_to: from.id, status: 'CLIENT' });
    const move = await createLead({ assigned_to: from.id, status: 'NO_ANSWER' });
    await setAgentActive(adminCtx, from.id, false, deps);

    await expect(countReassignableLeads(adminCtx, from.id, ['NO_ANSWER', 'VOICEMAIL'])).resolves.toEqual({ count: 1 });
    await expect(bulkReassign(adminCtx, { fromUserId: from.id, toUserId: null, statuses: ['NO_ANSWER', 'VOICEMAIL'] })).resolves.toEqual({
      count: 1,
    });
    expect(await leadOwner(move.id)).toBeNull();
    expect(await leadOwner(keep.id)).toBe(from.id);
  });

  it('moves more leads than one reassign_leads chunk', async () => {
    const [from, to] = await Promise.all([createUser(), createUser()]);
    const service = serviceClient();
    const rows = Array.from({ length: 520 }, (_, i) => ({
      business_name: `Chunk Lead ${i}`,
      phone: fictionalPhone(),
      assigned_to: from.id,
    }));
    const inserted = await service.from('leads').insert(rows).select('id');
    expect(inserted.error).toBeNull();
    await expect(bulkReassign(adminCtx, { fromUserId: from.id, toUserId: to.id })).resolves.toEqual({ count: 520 });
    await expect(countReassignableLeads(adminCtx, to.id)).resolves.toEqual({ count: 520 });
  });

  it('refuses inactive or identical targets and reassigns selected leads', async () => {
    const [from, to, gone] = await Promise.all([createUser(), createUser(), createUser({ active: false })]);
    const [l1, l2] = await Promise.all([createLead({ assigned_to: from.id }), createLead({ assigned_to: from.id })]);
    await expectAppError(bulkReassign(adminCtx, { fromUserId: from.id, toUserId: gone.id }), 'validation');
    await expect(bulkReassign(adminCtx, { fromUserId: from.id, toUserId: from.id })).rejects.toThrow();
    expect(await leadOwner(l1.id)).toBe(from.id);

    await expect(reassignSelected(adminCtx, [l1.id], to.id)).resolves.toEqual({ count: 1 });
    expect(await leadOwner(l1.id)).toBe(to.id);
    expect(await leadOwner(l2.id)).toBe(from.id);
    await expect(reassignSelected(adminCtx, [], to.id)).rejects.toThrow();
  });
});

describe('getAgentActivity', () => {
  it("returns today's stats in the agent's own timezone, null for unknown or malformed ids", async () => {
    // The admin is in America/Denver, so a Chicago agent proves whose day the range uses.
    const agent = await createUser({ name: 'Busy Agent', timezone: 'America/Chicago' });
    const lead = await createLead({ assigned_to: agent.id, status: 'CLIENT', business_name: 'Activity Co' });
    await createCall({ lead_id: lead.id, user_id: agent.id, outcome: 'APPOINTMENT', duration_seconds: 240 });
    await createCall({ lead_id: lead.id, user_id: agent.id, outcome: 'NO_ANSWER', duration_seconds: 0 });

    const activity = await getAgentActivity(adminCtx, agent.id, 'today');
    expect(activity).not.toBeNull();
    expect(activity?.profile).toMatchObject({ userId: agent.id, name: 'Busy Agent', role: 'AGENT', leadsAssigned: 1, clients: 1 });
    expect(activity?.range).toMatchObject({ key: 'today', timezone: 'America/Chicago' });
    expect(activity?.stats).toMatchObject({
      dials: 2,
      connected: 1,
      connectRate: 0.5,
      appointments: 1,
      talkSeconds: 240,
      avgCallSeconds: 240,
      clients: 1,
    });
    expect(activity?.outcomes).toEqual({ APPOINTMENT: 1, NO_ANSWER: 1 });
    expect(activity?.recentCalls.map((c) => c.businessName)).toEqual(['Activity Co', 'Activity Co']);

    await expect(getAgentActivity(adminCtx, '00000000-0000-4000-8000-000000000000', '7d')).resolves.toBeNull();
    await expect(getAgentActivity(adminCtx, 'not-a-uuid', '30d')).resolves.toBeNull();
  });
});
