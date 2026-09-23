import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  nextPhone,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;

beforeAll(async () => {
  db = await bootDb();
});

afterAll(async () => {
  await db?.close();
});

const createManual = async (userId: string, phone: string | null, mode: 'IN_APP' | 'TEL' | null = 'IN_APP') =>
  (await userRows<{ id: string }>(
    db,
    userId,
    'select public.create_manual_outbound_call($1::text, $2::public.call_mode) as id',
    [phone, mode],
  ))[0].id;

describe('create_manual_outbound_call', () => {
  it.each(['IN_APP', 'TEL'] as const)('creates a %s call for an active user without creating a lead', async (mode) => {
    const caller = await createAuthUser(db);
    const phone = nextPhone();
    const [{ n: leadsBefore }] = await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.leads');
    const id = await createManual(caller, phone, mode);

    expect(await adminSqlRows(db, 'select user_id, lead_id, remote_e164, direction, mode from public.calls where id = $1', [id])).toEqual([
      { user_id: caller, lead_id: null, remote_e164: phone, direction: 'OUTBOUND', mode },
    ]);
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.leads')).toEqual([{ n: leadsBefore }]);
  });

  it('rejects invalid destinations and mode', async () => {
    const caller = await createAuthUser(db);
    for (const phone of [null, '', '1234567', '+01234567', '+123456', '+1234567890123456']) {
      expect((await pgError(createManual(caller, phone))).code).toBe('22023');
    }
    expect((await pgError(createManual(caller, nextPhone(), null))).code).toBe('22023');
  });

  it('rejects inactive users and disallows IN_APP when in-app calling is disabled', async () => {
    const inactive = await createAuthUser(db, { active: false });
    const disabled = await createAuthUser(db, { inAppCallingEnabled: false });
    expect((await pgError(createManual(inactive, nextPhone(), 'TEL'))).code).toBe('42501');
    expect((await pgError(createManual(disabled, nextPhone(), 'IN_APP'))).code).toBe('42501');
    expect(await createManual(disabled, nextPhone(), 'TEL')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a second live outbound call', async () => {
    const caller = await createAuthUser(db);
    const id = await createManual(caller, nextPhone());
    await db.query("update public.calls set call_status = 'ringing' where id = $1", [id]);
    expect(await pgError(createManual(caller, nextPhone(), 'TEL'))).toEqual({ code: 'P0001', message: 'call_in_progress' });
  });

  it('rejects a manual call while a lead-linked outbound call is live', async () => {
    const caller = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: caller });
    await createCallRow(db, { lead_id: lead.id, user_id: caller, mode: 'IN_APP', call_status: 'ringing' });
    expect(await pgError(createManual(caller, nextPhone()))).toEqual({ code: 'P0001', message: 'call_in_progress' });
  });

  it('enforces the outbound call rate limit on direct RPC calls', async () => {
    const caller = await createAuthUser(db);
    for (let i = 0; i < 12; i += 1) {
      expect(await createManual(caller, nextPhone(), 'TEL')).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await pgError(createManual(caller, nextPhone(), 'TEL'))).toEqual({ code: 'P0001', message: 'rate_limited' });
  });

  it('cleans only stale unclaimed manual IN_APP calls for the caller', async () => {
    const caller = await createAuthUser(db);
    const lead = await createLeadRow(db, { assigned_to: caller });
    const linked = await createCallRow(db, { lead_id: lead.id, user_id: caller, mode: 'IN_APP' });
    const stale = await createManual(caller, nextPhone());
    const tel = await createManual(caller, nextPhone(), 'TEL');
    expect(await adminSqlRows(db, 'select id from public.calls where id = any($1::uuid[]) order by id', [[linked.id, stale, tel]])).toEqual(
      [{ id: linked.id }, { id: tel }].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
