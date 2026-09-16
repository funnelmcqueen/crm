// The agent Today dashboard's own-data functions (migration 20260915001800_agent_today.sql, DEVIATIONS D43).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOfDayInTz } from '@/lib/domain/time';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createCallRow,
  createLeadRow,
  createPhoneNumberRow,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

const HOUR = 3_600_000;

let db: PGlite;

beforeAll(async () => {
  db = await bootDb();
});

afterAll(async () => {
  await db?.close();
});

describe('get_my_call_days', () => {
  it.each(['America/New_York', 'Pacific/Auckland'])(
    "counts the caller's own dials per local day for the last 7 days, matching get_my_dashboard today (%s)",
    async (tz) => {
      const agent = await createAuthUser(db, { name: `Days ${tz}`, timezone: tz });
      const other = await createAuthUser(db, { name: `Days other ${tz}`, timezone: tz });
      const lead = (await createLeadRow(db, { assigned_to: agent })).id;
      const moved = (await createLeadRow(db, { assigned_to: other })).id;
      const today = startOfDayInTz(tz);

      await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'NO_ANSWER', created_at: new Date(today.getTime() + HOUR) });
      // On a lead that now belongs to someone else: still the agent's dial.
      await createCallRow(db, { lead_id: moved, user_id: agent, outcome: 'CONNECTED', created_at: new Date(today.getTime() + 2 * HOUR) });
      // Not dials: a pre-created in-app row and an inbound call.
      await createCallRow(db, { lead_id: lead, user_id: agent, mode: 'IN_APP', created_at: new Date(today.getTime() + 3 * HOUR) });
      await createCallRow(db, { lead_id: lead, user_id: agent, direction: 'INBOUND', outcome: 'CONNECTED', created_at: new Date(today.getTime() + 4 * HOUR) });
      // Someone else's dial never counts.
      await createCallRow(db, { lead_id: moved, user_id: other, outcome: 'CONNECTED', created_at: new Date(today.getTime() + HOUR) });
      // One minute before local midnight: yesterday. Eight days ago: outside the window.
      await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'VOICEMAIL', created_at: new Date(today.getTime() - 60_000) });
      await createCallRow(db, { lead_id: lead, user_id: agent, outcome: 'VOICEMAIL', created_at: new Date(today.getTime() - 7.5 * 24 * HOUR) });

      const days = await userRows<{ day: Date | string; dials: number }>(db, agent, 'select day::text as day, dials from public.get_my_call_days()');
      expect(days).toHaveLength(7);
      const counts = days.map((d) => Number(d.dials));
      expect(counts[6]).toBe(2);
      expect(counts[5]).toBe(1);
      expect(counts.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
      expect(days.map((d) => String(d.day))).toEqual([...days.map((d) => String(d.day))].sort());

      const [{ d }] = await userRows<{ d: { dials_today: number } }>(db, agent, 'select public.get_my_dashboard() as d');
      expect(d.dials_today).toBe(counts[6]);
    },
  );

  it('refuses anon and inactive users', async () => {
    const disabled = await createAuthUser(db, { active: false });
    expect((await pgError(userRows(db, disabled, 'select * from public.get_my_call_days()'))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select * from public.get_my_call_days()'))).code).toBe('42501');
  });
});

describe('my_caller_id_available', () => {
  const available = async (userId: string) =>
    (await userRows<{ ok: boolean }>(db, userId, 'select public.my_caller_id_available() as ok'))[0].ok;

  it("follows claim_caller_id's choice: the caller's own active number, else an active pool number", async () => {
    const agent = await createAuthUser(db, { name: 'Caller ID Agent' });
    const other = await createAuthUser(db, { name: 'Caller ID Other' });
    // Only numbers this test creates exist in this database at this point.
    expect((await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.phone_numbers'))[0].n).toBe(0);
    expect(await available(agent)).toBe(false);

    await createPhoneNumberRow(db, { assigned_to: other });
    const inactivePool = await createPhoneNumberRow(db, { active: false });
    expect(await available(agent)).toBe(false);

    const own = await createPhoneNumberRow(db, { assigned_to: agent });
    expect(await available(agent)).toBe(true);
    await adminSqlRows(db, 'update public.phone_numbers set active = false where id = $1', [own.id]);
    expect(await available(agent)).toBe(false);

    await adminSqlRows(db, 'update public.phone_numbers set active = true where id = $1', [inactivePool.id]);
    expect(await available(agent)).toBe(true);
  });

  it('refuses anon and inactive users, and agents still cannot read phone numbers', async () => {
    const disabled = await createAuthUser(db, { active: false });
    const agent = await createAuthUser(db, {});
    expect((await pgError(userRows(db, disabled, 'select public.my_caller_id_available()'))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select public.my_caller_id_available()'))).code).toBe('42501');
    expect(await userRows(db, agent, 'select id from public.phone_numbers')).toEqual([]);
  });
});
