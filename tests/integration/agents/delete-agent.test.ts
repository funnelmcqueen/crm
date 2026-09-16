// Admin "Delete agent" through the service layer against localbase with real sessions (docs/DEVIATIONS.md D40):
// access, blocked deletes with the counts in the message, the login closed for good (old access token, refresh
// token and password all dead), the original email reusable, history kept, a half-done Auth step kept visible and
// finished by deleting again, and a reactivation racing a delete never lifting the delete's ban.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import {
  createAgent,
  deleteAgent,
  deletedAuthEmail,
  getAgentDeleteCheck,
  listAgents,
  revokeAuthSessionsWith,
  setAgentActive,
  type AgentServiceDeps,
} from '@/server/services/agents';
import { listAgentsForFilter } from '@/server/services/leads';
import { anonClient, clientWithAccessToken, serviceClient } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { testStack } from '../../helpers/env';
import { createCall, createFollowUp, createLead, createPhoneNumber, createUser, type FixtureUser } from '../../helpers/fixtures';

const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000';

const deps: Partial<AgentServiceDeps> = {
  authAdmin: () => serviceClient(),
  revokeSessions: (userId) => revokeAuthSessionsWith(serviceClient(), userId),
};

const revokeFails: Partial<AgentServiceDeps> = {
  ...deps,
  revokeSessions: () => Promise.reject(new Error('auth is down')),
};

type UpdateUserAttributes = Parameters<ReturnType<typeof serviceClient>['auth']['admin']['updateUserById']>[1];

/** A service client whose Auth `updateUserById` runs `before` first; `before` may throw to fail the call. */
function authAdminWith(before: (id: string, attributes: UpdateUserAttributes) => Promise<void>): AgentServiceDeps['authAdmin'] {
  return () => {
    const client = serviceClient();
    const update = client.auth.admin.updateUserById.bind(client.auth.admin);
    client.auth.admin.updateUserById = async (id, attributes) => {
      await before(id, attributes);
      return update(id, attributes);
    };
    return client as unknown as ReturnType<AgentServiceDeps['authAdmin']>;
  };
}

const emailMoveFails: Partial<AgentServiceDeps> = {
  ...deps,
  authAdmin: authAdminWith(async (_id, attributes) => {
    if (attributes.email !== undefined) throw new Error('email rejected');
  }),
};

async function listedAs(userId: string) {
  const listed = await listAgents(adminCtx);
  return {
    row: listed.agents.find((agent) => agent.userId === userId) ?? null,
    reassignTarget: listed.reassignTargets.some((option) => option.userId === userId),
  };
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, `expected AppError(${code})`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

async function signIn(user: FixtureUser): Promise<SessionTokens> {
  const { data, error } = await anonClient().auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session) throw new Error(`sign-in failed for ${user.email}: ${error?.message ?? 'no session'}`);
  return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
}

async function canSignIn(email: string, password: string): Promise<boolean> {
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  return !error && data.session !== null;
}

/** The refresh grant over raw HTTP, so supabase-js storage and retries cannot mask the answer. */
async function refreshWorks(refreshToken: string): Promise<boolean> {
  const stack = testStack();
  const response = await fetch(`${stack.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return response.ok;
}

/** What getUser() in src/proxy.ts and src/server/context.ts asks Auth. */
async function getUserStatus(accessToken: string): Promise<number> {
  const stack = testStack();
  const response = await fetch(`${stack.url}/auth/v1/user`, {
    headers: { apikey: stack.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  return response.status;
}

async function profileRow(id: string) {
  const { data, error } = await serviceClient().from('profiles').select('active, deleted_at, name, email').eq('id', id).single();
  if (error || !data) throw new Error(`profile ${id}: ${error?.message ?? 'missing'}`);
  return data;
}

let admin: FixtureUser;
let adminCtx: RequestContext;
let owner: FixtureUser;

beforeAll(async () => {
  admin = await createUser({ role: 'ADMIN', name: 'Delete Admin' });
  adminCtx = await contextForUser(admin);
  owner = await createUser({ name: 'Lead Owner' });
});

describe('access', () => {
  it('agents and signed-out callers can neither check nor delete, and nothing changes', async () => {
    const agent = await createUser({ name: 'Curious Agent' });
    const target = await createUser({ name: 'Safe Target' });
    const agentCtx = await contextForUser(agent);

    await expectAppError(deleteAgent(agentCtx, target.id, deps), 'forbidden');
    await expectAppError(getAgentDeleteCheck(agentCtx, target.id), 'forbidden');
    await expectAppError(deleteAgent(null, target.id, deps), 'unauthorized');

    expect(await profileRow(target.id)).toMatchObject({ active: true, deleted_at: null, name: 'Safe Target' });
    expect(await canSignIn(target.email, target.password)).toBe(true);
  });

  it("refuses admins and the caller's own account", async () => {
    const other = await createUser({ role: 'ADMIN', name: 'Another Admin' });
    await expectAppError(deleteAgent(adminCtx, admin.id, deps), 'forbidden');
    await expectAppError(deleteAgent(adminCtx, other.id, deps), 'forbidden');
    expect(await canSignIn(other.email, other.password)).toBe(true);
  });

  it('answers unknown and malformed ids with not_found', async () => {
    for (const id of [UNKNOWN_USER_ID, 'nope', 42]) {
      await expectAppError(deleteAgent(adminCtx, id, deps), 'not_found');
      await expectAppError(getAgentDeleteCheck(adminCtx, id), 'not_found');
    }
  });
});

describe('blocked deletes', () => {
  it('names the leads and open follow-ups that must go first, and changes nothing', async () => {
    const target = await createUser({ name: 'Busy Agent' });
    await createLead({ assigned_to: target.id });
    await createLead({ assigned_to: target.id });
    const otherLead = await createLead({ assigned_to: owner.id });
    await createFollowUp({ lead_id: otherLead.id, user_id: target.id });

    expect(await getAgentDeleteCheck(adminCtx, target.id)).toMatchObject({
      leads: 2,
      openFollowUps: 1,
      deletable: false,
      reason: 'has_work',
    });
    const error = await expectAppError(deleteAgent(adminCtx, target.id, deps), 'conflict');
    expect(error.message).toBe("Reassign this agent's 2 leads and 1 open follow-up before deleting them.");

    expect(await profileRow(target.id)).toMatchObject({ active: true, deleted_at: null, name: 'Busy Agent' });
    expect(await canSignIn(target.email, target.password)).toBe(true);
  });
});

describe('deleting an agent', () => {
  it('closes the login for good, frees the email and keeps their history', async () => {
    const target = await createUser({ name: 'Leaving Agent' });
    const tokens = await signIn(target);
    const lead = await createLead({ assigned_to: owner.id });
    const call = await createCall({ lead_id: lead.id, user_id: target.id, outcome: 'CONNECTED', duration_seconds: 75 });
    const done = await createFollowUp({ lead_id: lead.id, user_id: target.id, completed_at: new Date().toISOString() });
    // Inactive, so this number never joins the caller-ID pool other test files rotate through once it is unassigned.
    const number = await createPhoneNumber({ assigned_to: target.id, active: false });

    expect(await getAgentDeleteCheck(adminCtx, target.id)).toMatchObject({
      deletable: true,
      reason: null,
      calls: 1,
      completedFollowUps: 1,
      phoneNumbers: 1,
    });

    expect(await deleteAgent(adminCtx, target.id, deps)).toEqual({
      userId: target.id,
      alreadyDeleted: false,
      phoneNumbersUnassigned: 1,
    });

    // The profile: deleted, inactive, labelled, and its email moved off the real address (synced from Auth).
    const after = await profileRow(target.id);
    expect(after.active).toBe(false);
    expect(after.deleted_at).not.toBeNull();
    expect(after.name).toBe('Leaving Agent (deleted)');
    expect(after.email).toBe(deletedAuthEmail(target.id));

    // The login: the open session is dead, its refresh token is useless, and the password signs in nowhere.
    expect(await getUserStatus(tokens.accessToken)).not.toBe(200);
    const { data: visible } = await clientWithAccessToken(tokens.accessToken).from('leads').select('id');
    expect(visible ?? []).toEqual([]);
    expect(await refreshWorks(tokens.refreshToken)).toBe(false);
    expect(await canSignIn(target.email, target.password)).toBe(false);
    expect(await canSignIn(deletedAuthEmail(target.id), target.password)).toBe(false);

    // History stays attributed to the deleted profile; the number is back in the pool.
    const service = serviceClient();
    expect((await service.from('calls').select('user_id').eq('id', call.id).single()).data).toEqual({ user_id: target.id });
    expect((await service.from('follow_ups').select('user_id').eq('id', done.id).single()).data).toEqual({ user_id: target.id });
    expect((await service.from('phone_numbers').select('assigned_to').eq('id', number.id).single()).data).toEqual({
      assigned_to: null,
    });

    // Gone from the agents list, every reassign picker built on it, and the lead and pipeline agent filter.
    expect(await listedAs(target.id)).toEqual({ row: null, reassignTarget: false });
    expect((await listAgentsForFilter(adminCtx)).some((option) => option.id === target.id)).toBe(false);

    // Never back: reactivation is refused, and the check reports the agent as deleted.
    await expectAppError(setAgentActive(adminCtx, target.id, true, deps), 'not_found');
    expect(await getAgentDeleteCheck(adminCtx, target.id)).toMatchObject({
      deleted: true,
      loginClosed: true,
      reason: 'deleted',
      deletable: false,
    });

    // The original address can be used for a new agent, who signs in normally.
    const again = await createAgent(
      adminCtx,
      { name: 'Returning Agent', email: target.email, dailyCallTarget: 40, timezone: 'America/Chicago' },
      deps,
    );
    expect(again.userId).not.toBe(target.id);
    expect(await canSignIn(target.email, again.password)).toBe(true);
  });

  it('keeps a delete whose sessions could not be ended on the list, and finishes it when deleted again', async () => {
    const target = await createUser({ name: 'Half Deleted' });
    const tokens = await signIn(target);

    const failed = await expectAppError(deleteAgent(adminCtx, target.id, revokeFails), 'unavailable');
    expect(failed.message).toBe(
      "They are removed from the CRM and can't sign in, but their open sessions could not be ended yet. Delete them again to finish.",
    );
    // The database half already happened, so the agent is out of the CRM and sees nothing; the ban and new
    // password came before the failing step, so the old password is already useless.
    expect(await profileRow(target.id)).toMatchObject({ active: false, name: 'Half Deleted (deleted)', email: target.email });
    const { data: visible } = await clientWithAccessToken(tokens.accessToken).from('leads').select('id');
    expect(visible ?? []).toEqual([]);
    expect(await canSignIn(target.email, target.password)).toBe(false);

    // The admin can still find it: listed as an unfinished delete, never as a reassign target.
    const listed = await listedAs(target.id);
    expect(listed.row).toMatchObject({ deletePending: true, active: false });
    expect(listed.reassignTarget).toBe(false);
    expect(await getAgentDeleteCheck(adminCtx, target.id)).toMatchObject({ deleted: true, loginClosed: false, reason: 'deleted' });

    expect(await deleteAgent(adminCtx, target.id, deps)).toMatchObject({ userId: target.id, alreadyDeleted: true });
    expect(await refreshWorks(tokens.refreshToken)).toBe(false);
    expect(await getUserStatus(tokens.accessToken)).not.toBe(200);
    expect(await getAgentDeleteCheck(adminCtx, target.id)).toMatchObject({ loginClosed: true });
    expect((await listedAs(target.id)).row).toBeNull();
  });

  it('closes the login before moving the email, so a rejected email change leaves no way back in', async () => {
    const target = await createUser({ name: 'Email Stuck' });
    const tokens = await signIn(target);

    const failed = await expectAppError(deleteAgent(adminCtx, target.id, emailMoveFails), 'unavailable');
    expect(failed.message).toBe(
      "They are signed out and can't sign in, but their email address could not be freed yet. Delete them again to finish.",
    );
    expect(await getUserStatus(tokens.accessToken)).not.toBe(200);
    expect(await refreshWorks(tokens.refreshToken)).toBe(false);
    expect(await canSignIn(target.email, target.password)).toBe(false);
    expect(await profileRow(target.id)).toMatchObject({ email: target.email });
    expect((await listedAs(target.id)).row).toMatchObject({ deletePending: true });

    await deleteAgent(adminCtx, target.id, deps);
    expect(await profileRow(target.id)).toMatchObject({ email: deletedAuthEmail(target.id) });
    expect((await listedAs(target.id)).row).toBeNull();
  });
});

describe('reactivating an agent while they are being deleted', () => {
  it('puts the permanent ban back and reports the agent as gone', async () => {
    const target = await createUser({ name: 'Racing Agent' });
    await setAgentActive(adminCtx, target.id, false, deps);

    // The delete lands between reactivation writing the flag and lifting the ban.
    const racing: Partial<AgentServiceDeps> = {
      ...deps,
      authAdmin: authAdminWith(async (id, attributes) => {
        if (attributes.ban_duration === 'none') await deleteAgent(adminCtx, id, deps);
      }),
    };
    await expectAppError(setAgentActive(adminCtx, target.id, true, racing), 'not_found');

    expect(await profileRow(target.id)).toMatchObject({ active: false });
    const { data, error } = await serviceClient().auth.admin.getUserById(target.id);
    expect(error).toBeNull();
    const bannedUntil = data.user?.banned_until ? new Date(data.user.banned_until).getTime() : 0;
    expect(bannedUntil).toBeGreaterThan(Date.now() + 365 * 86_400_000);
  });
});
