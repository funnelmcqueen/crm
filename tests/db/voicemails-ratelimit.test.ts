// Voicemail RPC scoping (agent vs admin vs admin-only unmatched voicemails), presence and rate limits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  fakeTwilioSid,
  insertRow,
  nextPhone,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '' };
const vm = { leadA: '', unmatchedA: '', leadB: '', adminOnly: '', plainA: '' };
const sid = { leadA: fakeTwilioSid('RE'), unmatchedA: fakeTwilioSid('RE'), leadB: fakeTwilioSid('RE'), adminOnly: fakeTwilioSid('RE') };

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.a = await createAuthUser(db);
  u.b = await createAuthUser(db);
  const leadA = await createLeadRow(db, { assigned_to: u.a, business_name: 'Alpha' });
  const leadB = await createLeadRow(db, { assigned_to: u.b, business_name: 'Bravo' });
  const inbound = { direction: 'INBOUND', mode: 'IN_APP' } as const;
  const day = 86_400_000;
  vm.leadA = (
    await createCallRow(db, { ...inbound, lead_id: leadA.id, user_id: u.a, provider_call_sid: fakeTwilioSid('CA'), voicemail_recording_sid: sid.leadA, created_at: new Date(Date.now() - 3 * day) })
  ).id;
  vm.unmatchedA = (
    await createCallRow(db, {
      ...inbound,
      lead_id: null,
      user_id: u.a,
      remote_e164: nextPhone(),
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: sid.unmatchedA,
      created_at: new Date(Date.now() - 2 * day),
    })
  ).id;
  vm.leadB = (
    await createCallRow(db, { ...inbound, lead_id: leadB.id, user_id: u.b, provider_call_sid: fakeTwilioSid('CA'), voicemail_recording_sid: sid.leadB })
  ).id;
  vm.adminOnly = (
    await createCallRow(db, {
      ...inbound,
      lead_id: null,
      user_id: null,
      remote_e164: nextPhone(),
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: sid.adminOnly,
      created_at: new Date(Date.now() - day),
    })
  ).id;
  vm.plainA = (await createCallRow(db, { lead_id: leadA.id, user_id: u.a, outcome: 'CONNECTED' })).id;
});

afterAll(async () => {
  await db?.close();
});

describe('voicemail RPCs', () => {
  it('list_voicemails and unheard_voicemail_count are scoped to the caller', async () => {
    const list = async (userId: string) =>
      (await userRows<{ call_id: string; phone: string; business_name: string | null; total_count: number | bigint }>(
        db,
        userId,
        'select call_id, phone, business_name, total_count from public.list_voicemails()',
      )).map((r) => r.call_id);
    expect(await list(u.a)).toEqual([vm.unmatchedA, vm.leadA]);
    expect(await list(u.b)).toEqual([vm.leadB]);
    expect(new Set(await list(u.admin))).toEqual(new Set([vm.leadA, vm.unmatchedA, vm.leadB, vm.adminOnly]));
    expect(await userRows(db, u.a, 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 2 }]);
    expect(await userRows(db, u.admin, 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 4 }]);
  });

  it('shows the caller number for unmatched voicemails and the lead phone otherwise', async () => {
    const rows = await userRows<{ call_id: string; phone: string; business_name: string | null }>(
      db,
      u.a,
      'select call_id, phone, business_name from public.list_voicemails()',
    );
    const [{ remote_e164 }] = await adminSqlRows<{ remote_e164: string }>(db, 'select remote_e164 from public.calls where id = $1', [vm.unmatchedA]);
    expect(rows.find((r) => r.call_id === vm.unmatchedA)).toMatchObject({ phone: remote_e164, business_name: null });
    expect(rows.find((r) => r.call_id === vm.leadA)).toMatchObject({ business_name: 'Alpha' });
  });

  it("get_voicemail_recording (service role) returns the SID only for calls the given user may access", async () => {
    const recording = async (userId: string, callId: string) =>
      (await serviceRows<{ sid: string | null }>(db, 'select public.get_voicemail_recording($1, $2) as sid', [callId, userId]))[0].sid;
    expect(await recording(u.a, vm.leadA)).toBe(sid.leadA);
    expect(await recording(u.a, vm.unmatchedA)).toBe(sid.unmatchedA);
    expect(await recording(u.a, vm.leadB)).toBeNull();
    expect(await recording(u.a, vm.adminOnly)).toBeNull();
    expect(await recording(u.a, crypto.randomUUID())).toBeNull();
    expect(await recording(u.admin, vm.adminOnly)).toBe(sid.adminOnly);
  });

  it("mark_voicemail_heard only works on the caller's accessible voicemails", async () => {
    const mark = async (userId: string, callId: string) =>
      (await userRows<{ ok: boolean }>(db, userId, 'select public.mark_voicemail_heard($1) as ok', [callId]))[0].ok;
    expect(await mark(u.a, vm.leadB)).toBe(false);
    expect(await mark(u.a, vm.adminOnly)).toBe(false);
    expect(await mark(u.a, vm.plainA)).toBe(false);
    expect(await adminSqlRows(db, 'select handled_at from public.calls where id = any($1::uuid[])', [[vm.leadB, vm.adminOnly]])).toEqual([
      { handled_at: null },
      { handled_at: null },
    ]);

    expect(await mark(u.a, vm.leadA)).toBe(true);
    expect(await mark(u.a, vm.leadA)).toBe(true);
    expect(await userRows(db, u.a, 'select call_id from public.list_voicemails(p_unheard_only => true)')).toEqual([{ call_id: vm.unmatchedA }]);
    expect(await mark(u.admin, vm.adminOnly)).toBe(true);
    expect(await userRows(db, u.admin, 'select public.unheard_voicemail_count() as n')).toEqual([{ n: 2 }]);
  });

  it('clamps list_voicemails paging', async () => {
    expect(await userRows(db, u.admin, 'select call_id from public.list_voicemails(p_limit => 0)')).toHaveLength(1);
    expect(await userRows(db, u.admin, 'select call_id from public.list_voicemails(p_limit => 1000, p_offset => -5)')).toHaveLength(4);
  });
});

describe('touch_device_presence', () => {
  it('sets device_seen_at for the caller only', async () => {
    await userRows(db, u.a, 'select public.touch_device_presence()');
    const rows = await adminSqlRows<{ id: string; device_seen_at: Date | null }>(
      db,
      'select id, device_seen_at from public.profiles where id = any($1::uuid[])',
      [[u.a, u.b]],
    );
    expect(rows.find((r) => r.id === u.a)?.device_seen_at).not.toBeNull();
    expect(rows.find((r) => r.id === u.b)?.device_seen_at).toBeNull();
    expect((await pgError(anonRows(db, 'select public.touch_device_presence()'))).code).toBe('42501');
  });
});

describe('consume_rate_limit', () => {
  const consume = async (userId: string, bucket: string | null) =>
    (await userRows<{ ok: boolean }>(db, userId, 'select public.consume_rate_limit($1) as ok', [bucket]))[0].ok;
  const hits = async (userId: string) =>
    (await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.rate_limit_hits where user_id = $1', [userId]))[0].n;

  it('allows 20 voice_token hits per user inside the fixed 10-minute window', async () => {
    const agent = await createAuthUser(db);
    const results: boolean[] = [];
    for (let i = 0; i < 21; i += 1) results.push(await consume(agent, 'voice_token'));
    expect(results.slice(0, 20).every(Boolean)).toBe(true);
    expect(results[20]).toBe(false);
    expect(await hits(agent)).toBe(20);
    expect(await consume(u.b, 'voice_token')).toBe(true);
  });

  it('prunes only hits older than the fixed window', async () => {
    const stale = await createAuthUser(db);
    const recent = await createAuthUser(db);
    for (let i = 0; i < 20; i += 1) {
      await insertRow(db, 'rate_limit_hits', { user_id: stale, bucket: 'voice_token', created_at: new Date(Date.now() - 11 * 60_000) });
      await insertRow(db, 'rate_limit_hits', { user_id: recent, bucket: 'voice_token', created_at: new Date(Date.now() - 9 * 60_000) });
    }
    expect(await consume(stale, 'voice_token')).toBe(true);
    expect(await hits(stale)).toBe(1);
    expect(await consume(recent, 'voice_token')).toBe(false);
    expect(await hits(recent)).toBe(20);
  });

  it.each<[string | null]>([['outbound_call'], ['Bad-Bucket'], [''], ['probe'], [null]])('rejects bucket %j with 22023', async (bucket) => {
    expect((await pgError(consume(u.a, bucket))).code).toBe('22023');
  });

  it('no longer accepts a caller-chosen limit or window', async () => {
    expect((await pgError(userRows(db, u.a, `select public.consume_rate_limit('voice_token', 10000, 1)`))).code).toBe('42883');
  });
});
