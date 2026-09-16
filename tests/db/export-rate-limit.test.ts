// SPEC 12 asks for a rate limit on the token endpoint and outbound call creation, and both exist. The
// export had none: an authenticated agent (or a stolen session) could request /api/leads/export in a
// loop, each call paging their whole assigned book through export_leads at up to 1000 rows a page, with
// no cap on the number of pages. It leaks nothing — RLS and the explicit assigned_to filter hold — but
// it is an unbounded database and egress cost per request, and for an admin each pass covers every lead
// in the system.
//
// The policy lives in SQL with the others (D14), so it holds across serverless instances and no caller
// argument can shrink the window.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, anonRows, bootDb, createAuthUser, insertRow, pgError, serviceRows, userRows, type PGlite } from '../helpers/pglite';

export const EXPORT_LIMIT = 30;

let db: PGlite;
let agent = '';

const consume = async (userId: string, bucket: string) =>
  (await userRows<{ ok: boolean }>(db, userId, 'select public.consume_rate_limit($1) as ok', [bucket]))[0].ok;

const hits = async (userId: string, bucket: string) =>
  (
    await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.rate_limit_hits where user_id = $1 and bucket = $2', [
      userId,
      bucket,
    ])
  )[0].n;

beforeAll(async () => {
  db = await bootDb();
  agent = await createAuthUser(db);
});

afterAll(async () => {
  await db?.close();
});

describe("the export bucket", () => {
  it(`allows ${EXPORT_LIMIT} exports per user in the fixed window, then refuses`, async () => {
    const user = await createAuthUser(db);
    const results: boolean[] = [];
    for (let i = 0; i < EXPORT_LIMIT + 1; i += 1) results.push(await consume(user, 'export'));
    expect(results.slice(0, EXPORT_LIMIT).every(Boolean)).toBe(true);
    expect(results[EXPORT_LIMIT]).toBe(false);
    expect(await hits(user, 'export')).toBe(EXPORT_LIMIT);
  });

  it('is counted per user and per bucket, so exports never spend the voice_token budget', async () => {
    const user = await createAuthUser(db);
    expect(await consume(user, 'export')).toBe(true);
    expect(await hits(user, 'voice_token')).toBe(0);
    expect(await consume(user, 'voice_token')).toBe(true);
    expect(await hits(user, 'export')).toBe(1);
    // A different user is unaffected by the first one's usage.
    expect(await consume(agent, 'export')).toBe(true);
  });

  it('prunes only hits older than the window', async () => {
    const stale = await createAuthUser(db);
    for (let i = 0; i < EXPORT_LIMIT; i += 1) {
      await insertRow(db, 'rate_limit_hits', { user_id: stale, bucket: 'export', created_at: new Date(Date.now() - 11 * 60_000) });
    }
    expect(await consume(stale, 'export')).toBe(true);
    expect(await hits(stale, 'export')).toBe(1);
  });

  it('keeps the policy in the database: no caller-chosen window, and still internal to the API', async () => {
    expect((await pgError(userRows(db, agent, `select public.consume_rate_limit('export', 10000, 1)`))).code).toBe('42883');
    expect((await pgError(anonRows(db, `select public.consume_rate_limit('export')`))).code).toBe('42501');
    // apply_rate_limit remains callable by nobody, service_role included.
    expect((await pgError(serviceRows(db, `select public.apply_rate_limit(gen_random_uuid(), 'export')`))).code).toBe('42501');
  });

  it('still refuses buckets a route may not consume directly', async () => {
    for (const bucket of ['outbound_call', 'Export', 'exports', '']) {
      expect((await pgError(consume(agent, bucket))).code).toBe('22023');
    }
  });
});
