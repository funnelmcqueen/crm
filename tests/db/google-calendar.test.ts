// Bookable hours and the Google Calendar connection (migration 20260915002000_google_calendar.sql,
// docs/DEVIATIONS.md D47): hours are admin-set and replace the whole week atomically, the connection
// singleton is admin-guarded, mark_calendar_broken is service-role only (no API-role session, admin
// included, may call it directly), and nobody reads the stored refresh token through the API.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSqlRows, anonRows, bootDb, createAuthUser, pgError, serviceRows, userRows, type PGlite } from '../helpers/pglite';

let db: PGlite;
let admin = '';

const SET_HOURS = 'select public.set_bookable_hours($1::jsonb)';
const CONNECT = 'select public.connect_calendar($1, $2, $3)';
const DISCONNECT = 'select public.disconnect_calendar()';
const MARK_BROKEN = 'select public.mark_calendar_broken()';
const STATUS = 'select * from public.get_calendar_status()';
const SET_AGENT_CALENDAR = 'select public.set_agent_calendar_id($1, $2)';

interface BookableHourRow {
  weekday: number;
  starts_minute: number;
  ends_minute: number;
}

interface CalendarStatusRow {
  connected: boolean;
  google_email: string | null;
  hours_set: boolean;
  broken: boolean;
  app_calendar_id: string | null;
}

async function setHours(caller: string, rows: unknown[]): Promise<void> {
  await userRows(db, caller, SET_HOURS, [JSON.stringify(rows)]);
}

async function hourCount(): Promise<number> {
  const [row] = await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.bookable_hours');
  return row.n;
}

async function calendarIdOf(userId: string): Promise<string | null> {
  const [row] = await adminSqlRows<{ google_calendar_id: string | null }>(
    db,
    'select google_calendar_id from public.profiles where id = $1',
    [userId],
  );
  return row?.google_calendar_id ?? null;
}

beforeAll(async () => {
  db = await bootDb();
  admin = await createAuthUser(db, { role: 'ADMIN', name: 'Calendar Admin' });
});

afterAll(async () => {
  await db?.close();
});

describe('bookable_hours seed', () => {
  it('seeds Monday-Friday 10:00-12:00 and 14:00-17:00 on 30-minute boundaries', async () => {
    const rows = await adminSqlRows<BookableHourRow>(
      db,
      'select weekday, starts_minute, ends_minute from public.bookable_hours order by weekday, starts_minute',
    );
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.starts_minute % 30).toBe(0);
      expect(row.ends_minute % 30).toBe(0);
    }
    for (const weekday of [1, 2, 3, 4, 5]) {
      const forDay = rows.filter((r) => r.weekday === weekday);
      expect(forDay).toEqual([
        { weekday, starts_minute: 600, ends_minute: 720 },
        { weekday, starts_minute: 840, ends_minute: 1020 },
      ]);
    }
  });
});

describe('set_bookable_hours', () => {
  it('is admin only: an agent and anon both raise 42501', async () => {
    const agent = await createAuthUser(db, { name: 'Hours Agent' });
    const payload = [{ weekday: 1, starts_minute: 540, ends_minute: 660 }];
    expect((await pgError(setHours(agent, payload))).code).toBe('42501');
    expect((await pgError(anonRows(db, SET_HOURS, [JSON.stringify(payload)]))).code).toBe('42501');
  });

  it('replaces the whole week atomically', async () => {
    await setHours(admin, [{ weekday: 1, starts_minute: 540, ends_minute: 660 }]);
    expect(await hourCount()).toBe(1);
  });

  it.each([
    ['weekday out of range', [{ weekday: 7, starts_minute: 540, ends_minute: 660 }]],
    ['starts_minute not a multiple of 30', [{ weekday: 1, starts_minute: 545, ends_minute: 660 }]],
    ['ends_minute above 1440', [{ weekday: 1, starts_minute: 540, ends_minute: 1500 }]],
    ['starts_minute >= ends_minute', [{ weekday: 1, starts_minute: 660, ends_minute: 540 }]],
    [
      'two overlapping ranges on one weekday',
      [
        { weekday: 2, starts_minute: 540, ends_minute: 660 },
        { weekday: 2, starts_minute: 600, ends_minute: 720 },
      ],
    ],
  ])('rejects invalid_hours (P0001) and changes nothing: %s', async (_label, payload) => {
    const before = await hourCount();
    expect(await pgError(setHours(admin, payload))).toMatchObject({ code: 'P0001', message: 'invalid_hours' });
    expect(await hourCount()).toBe(before);
  });

  it('accepts two ranges on one weekday that only touch', async () => {
    await setHours(admin, [
      { weekday: 2, starts_minute: 540, ends_minute: 660 },
      { weekday: 2, starts_minute: 660, ends_minute: 780 },
    ]);
    expect(await hourCount()).toBe(2);
  });
});

describe('bookable_hours direct writes', () => {
  it('an agent cannot insert, update or delete rows directly; only set_bookable_hours may write', async () => {
    const agent = await createAuthUser(db, { name: 'Direct Write Agent' });
    const [existing] = await adminSqlRows<{ id: string }>(db, 'select id from public.bookable_hours limit 1');

    expect(
      (await pgError(userRows(db, agent, 'insert into public.bookable_hours (weekday, starts_minute, ends_minute) values (3, 540, 600)'))).code,
    ).toBe('42501');
    expect(
      (await pgError(userRows(db, agent, 'update public.bookable_hours set ends_minute = ends_minute + 30 where id = $1', [existing.id]))).code,
    ).toBe('42501');
    expect((await pgError(userRows(db, agent, 'delete from public.bookable_hours where id = $1', [existing.id]))).code).toBe('42501');
  });
});

describe('calendar_connection lifecycle', () => {
  it('get_calendar_status with no connection returns connected=false and a null email; an agent raises 42501', async () => {
    const [status] = await userRows<CalendarStatusRow>(db, admin, STATUS);
    expect(status).toEqual({ connected: false, google_email: null, hours_set: true, broken: false, app_calendar_id: null });

    const agent = await createAuthUser(db, { name: 'Status Agent' });
    expect((await pgError(userRows(db, agent, STATUS))).code).toBe('42501');
  });

  it('no API role can read the connection table directly, admin included', async () => {
    expect((await pgError(anonRows(db, 'select * from public.calendar_connection'))).code).toBe('42501');
    expect((await pgError(userRows(db, admin, 'select * from public.calendar_connection'))).code).toBe('42501');
  });

  it('connect_calendar is admin only, inserts the singleton, and a second call updates in place and clears broken_at', async () => {
    const agent = await createAuthUser(db, { name: 'Connect Agent' });
    expect((await pgError(userRows(db, agent, CONNECT, ['a@b.test', 'cipher', 'cal-1'])))).toMatchObject({ code: '42501' });

    await userRows(db, admin, CONNECT, ['a@b.test', 'cipher', 'cal-1']);
    let rows = await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.calendar_connection');
    expect(rows[0].n).toBe(1);

    await adminSqlRows(db, `update public.calendar_connection set broken_at = now()`);
    await userRows(db, admin, CONNECT, ['a@b.test', 'cipher', 'cal-1']);
    rows = await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.calendar_connection');
    expect(rows[0].n).toBe(1);
    const [row] = await adminSqlRows<{ broken_at: Date | null }>(db, 'select broken_at from public.calendar_connection');
    expect(row.broken_at).toBeNull();
  });

  it('mark_calendar_broken is service role only: an agent and an admin session both raise 42501, and the service role sets broken_at, reflected by get_calendar_status with no ciphertext in its columns', async () => {
    const agent = await createAuthUser(db, { name: 'Breaker Agent' });
    expect((await pgError(userRows(db, agent, MARK_BROKEN))).code).toBe('42501');
    expect((await pgError(userRows(db, admin, MARK_BROKEN))).code).toBe('42501');

    await serviceRows(db, MARK_BROKEN);

    const [status] = await userRows<CalendarStatusRow>(db, admin, STATUS);
    expect(Object.keys(status).sort()).toEqual(['app_calendar_id', 'broken', 'connected', 'google_email', 'hours_set'].sort());
    expect(status).toEqual({ connected: true, google_email: 'a@b.test', hours_set: true, broken: true, app_calendar_id: 'cal-1' });
  });

  it('disconnect_calendar is admin only and removes the row', async () => {
    const agent = await createAuthUser(db, { name: 'Disconnect Agent' });
    expect((await pgError(userRows(db, agent, DISCONNECT)))).toMatchObject({ code: '42501' });

    await userRows(db, admin, DISCONNECT);
    const rows = await adminSqlRows<{ n: number }>(db, 'select count(*)::int as n from public.calendar_connection');
    expect(rows[0].n).toBe(0);

    const [status] = await userRows<CalendarStatusRow>(db, admin, STATUS);
    expect(status.connected).toBe(false);
  });
});

describe('set_agent_calendar_id (D48)', () => {
  it('is service role only: an agent and an admin session both raise 42501', async () => {
    const agent = await createAuthUser(db, { name: 'Calendar Agent' });
    expect((await pgError(userRows(db, agent, SET_AGENT_CALENDAR, [agent, 'cal-a']))).code).toBe('42501');
    expect((await pgError(userRows(db, admin, SET_AGENT_CALENDAR, [agent, 'cal-a']))).code).toBe('42501');
    expect(await calendarIdOf(agent)).toBeNull();
  });

  it('stores a trimmed calendar id for the service role, and replaces it on reconnect', async () => {
    const agent = await createAuthUser(db, { name: 'Provisioned Agent' });
    await serviceRows(db, SET_AGENT_CALENDAR, [agent, '  cal-provisioned  ']);
    expect(await calendarIdOf(agent)).toBe('cal-provisioned');

    await serviceRows(db, SET_AGENT_CALENDAR, [agent, 'cal-second']);
    expect(await calendarIdOf(agent)).toBe('cal-second');
  });

  it('refuses a blank or oversized id, and an unknown or deleted agent', async () => {
    const agent = await createAuthUser(db, { name: 'Rejected Agent' });
    expect((await pgError(serviceRows(db, SET_AGENT_CALENDAR, [agent, '   ']))).code).toBe('22023');
    expect((await pgError(serviceRows(db, SET_AGENT_CALENDAR, [agent, 'x'.repeat(1025)]))).code).toBe('22023');
    expect((await pgError(serviceRows(db, SET_AGENT_CALENDAR, [randomUUID(), 'cal-x']))).code).toBe('P0002');

    // A deleted agent never owns work again (20260915001400_delete_agent.sql).
    await adminSqlRows(db, 'update public.profiles set deleted_at = now(), active = false where id = $1', [agent]);
    expect((await pgError(serviceRows(db, SET_AGENT_CALENDAR, [agent, 'cal-y']))).code).toBe('P0002');
  });

  it('is refused to an agent through a direct profile update, so the grant is not the only guard', async () => {
    const agent = await createAuthUser(db, { name: 'Self Serve Agent' });
    const update = "update public.profiles set google_calendar_id = 'cal-self' where id = $1";
    expect((await pgError(userRows(db, agent, update, [agent]))).code).toBe('42501');
    expect(await calendarIdOf(agent)).toBeNull();
  });
});
