// Settings services with real sessions: own name, password change (verified with a throwaway client), email
// change (applied immediately on localbase, D10), admin targets and company settings.
// Company settings are a single shared row that other files compare, so the successful write runs against a
// private in-memory localbase; the shared stack only sees refused writes.
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import { PROFILE_COLUMNS, type RequestContext } from '@/server/context';
import { AppError } from '@/server/errors';
import {
  changePassword,
  getSettingsPageData,
  requestEmailChange,
  updateAgentTarget,
  updateCompanySettings,
  updateOwnName,
  type SettingsServiceDeps,
} from '@/server/services/settings';
import { startLocalbase, type Localbase } from '../../../localbase/server';
import { anonClient, serviceClient, signInAs, trySignIn } from '../../helpers/clients';
import { contextForUser } from '../../helpers/context';
import { createUser, uniqueEmail, type FixtureUser } from '../../helpers/fixtures';
import { REPO_ROOT } from '../../helpers/pglite';

const deps: Partial<SettingsServiceDeps> = {
  createVerifierClient: () => anonClient(),
  appBaseUrl: () => 'https://crm.example.test',
};

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
    .select('email, name, role, active, daily_call_target, timezone, in_app_calling_enabled')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`profile ${id}: ${error?.message ?? 'missing'}`);
  return data;
}

let admin: FixtureUser;
let adminCtx: RequestContext;
let agent: FixtureUser;
let agentCtx: RequestContext;

beforeAll(async () => {
  [admin, agent] = await Promise.all([
    createUser({ role: 'ADMIN', name: 'Settings Admin' }),
    createUser({ name: 'Settings Agent', dailyCallTarget: 45, timezone: 'America/Los_Angeles', inAppCallingEnabled: false }),
  ]);
  [adminCtx, agentCtx] = await Promise.all([contextForUser(admin), contextForUser(agent)]);
});

describe('getSettingsPageData', () => {
  it('gives an agent only their own profile fields', async () => {
    const data = await getSettingsPageData(agentCtx);
    expect(data).toEqual({
      profile: {
        userId: agent.id,
        name: 'Settings Agent',
        email: agent.email,
        role: 'AGENT',
        dailyCallTarget: 45,
        timezone: 'America/Los_Angeles',
        inAppCallingEnabled: false,
      },
      admin: null,
    });
  });

  it('gives an admin the company settings and every agent target', async () => {
    const data = await getSettingsPageData(adminCtx);
    expect(data.profile).toMatchObject({ userId: admin.id, role: 'ADMIN' });
    expect(data.admin?.company.companyName).toEqual(expect.any(String));
    expect(data.admin?.company.voicemailGreeting).toEqual(expect.any(String));
    expect(data.admin?.agentTargets).toContainEqual({
      userId: agent.id,
      name: 'Settings Agent',
      email: agent.email,
      active: true,
      dailyCallTarget: 45,
    });
    expect(data.admin?.agentTargets.some((row) => row.userId === admin.id)).toBe(false);
  });
});

describe('updateOwnName', () => {
  it('lets an agent rename themselves and nothing else', async () => {
    const own = await createUser({ name: 'Old Name', dailyCallTarget: 33 });
    const ctx = await contextForUser(own);
    await expect(updateOwnName(ctx, '  New Name  ')).resolves.toEqual({ name: 'New Name' });
    expect(await profileRow(own.id)).toMatchObject({ name: 'New Name', role: 'AGENT', active: true, daily_call_target: 33 });
  });

  it('rejects blank, long and non-string names', async () => {
    await expect(updateOwnName(agentCtx, '   ')).rejects.toThrow();
    await expect(updateOwnName(agentCtx, 'x'.repeat(201))).rejects.toThrow();
    await expect(updateOwnName(agentCtx, { name: 'Obj', daily_call_target: 1 })).rejects.toThrow();
    expect((await profileRow(agent.id)).name).toBe('Settings Agent');
  });

  it('the database still refuses an agent who writes other profile columns directly', async () => {
    for (const patch of [{ daily_call_target: 999 }, { timezone: 'Europe/Paris' }, { in_app_calling_enabled: true }, { role: 'ADMIN' as const }, { active: false }]) {
      const result = await agentCtx.supabase.from('profiles').update(patch).eq('id', agent.id).select('id');
      expect(result.error?.code).toBe('42501');
    }
    expect(await profileRow(agent.id)).toMatchObject({
      role: 'AGENT',
      active: true,
      daily_call_target: 45,
      timezone: 'America/Los_Angeles',
      in_app_calling_enabled: false,
    });
  });
});

describe('changePassword', () => {
  it('fails with a wrong current password and keeps the old one working', async () => {
    const user = await createUser();
    const ctx = await contextForUser(user);
    const error = await expectAppError(
      changePassword(ctx, { currentPassword: 'definitely-wrong-1', newPassword: 'Brand-new-pass-2026' }, deps),
      'validation',
    );
    expect(error.message).toBe('Your current password is incorrect.');
    await expect(signInAs(user.email, user.password)).resolves.toBeTruthy();
    expect((await trySignIn(user.email, 'Brand-new-pass-2026')).user).toBeNull();
  });

  it('changes the password with the correct current one', async () => {
    const user = await createUser();
    const ctx = await contextForUser(user);
    await expect(
      changePassword(ctx, { currentPassword: user.password, newPassword: 'Brand-new-pass-2026' }, deps),
    ).resolves.toEqual({ changed: true });
    await expect(signInAs(user.email, 'Brand-new-pass-2026')).resolves.toBeTruthy();
    expect((await trySignIn(user.email, user.password)).user).toBeNull();
  });

  it('requires at least 10 characters before contacting Auth', async () => {
    let verifierCreated = false;
    const user = await createUser();
    const ctx = await contextForUser(user);
    await expect(
      changePassword(ctx, { currentPassword: user.password, newPassword: 'short1' }, {
        createVerifierClient: () => {
          verifierCreated = true;
          return anonClient();
        },
      }),
    ).rejects.toThrow('Use at least 10 characters.');
    expect(verifierCreated).toBe(false);
    await expect(signInAs(user.email, user.password)).resolves.toBeTruthy();
  });

  it('cannot use another user\'s password to pass the check', async () => {
    const [user, other] = await Promise.all([createUser(), createUser({ password: 'Other-users-pass-2026' })]);
    const ctx = await contextForUser(user);
    await expectAppError(
      changePassword(ctx, { currentPassword: other.password, newPassword: 'Brand-new-pass-2026' }, deps),
      'validation',
    );
    await expect(signInAs(user.email, user.password)).resolves.toBeTruthy();
  });
});

describe('requestEmailChange', () => {
  it('changes the email (immediately on localbase) and syncs the profile', async () => {
    const user = await createUser();
    const ctx = await contextForUser(user);
    const next = uniqueEmail('changed-email');
    const result = await requestEmailChange(ctx, next.toUpperCase(), deps);
    if (result.pending) {
      // A real Supabase stack sends confirmation links instead.
      expect(result.email).toBe(user.email);
      return;
    }
    expect(result).toEqual({ email: next, pending: false });
    expect((await profileRow(user.id)).email).toBe(next);
    await expect(signInAs(next, user.password)).resolves.toBeTruthy();
  });

  it('refuses the current address, invalid input and an address another account uses, without saying whose', async () => {
    const [user, other] = await Promise.all([createUser(), createUser()]);
    const ctx = await contextForUser(user);
    await expectAppError(requestEmailChange(ctx, user.email, deps), 'validation');
    await expect(requestEmailChange(ctx, 'not an email', deps)).rejects.toThrow();
    const taken = await expectAppError(requestEmailChange(ctx, other.email, deps), 'validation');
    expect(taken.message).toBe("That email address can't be used. Try a different one.");
    expect(taken.message).not.toContain(other.email);
    expect((await profileRow(user.id)).email).toBe(user.email);
  });
});

describe('updateAgentTarget', () => {
  it('lets an admin set an agent target within 0..1000', async () => {
    const target = await createUser({ dailyCallTarget: 50 });
    await expect(updateAgentTarget(adminCtx, target.id, 120)).resolves.toEqual({ userId: target.id, dailyCallTarget: 120 });
    expect((await profileRow(target.id)).daily_call_target).toBe(120);
    await expect(updateAgentTarget(adminCtx, target.id, 1001)).rejects.toThrow();
    await expect(updateAgentTarget(adminCtx, target.id, -5)).rejects.toThrow();
    expect((await profileRow(target.id)).daily_call_target).toBe(120);
    await expectAppError(updateAgentTarget(adminCtx, '00000000-0000-4000-8000-000000000000', 10), 'not_found');
    await expectAppError(updateAgentTarget(adminCtx, 'bogus', 10), 'not_found');
  });

  it('is forbidden for an agent, including on their own profile', async () => {
    await expectAppError(updateAgentTarget(agentCtx, agent.id, 999), 'forbidden');
    expect((await profileRow(agent.id)).daily_call_target).toBe(45);
  });
});

describe('updateCompanySettings on the shared stack (refused writes only)', () => {
  it('is forbidden for an agent and validates the greeting length for an admin, without writing', async () => {
    const service = serviceClient();
    const before = (await service.from('settings').select('*').single()).data;
    const input = {
      company_name: 'Never Saved Co',
      default_daily_target: 10,
      default_timezone: 'America/Chicago',
      voicemail_greeting: 'Hi',
    };
    await expectAppError(updateCompanySettings(agentCtx, input), 'forbidden');
    await expect(updateCompanySettings(adminCtx, { ...input, voicemail_greeting: 'a'.repeat(501) })).rejects.toThrow(
      'The voicemail greeting can be at most 500 characters.',
    );
    await expect(updateCompanySettings(adminCtx, { ...input, default_timezone: 'Nope/Nope' })).rejects.toThrow();
    await expect(updateCompanySettings(adminCtx, { ...input, updated_at: '2020-01-01' })).rejects.toThrow();
    expect((await service.from('settings').select('*').single()).data).toEqual(before);
  });
});

describe('updateCompanySettings on a private stack', () => {
  let lb: Localbase;
  let privateAdmin: RequestContext;
  let privateAgent: RequestContext;

  async function privateContext(role: 'ADMIN' | 'AGENT'): Promise<RequestContext> {
    const service = createClient<Database>(lb.url, lb.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = uniqueEmail(`private-${role}`);
    const password = 'Private-stack-pass-2026';
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: role } });
    if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'createUser failed');
    const updated = await service.from('profiles').update({ role }).eq('id', created.data.user.id).select('id');
    if (updated.error) throw new Error(updated.error.message);
    const client = createClient<Database>(lb.url, lb.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.user) throw new Error(signIn.error?.message ?? 'sign-in failed');
    const profile = await client.from('profiles').select(PROFILE_COLUMNS).eq('id', signIn.data.user.id).single();
    if (profile.error || !profile.data) throw new Error(profile.error?.message ?? 'profile missing');
    return { supabase: client, userId: signIn.data.user.id, profile: profile.data };
  }

  beforeAll(async () => {
    lb = await startLocalbase({ port: 0, silent: true, migrationsDir: path.join(REPO_ROOT, 'supabase', 'migrations') });
    [privateAdmin, privateAgent] = await Promise.all([privateContext('ADMIN'), privateContext('AGENT')]);
  });

  afterAll(async () => {
    await lb?.stop();
  });

  it('saves every field for an admin; agents still cannot read the row', async () => {
    const greeting = 'g'.repeat(500);
    await expect(
      updateCompanySettings(privateAdmin, {
        company_name: '  Racing Leads LLC ',
        default_daily_target: 75,
        default_timezone: 'America/Chicago',
        voicemail_greeting: greeting,
      }),
    ).resolves.toEqual({
      companyName: 'Racing Leads LLC',
      defaultDailyTarget: 75,
      defaultTimezone: 'America/Chicago',
      voicemailGreeting: greeting,
    });

    const page = await getSettingsPageData(privateAdmin);
    expect(page.admin?.company).toEqual({
      companyName: 'Racing Leads LLC',
      defaultDailyTarget: 75,
      defaultTimezone: 'America/Chicago',
      voicemailGreeting: greeting,
    });
    expect((await privateAgent.supabase.from('settings').select('company_name')).data).toEqual([]);
    expect((await privateAgent.supabase.rpc('get_company_name')).data).toBe('Racing Leads LLC');
    await expectAppError(
      updateCompanySettings(privateAgent, {
        company_name: 'Agent Co',
        default_daily_target: 1,
        default_timezone: 'America/Chicago',
        voicemail_greeting: 'x',
      }),
      'forbidden',
    );
    expect((await getSettingsPageData(privateAdmin)).admin?.company.companyName).toBe('Racing Leads LLC');
  });
});
