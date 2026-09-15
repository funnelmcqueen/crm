import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Localbase } from '../../localbase/server';
import {
  FIXTURE_SQL,
  PASSWORD,
  createConfirmedUser,
  decodeJwtPayload,
  makeClient,
  raw,
  serviceClient,
  signedInClient,
  startTestLocalbase,
} from './helpers';

let lb: Localbase;
let service: SupabaseClient;

beforeAll(async () => {
  lb = await startTestLocalbase();
  await lb.db.exec(FIXTURE_SQL);
  service = serviceClient(lb);
});

afterAll(async () => {
  await lb?.stop();
});

describe('public endpoints', () => {
  it('health and settings', async () => {
    const health = await raw(lb, '/auth/v1/health');
    expect(health.status).toBe(200);
    const settings = await raw(lb, '/auth/v1/settings');
    expect(settings.json()).toMatchObject({ disable_signup: true });
  });

  it('signup is disabled', async () => {
    const { data, error } = await makeClient(lb).auth.signUp({ email: 'new@auth.test', password: PASSWORD });
    expect(data.user).toBeNull();
    expect(error).toMatchObject({ code: 'signup_disabled', status: 422 });
  });

  it('uses the legacy error body without the API version header', async () => {
    const res = await raw(lb, '/auth/v1/signup', { method: 'POST', body: '{}' });
    expect(res.status).toBe(422);
    expect(res.json()).toEqual({ code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' });
  });
});

describe('admin users', () => {
  it('creates users with identities and fires auth.users triggers', async () => {
    const { data, error } = await service.auth.admin.createUser({
      email: 'Carol@Auth.test',
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { name: 'Carol', team: 'x' },
      app_metadata: { tier: 'gold' },
    });
    expect(error).toBeNull();
    const user = data.user!;
    expect(user.email).toBe('carol@auth.test');
    expect(user.user_metadata).toEqual({ name: 'Carol', team: 'x' });
    expect(user.app_metadata).toEqual({ provider: 'email', providers: ['email'], tier: 'gold' });
    expect(user.identities?.[0]).toMatchObject({ provider: 'email', user_id: user.id });
    expect(user.email_confirmed_at).toBeTruthy();
    const profile = await lb.db.query('select email from public.profiles_t where id = $1', [user.id]);
    expect(profile.rows).toEqual([{ email: 'carol@auth.test' }]);

    const duplicate = await service.auth.admin.createUser({ email: 'carol@auth.test', password: PASSWORD });
    expect(duplicate.error).toMatchObject({ code: 'email_exists', status: 422 });

    const weak = await service.auth.admin.createUser({ email: 'weak@auth.test', password: '123' });
    expect(weak.error).toMatchObject({ code: 'weak_password', status: 422 });
  });

  it('lists, gets and updates users with metadata merge', async () => {
    const id = await createConfirmedUser(lb, 'dave@auth.test', { user_metadata: { name: 'Dave', keep: 1, drop: 2 } });
    const list = await service.auth.admin.listUsers();
    expect(list.error).toBeNull();
    expect(list.data.users.some((u) => u.id === id)).toBe(true);
    const paged = await service.auth.admin.listUsers({ page: 1, perPage: 1 });
    expect(paged.data.users).toHaveLength(1);
    expect((paged.data as unknown as { nextPage: number | null }).nextPage).toBe(2);
    expect((paged.data as unknown as { total: number }).total).toBeGreaterThanOrEqual(2);

    const got = await service.auth.admin.getUserById(id);
    expect(got.data.user?.email).toBe('dave@auth.test');

    const updated = await service.auth.admin.updateUserById(id, {
      user_metadata: { name: 'David', drop: null },
      app_metadata: { role_hint: 'agent' },
    });
    expect(updated.error).toBeNull();
    expect(updated.data.user?.user_metadata).toEqual({ name: 'David', keep: 1 });
    expect(updated.data.user?.app_metadata).toMatchObject({ provider: 'email', role_hint: 'agent' });

    const missing = await service.auth.admin.getUserById('6f1c1a5e-6d2c-4b8e-9a53-0d9e3c1f0a11');
    expect(missing.error).toMatchObject({ code: 'user_not_found', status: 404 });
  });

  it('deletes users (and reports database errors from FK restrictions)', async () => {
    const id = await createConfirmedUser(lb, 'erin@auth.test');
    // GoTrue answers 500; auth-js reports every 5xx as AuthRetryableFetchError (without a code).
    const blocked = await service.auth.admin.deleteUser(id);
    expect(blocked.error).toMatchObject({ status: 500, name: 'AuthRetryableFetchError', message: 'Database error deleting user' });
    await lb.db.query('delete from public.profiles_t where id = $1', [id]);
    const deleted = await service.auth.admin.deleteUser(id);
    expect(deleted.error).toBeNull();
    const after = await service.auth.admin.getUserById(id);
    expect(after.error).toMatchObject({ status: 404 });
  });
});

describe('sessions', () => {
  it('signs in with password and issues Supabase-shaped tokens', async () => {
    const id = await createConfirmedUser(lb, 'frank@auth.test', { user_metadata: { name: 'Frank' } });
    const client = makeClient(lb);
    const { data, error } = await client.auth.signInWithPassword({ email: 'FRANK@auth.test', password: PASSWORD });
    expect(error).toBeNull();
    expect(data.user?.id).toBe(id);
    const session = data.session!;
    expect(session.token_type).toBe('bearer');
    expect(session.expires_in).toBe(3600);
    const claims = decodeJwtPayload(session.access_token);
    expect(claims).toMatchObject({
      aud: 'authenticated',
      role: 'authenticated',
      sub: id,
      email: 'frank@auth.test',
      phone: '',
      aal: 'aal1',
      is_anonymous: false,
      user_metadata: { name: 'Frank' },
      app_metadata: { provider: 'email', providers: ['email'] },
    });
    expect(claims.iss).toBe(`${lb.url}/auth/v1`);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    expect(typeof claims.session_id).toBe('string');
    expect(claims.amr).toEqual([{ method: 'password', timestamp: expect.any(Number) }]);

    const user = await client.auth.getUser();
    expect(user.error).toBeNull();
    expect(user.data.user?.id).toBe(id);
    const claimsResult = await client.auth.getClaims();
    expect(claimsResult.error).toBeNull();
  });

  it('rejects wrong passwords, unknown emails and unconfirmed emails', async () => {
    await createConfirmedUser(lb, 'gina@auth.test');
    const wrong = await makeClient(lb).auth.signInWithPassword({ email: 'gina@auth.test', password: 'wrong-password' });
    expect(wrong.error).toMatchObject({ code: 'invalid_credentials', status: 400 });
    const unknown = await makeClient(lb).auth.signInWithPassword({ email: 'nobody@auth.test', password: PASSWORD });
    expect(unknown.error).toMatchObject({ code: 'invalid_credentials', status: 400 });
    await service.auth.admin.createUser({ email: 'unconfirmed@auth.test', password: PASSWORD });
    const unconfirmed = await makeClient(lb).auth.signInWithPassword({ email: 'unconfirmed@auth.test', password: PASSWORD });
    expect(unconfirmed.error).toMatchObject({ code: 'email_not_confirmed' });
  });

  it('refreshes with rotation', async () => {
    await createConfirmedUser(lb, 'hank@auth.test');
    const client = await signedInClient(lb, 'hank@auth.test');
    const before = (await client.auth.getSession()).data.session!;
    const { data, error } = await client.auth.refreshSession();
    expect(error).toBeNull();
    const after = data.session!;
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(decodeJwtPayload(after.access_token).session_id).toBe(decodeJwtPayload(before.access_token).session_id);

    const reuse = await raw(lb, '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: before.refresh_token }),
    });
    expect(reuse.status).toBe(200);
    expect((reuse.json() as { refresh_token: string }).refresh_token).toBe(after.refresh_token);

    const garbage = await makeClient(lb).auth.refreshSession({ refresh_token: 'definitely-not-valid' });
    expect(garbage.error).toMatchObject({ code: 'refresh_token_not_found', status: 400 });
  });

  it('updates the current user (metadata, email applied immediately, password)', async () => {
    await createConfirmedUser(lb, 'ivy@auth.test');
    const client = await signedInClient(lb, 'ivy@auth.test');
    const meta = await client.auth.updateUser({ data: { name: 'Ivy' } });
    expect(meta.error).toBeNull();
    expect(meta.data.user?.user_metadata).toMatchObject({ name: 'Ivy' });

    const email = await client.auth.updateUser({ email: 'ivy.new@auth.test' });
    expect(email.error).toBeNull();
    expect(email.data.user?.email).toBe('ivy.new@auth.test');
    const profile = await lb.db.query<{ email: string }>(
      'select p.email from public.profiles_t p join auth.users u on u.id = p.id where u.email = $1',
      ['ivy.new@auth.test'],
    );
    expect(profile.rows).toHaveLength(1);

    const taken = await client.auth.updateUser({ email: 'carol@auth.test' });
    expect(taken.error).toMatchObject({ code: 'email_exists', status: 422 });

    const same = await client.auth.updateUser({ password: PASSWORD });
    expect(same.error).toMatchObject({ code: 'same_password', status: 422 });
    const changed = await client.auth.updateUser({ password: 'new-password-456' });
    expect(changed.error).toBeNull();
    await expect(signedInClient(lb, 'ivy.new@auth.test', 'new-password-456')).resolves.toBeTruthy();
    const old = await makeClient(lb).auth.signInWithPassword({ email: 'ivy.new@auth.test', password: PASSWORD });
    expect(old.error).toMatchObject({ code: 'invalid_credentials' });
  });

  it('bans and unbans users', async () => {
    const id = await createConfirmedUser(lb, 'jade@auth.test');
    const client = await signedInClient(lb, 'jade@auth.test');
    const session = (await client.auth.getSession()).data.session!;

    const ban = await service.auth.admin.updateUserById(id, { ban_duration: '876000h' });
    expect(ban.error).toBeNull();
    expect(new Date(ban.data.user!.banned_until as string).getTime()).toBeGreaterThan(Date.now() + 1000 * 3600 * 24 * 365 * 50);

    const login = await makeClient(lb).auth.signInWithPassword({ email: 'jade@auth.test', password: PASSWORD });
    expect(login.error).toMatchObject({ code: 'user_banned' });

    const userRes = await raw(lb, '/auth/v1/user', {
      headers: { Authorization: `Bearer ${session.access_token}`, 'X-Supabase-Api-Version': '2024-01-01' },
    });
    expect(userRes.status).toBe(403);
    expect(userRes.json()).toMatchObject({ code: 'user_banned' });

    const refresh = await makeClient(lb).auth.refreshSession({ refresh_token: session.refresh_token });
    expect(refresh.error).toMatchObject({ code: 'user_banned' });

    const invalid = await service.auth.admin.updateUserById(id, { ban_duration: 'forever' });
    expect(invalid.error).toMatchObject({ status: 400 });

    const unban = await service.auth.admin.updateUserById(id, { ban_duration: 'none' });
    expect(unban.error).toBeNull();
    expect(unban.data.user?.banned_until).toBeUndefined();
    await expect(signedInClient(lb, 'jade@auth.test')).resolves.toBeTruthy();
  });

  it('logout revokes the session and its refresh tokens', async () => {
    await createConfirmedUser(lb, 'kim@auth.test');
    const client = await signedInClient(lb, 'kim@auth.test');
    const session = (await client.auth.getSession()).data.session!;
    const { error } = await client.auth.signOut();
    expect(error).toBeNull();
    const userRes = await raw(lb, '/auth/v1/user', {
      headers: { Authorization: `Bearer ${session.access_token}`, 'X-Supabase-Api-Version': '2024-01-01' },
    });
    expect(userRes.status).toBe(403);
    expect(userRes.json()).toMatchObject({ code: 'session_not_found' });
    const refresh = await makeClient(lb).auth.refreshSession({ refresh_token: session.refresh_token });
    expect(refresh.error).toMatchObject({ code: 'refresh_token_not_found' });
    const noBearer = await raw(lb, '/auth/v1/user');
    expect(noBearer.status).toBe(401);
    const anonBearer = await raw(lb, '/auth/v1/user', { headers: { Authorization: `Bearer ${lb.anonKey}` } });
    expect(anonBearer.status).toBe(403);
  });
});
