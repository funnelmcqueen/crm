// SPEC 5 "On disable, also ban the user in Supabase Auth" + docs/DEVIATIONS.md D31.
//
// The ban alone only blocks sign-in and token refresh *while it lasts*. Lifting it on reactivation used
// to make every cookie and refresh token issued before the disable work again, and src/proxy.ts then
// sent that session straight to /dashboard without re-authenticating. setAgentActive now ends the
// account's Auth sessions on both transitions, so a disabled agent's live session dies at once and a
// reactivated agent has to sign in again.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import { revokeAuthSessionsWith, setAgentActive, type AgentServiceDeps } from '@/server/services/agents';
import { anonClient, clientWithAccessToken, serviceClient } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { isLocalbaseStack, testStack } from '../../helpers/env';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

const UNKNOWN_USER_ID = '00000000-0000-4000-8000-000000000000';

const deps: Partial<AgentServiceDeps> = {
  authAdmin: () => serviceClient(),
  revokeSessions: (userId) => revokeAuthSessionsWith(serviceClient(), userId),
};

const revokeFails: Partial<AgentServiceDeps> = {
  ...deps,
  revokeSessions: () => Promise.reject(new Error('auth is down')),
};

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

async function trySignIn(user: FixtureUser): Promise<boolean> {
  const { data, error } = await anonClient().auth.signInWithPassword({ email: user.email, password: user.password });
  return !error && data.session !== null;
}

/**
 * The refresh grant over raw HTTP. supabase-js wraps it in its own storage, retry and lock handling,
 * which is exactly what this test must not go through: it asks whether *this* refresh token still works.
 */
async function refreshSession(refreshToken: string): Promise<{ status: number; tokens: SessionTokens | null }> {
  const stack = testStack();
  const response = await fetch(`${stack.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return { status: response.status, tokens: null };
  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token || !body.refresh_token) return { status: response.status, tokens: null };
  return { status: response.status, tokens: { accessToken: body.access_token, refreshToken: body.refresh_token } };
}

/** What `getUser()` does in src/proxy.ts and src/server/context.ts: ask Auth whether the token is a session. */
async function getUserStatus(accessToken: string): Promise<number> {
  const stack = testStack();
  const response = await fetch(`${stack.url}/auth/v1/user`, {
    headers: { apikey: stack.anonKey, Authorization: `Bearer ${accessToken}` },
  });
  return response.status;
}

async function leadsVisibleTo(accessToken: string): Promise<number> {
  const { data } = await clientWithAccessToken(accessToken).from('leads').select('id');
  return (data ?? []).length;
}

async function profileActive(userId: string): Promise<boolean> {
  const { data, error } = await serviceClient().from('profiles').select('active').eq('id', userId).single();
  if (error || !data) throw new Error(`profile ${userId}: ${error?.message ?? 'missing'}`);
  return data.active;
}

let adminCtx: RequestContext;

beforeAll(async () => {
  adminCtx = await contextForUser(await createUser({ role: 'ADMIN', name: 'Revocation Admin' }));
});

describe('setAgentActive ends existing Auth sessions', () => {
  it('kills the live session on disable, and reactivating does not bring it back', async () => {
    const agent = await createUser({ name: 'Session Agent' });
    const lead = await createLead({ assigned_to: agent.id });

    // A normal working session: the refresh token rotates and the access token sees the agent's lead.
    const signedIn = await signIn(agent);
    const rotated = await refreshSession(signedIn.refreshToken);
    expect(rotated.status).toBe(200);
    const live = rotated.tokens;
    if (!live) throw new Error('the refresh grant returned no tokens');
    expect(await getUserStatus(live.accessToken)).toBe(200);
    expect(await leadsVisibleTo(live.accessToken)).toBe(1);

    // --- disable ------------------------------------------------------------------------------
    await expect(setAgentActive(adminCtx, agent.id, false, deps)).resolves.toEqual({ userId: agent.id, active: false });
    expect(await profileActive(agent.id)).toBe(false);

    // The access token is no longer a session Auth knows about, so every app entry point rejects it...
    expect(await getUserStatus(live.accessToken)).not.toBe(200);
    // ...and RLS gives it nothing even if it reaches PostgREST directly.
    expect(await leadsVisibleTo(live.accessToken)).toBe(0);
    // The refresh token cannot mint a replacement.
    expect((await refreshSession(live.refreshToken)).status).toBe(400);
    expect(await trySignIn(agent)).toBe(false);

    // --- reactivate ---------------------------------------------------------------------------
    await expect(setAgentActive(adminCtx, agent.id, true, deps)).resolves.toEqual({ userId: agent.id, active: true });
    expect(await profileActive(agent.id)).toBe(true);

    // The point of the fix: the pre-disable session is gone for good. Both halves of it stay dead.
    expect((await refreshSession(live.refreshToken)).status).toBe(400);
    expect(await getUserStatus(live.accessToken)).not.toBe(200);

    // Signing in again works, and that new session is a complete one.
    const fresh = await signIn(agent);
    expect(await getUserStatus(fresh.accessToken)).toBe(200);
    expect(await leadsVisibleTo(fresh.accessToken)).toBe(1);
    const freshRotation = await refreshSession(fresh.refreshToken);
    expect(freshRotation.status).toBe(200);
    expect(freshRotation.tokens?.refreshToken).not.toBe(live.refreshToken);

    // The lead stayed with the agent through all of it.
    const owner = await serviceClient().from('leads').select('assigned_to').eq('id', lead.id).single();
    expect(owner.data?.assigned_to).toBe(agent.id);
  });

  it('does not unblock sign-in when the earlier sessions cannot be ended', async () => {
    const agent = await createUser({ name: 'Reactivate Revoke Fails' });
    const live = await signIn(agent);
    await setAgentActive(adminCtx, agent.id, false, deps);

    const error = await expectAppError(setAgentActive(adminCtx, agent.id, true, revokeFails), 'unavailable');
    expect(error.message).toContain('stays disabled');
    // Nothing was unblocked: the flag, the ban and the dead session all stay as they were.
    expect(await profileActive(agent.id)).toBe(false);
    expect(await trySignIn(agent)).toBe(false);
    expect((await refreshSession(live.refreshToken)).status).toBe(400);

    // Retrying once Auth answers again completes the reactivation.
    await expect(setAgentActive(adminCtx, agent.id, true, deps)).resolves.toEqual({ userId: agent.id, active: true });
    expect(await trySignIn(agent)).toBe(true);
  });

  it('keeps a disable that could not end the sessions, and the retry finishes it', async () => {
    const agent = await createUser({ name: 'Disable Revoke Fails' });
    const live = await signIn(agent);

    const error = await expectAppError(setAgentActive(adminCtx, agent.id, false, revokeFails), 'unavailable');
    expect(error.message).toContain('open sessions could not be ended');
    // The agent is disabled and banned regardless, so they are already cut off.
    expect(await profileActive(agent.id)).toBe(false);
    expect(await trySignIn(agent)).toBe(false);
    expect(await leadsVisibleTo(live.accessToken)).toBe(0);

    // Disabling is idempotent, so the obvious retry is also the fix.
    await expect(setAgentActive(adminCtx, agent.id, false, deps)).resolves.toEqual({ userId: agent.id, active: false });
    expect(await getUserStatus(live.accessToken)).not.toBe(200);
    expect((await refreshSession(live.refreshToken)).status).toBe(400);
  });

  it('leaves other users signed in', async () => {
    const [target, bystander] = await Promise.all([createUser({ name: 'Target' }), createUser({ name: 'Bystander' })]);
    const bystanderSession = await signIn(bystander);
    await signIn(target);

    await setAgentActive(adminCtx, target.id, false, deps);

    expect(await getUserStatus(bystanderSession.accessToken)).toBe(200);
    expect((await refreshSession(bystanderSession.refreshToken)).status).toBe(200);
  });
});

// Hosted Supabase Auth has no admin route that signs a user out by id, so revoke_user_sessions (which
// deletes the user's auth.sessions rows) is the only way the app ends someone else's sessions. It must
// be reachable by the service role alone.
describe('revoke_user_sessions', () => {
  it("needs the service role, ends only that user's sessions, and has nothing to revoke for an unknown user", async () => {
    const [agent, bystander] = await Promise.all([createUser({ name: 'Rpc Shape' }), createUser({ name: 'Rpc Bystander' })]);
    const session = await signIn(agent);
    const bystanderSession = await signIn(bystander);

    for (const client of [anonClient(), clientWithAccessToken(session.accessToken)]) {
      const { error } = await client.rpc('revoke_user_sessions', { p_user_id: agent.id });
      expect(error?.code).toBe('42501');
    }
    // Those refusals really left the session alone.
    expect(await getUserStatus(session.accessToken)).toBe(200);

    await expect(revokeAuthSessionsWith(serviceClient(), UNKNOWN_USER_ID)).resolves.toBeUndefined();
    await expect(revokeAuthSessionsWith(serviceClient(), agent.id)).resolves.toBeUndefined();
    expect(await getUserStatus(session.accessToken)).not.toBe(200);
    expect((await refreshSession(session.refreshToken)).status).not.toBe(200);
    expect(await getUserStatus(bystanderSession.accessToken)).toBe(200);
    // Ending sessions is not a ban: the agent can sign in again.
    expect(await trySignIn(agent)).toBe(true);
  });
});

// localbase must not answer routes hosted Supabase Auth does not have: a by-id sessions route that only
// localbase served is what hid D31's production failure.
describe.runIf(isLocalbaseStack())('localbase Auth', () => {
  it('does not serve DELETE /auth/v1/admin/users/:id/sessions', async () => {
    const stack = testStack();
    const response = await fetch(`${stack.url}/auth/v1/admin/users/${UNKNOWN_USER_ID}/sessions`, {
      method: 'DELETE',
      headers: { apikey: stack.serviceRoleKey, Authorization: `Bearer ${stack.serviceRoleKey}` },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('user_not_found');
  });
});
