// revoke_user_sessions (migration 20260915001500, docs/DEVIATIONS.md D31): the service role ends every Auth
// session of one user by deleting their auth.sessions rows, which takes the refresh tokens with them. On
// localbase auth.sessions is a view over localbase.sessions (localbase/auth-compat.sql).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, anonRows, bootDb, createAuthUser, pgError, serviceRows, userRows, type PGlite } from '../helpers/pglite';

let db: PGlite;
let admin = '';
let agent = '';
let bystander = '';

async function addSession(userId: string): Promise<void> {
  const id = randomUUID();
  await adminSqlRows(db, 'insert into localbase.sessions (id, user_id) values ($1, $2)', [id, userId]);
  await adminSqlRows(db, 'insert into localbase.refresh_tokens (token, session_id, user_id) values ($1, $2, $3)', [
    randomUUID(),
    id,
    userId,
  ]);
}

async function counts(userId: string): Promise<{ sessions: number; tokens: number }> {
  const [row] = await adminSqlRows<{ sessions: number; tokens: number }>(
    db,
    `select (select count(*)::int from localbase.sessions where user_id = $1) as sessions,
            (select count(*)::int from localbase.refresh_tokens where user_id = $1) as tokens`,
    [userId],
  );
  return row;
}

async function revokeAsService(userId: string | null): Promise<number> {
  const [row] = await serviceRows<{ n: number }>(db, 'select public.revoke_user_sessions($1::uuid) as n', [userId]);
  return row.n;
}

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Sessions Admin' });
  agent = await createAuthUser(db, { name: 'Sessions Agent' });
  bystander = await createAuthUser(db, { name: 'Sessions Bystander' });
});

afterAll(async () => {
  await db?.close();
});

describe('revoke_user_sessions', () => {
  it('ends every session of that user, with their refresh tokens, and no one else', async () => {
    await addSession(agent);
    await addSession(agent);
    await addSession(bystander);

    expect(await revokeAsService(agent)).toBe(2);
    expect(await counts(agent)).toEqual({ sessions: 0, tokens: 0 });
    expect(await counts(bystander)).toEqual({ sessions: 1, tokens: 1 });

    expect(await revokeAsService(agent)).toBe(0);
    expect(await revokeAsService(randomUUID())).toBe(0);
  });

  it('is for the service role only: admins, agents and anon cannot call it', async () => {
    await addSession(bystander);
    const before = await counts(bystander);
    for (const caller of [admin, agent]) {
      expect((await pgError(userRows(db, caller, 'select public.revoke_user_sessions($1::uuid)', [bystander]))).code).toBe('42501');
    }
    expect((await pgError(anonRows(db, 'select public.revoke_user_sessions($1::uuid)', [bystander]))).code).toBe('42501');
    expect(await counts(bystander)).toEqual(before);
  });

  it('refuses a null user id', async () => {
    expect((await pgError(revokeAsService(null))).code).toBe('22023');
  });
});
