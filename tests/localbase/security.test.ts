import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET } from '../../localbase/jwt';
import type { Localbase } from '../../localbase/server';
import { FIXTURE_SQL, createConfirmedUser, raw, signedInClient, startTestLocalbase } from './helpers';

let lb: Localbase;
let aliceId: string;
let aliceToken: string;

const WELL_KNOWN_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const WELL_KNOWN_SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function forge(payload: Record<string, unknown>, secret = JWT_SECRET): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new TextEncoder().encode(secret));
}

function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: 'authenticated', role: 'authenticated', sub: aliceId, iat: now, exp: now + 3600, ...overrides };
}

async function restAs(token: string, path = '/rest/v1/items?select=id', apikey?: string | null) {
  return raw(lb, path, { headers: { Authorization: `Bearer ${token}` }, apikey: apikey === undefined ? lb.anonKey : apikey });
}

beforeAll(async () => {
  lb = await startTestLocalbase();
  await lb.db.exec(FIXTURE_SQL);
  aliceId = await createConfirmedUser(lb, 'alice@security.test');
  await lb.db.query(`insert into public.items (owner, name, code) values ($1, 'secret row', 's1')`, [aliceId]);
  const client = await signedInClient(lb, 'alice@security.test');
  aliceToken = (await client.auth.getSession()).data.session?.access_token ?? '';
});

afterAll(async () => {
  await lb?.stop();
});

describe('api keys', () => {
  it('are the well-known Supabase local demo keys', () => {
    expect(lb.anonKey).toBe(WELL_KNOWN_ANON);
    expect(lb.serviceRoleKey).toBe(WELL_KNOWN_SERVICE);
    expect(lb.jwtSecret).toBe(JWT_SECRET);
  });

  it('requires an apikey header equal to the anon or service key', async () => {
    const missing = await restAs(aliceToken, '/rest/v1/items?select=id', null);
    expect(missing.status).toBe(401);
    expect(missing.json()).toEqual({ message: 'No API key found in request' });

    const wrong = await restAs(aliceToken, '/rest/v1/items?select=id', 'not-a-key');
    expect(wrong.status).toBe(401);

    const userTokenAsKey = await restAs(aliceToken, '/rest/v1/items?select=id', aliceToken);
    expect(userTokenAsKey.status).toBe(401);

    const authMissing = await raw(lb, '/auth/v1/health', { apikey: null });
    expect(authMissing.status).toBe(401);
  });
});

describe('JWT attacks on /rest/v1', () => {
  it('accepts the genuine token', async () => {
    const ok = await restAs(aliceToken);
    expect(ok.status).toBe(200);
    expect(ok.json()).toHaveLength(1);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const res = await restAs(await forge(userClaims(), 'another-secret-another-secret-another-secret'));
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PGRST301' });
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await restAs(await forge(userClaims({ iat: now - 7200, exp: now - 3600 })));
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ code: 'PGRST303', message: 'JWT expired' });
  });

  it('rejects roles outside anon/authenticated/service_role', async () => {
    for (const role of ['postgres', 'supabase_admin', 'supabase_auth_admin', 'authenticator', '']) {
      const res = await restAs(await forge(userClaims({ role })));
      expect(res.status, role).toBe(401);
    }
  });

  it('runs a verified token without a role claim as anon, like PostgREST db-anon-role', async () => {
    const noRole = await forge({ sub: aliceId, exp: Math.floor(Date.now() / 1000) + 60 });
    const res = await restAs(noRole);
    // anon has no privileges on items: permission denied (42501), not a JWT error, and never alice's row.
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ code: '42501' });
  });

  it('runs a verified authenticated token without sub with auth.uid() null, so row policies match nothing', async () => {
    const res = await restAs(await forge(userClaims({ sub: undefined })));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('rejects unsigned (alg none) and malformed tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(userClaims())).toString('base64url');
    expect((await restAs(`${header}.${payload}.`)).status).toBe(401);
    expect((await restAs('garbage')).status).toBe(401);
    const basic = await raw(lb, '/rest/v1/items?select=id', { headers: { Authorization: 'Basic abc' } });
    expect(basic.status).toBe(401);
  });

  it('cannot escalate to service_role with a forged service token', async () => {
    const res = await restAs(await forge({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 60 }, 'x'.repeat(40)));
    expect(res.status).toBe(401);
  });
});

describe('injection and scope', () => {
  it('rejects malicious identifiers and binds values', async () => {
    expect((await restAs(aliceToken, '/rest/v1/items?select=id;drop%20table%20items')).status).toBe(400);
    expect((await restAs(aliceToken, '/rest/v1/items?select=id&order=name;drop')).status).toBe(400);
    expect((await restAs(aliceToken, `/rest/v1/items?select=id&${encodeURIComponent('name"; drop table x; --')}=eq.1`)).status).toBe(400);
    const quotedWeird = await restAs(aliceToken, `/rest/v1/items?select=id&${encodeURIComponent('"name"" or 1=1 --"')}=eq.1`);
    expect(quotedWeird.status).toBe(400);
    expect(quotedWeird.json()).toMatchObject({ code: '42703' });
    const value = await restAs(aliceToken, `/rest/v1/items?select=id&name=eq.${encodeURIComponent("'; drop table public.items; --")}`);
    expect(value.status).toBe(200);
    expect(value.json()).toEqual([]);
    expect((await restAs(aliceToken, '/rest/v1/items;drop?select=id')).status).toBe(404);
    const rpc = await raw(lb, `/rest/v1/rpc/${encodeURIComponent('fx_add(1,2);--')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(rpc.status).toBe(404);
    const stillThere = await lb.db.query<{ n: number }>('select count(*)::int as n from public.items');
    expect(stillThere.rows[0].n).toBe(1);
  });

  it('serves only the public schema', async () => {
    const accept = await raw(lb, '/rest/v1/users?select=id', { headers: { Authorization: `Bearer ${lb.serviceRoleKey}`, 'Accept-Profile': 'auth' }, apikey: lb.serviceRoleKey });
    expect(accept.status).toBe(406);
    const content = await raw(lb, '/rest/v1/schema_migrations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lb.serviceRoleKey}`, 'Content-Profile': 'localbase', 'Content-Type': 'application/json' },
      body: '{"name":"x"}',
      apikey: lb.serviceRoleKey,
    });
    expect(content.status).toBe(406);
    const internal = await raw(lb, '/rest/v1/schema_migrations?select=name', { headers: { Authorization: `Bearer ${lb.serviceRoleKey}` }, apikey: lb.serviceRoleKey });
    expect(internal.status).toBe(404);
  });

  it('restores the postgres session after failed requests', async () => {
    expect((await raw(lb, '/rest/v1/items?select=id')).status).toBe(401);
    expect((await restAs(aliceToken, '/rest/v1/notes?select=*')).status).toBe(403);
    const who = await lb.db.query<{ u: string; claims: string | null }>(
      `select current_user::text as u, nullif(current_setting('request.jwt.claims', true), '') as claims`,
    );
    expect(who.rows[0]).toEqual({ u: 'postgres', claims: null });
  });
});

describe('auth admin guard', () => {
  it('requires a service_role JWT', async () => {
    const none = await raw(lb, '/auth/v1/admin/users');
    expect(none.status).toBe(401);
    const anonBearer = await raw(lb, '/auth/v1/admin/users', { headers: { Authorization: `Bearer ${lb.anonKey}` } });
    expect(anonBearer.status).toBe(403);
    expect(anonBearer.json()).toMatchObject({ error_code: 'not_admin' });
    const userBearer = await raw(lb, '/auth/v1/admin/users', { headers: { Authorization: `Bearer ${aliceToken}` } });
    expect(userBearer.status).toBe(403);
    const forged = await forge({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 60 }, 'y'.repeat(40));
    const forgedRes = await raw(lb, '/auth/v1/admin/users', { headers: { Authorization: `Bearer ${forged}` } });
    expect(forgedRes.status).toBe(403);
    expect(forgedRes.json()).toMatchObject({ error_code: 'bad_jwt' });
    const serviceRes = await raw(lb, '/auth/v1/admin/users', { headers: { Authorization: `Bearer ${lb.serviceRoleKey}` } });
    expect(serviceRes.status).toBe(200);
  });

  it('answers CORS preflight without an apikey', async () => {
    const res = await fetch(`${lb.url}/rest/v1/items`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Headers': 'apikey, authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
});
