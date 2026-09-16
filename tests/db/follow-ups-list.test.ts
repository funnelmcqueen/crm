// list_follow_ups / follow_up_tab_counts (SPEC 8 Follow-ups, SPEC 1 isolation): tab boundaries in the
// caller's time zone, ordering, paging, RLS scoping, owner names for admins only, and reassignment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endOfDayInTz } from '@/lib/domain/time';
import {
  adminSqlRows,
  anonRows,
  asUser,
  bootDb,
  createAuthUser,
  createCallRow,
  createFollowUpRow,
  createLeadRow,
  fakeTwilioSid,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TABS = ['overdue', 'today', 'upcoming', 'completed'] as const;
type Tab = (typeof TABS)[number];

let db: PGlite;

interface Row {
  follow_up_id: string;
  lead_id: string;
  business_name: string;
  phone: string;
  lead_status: string;
  due_at: Date;
  completed_at: Date | null;
  note: string | null;
  owner_name: string | null;
  total_count: number | bigint;
}

type Counts = Record<Tab | 'voicemails_unheard' | 'voicemails_total', number>;

function list(userId: string, tab: string | null, limit = 100, offset = 0): Promise<Row[]> {
  return userRows<Row>(db, userId, 'select * from public.list_follow_ups($1, $2, $3)', [tab, limit, offset]);
}

async function ids(userId: string, tab: Tab): Promise<string[]> {
  return (await list(userId, tab)).map((row) => row.follow_up_id);
}

async function counts(userId: string): Promise<Counts> {
  const [row] = await userRows<{ c: Counts }>(db, userId, 'select public.follow_up_tab_counts() as c');
  return row.c;
}

async function deactivate(userId: string): Promise<void> {
  await db.query('update public.profiles set active = false where id = $1', [userId]);
}

interface Planned {
  id: string;
  due: number;
  completedAt: number | null;
}

/** The tab a follow-up belongs to for a viewer whose day ends at `endOfToday`, judged at `now`. */
function tabOf(item: Planned, now: number, endOfToday: number): Tab {
  if (item.completedAt !== null) return 'completed';
  if (item.due < now) return 'overdue';
  if (item.due < endOfToday) return 'today';
  return 'upcoming';
}

function expectedIds(items: Planned[], tab: Tab, now: number, endOfToday: number): string[] {
  const inTab = items.filter((item) => tabOf(item, now, endOfToday) === tab);
  // Ties break on id ascending, like the SQL (uuid order equals lowercase hex string order).
  const byId = (a: Planned, b: Planned) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (tab === 'completed') inTab.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || byId(a, b));
  else inTab.sort((a, b) => a.due - b.due || byId(a, b));
  return inTab.map((item) => item.id);
}

beforeAll(async () => {
  db = await bootDb();
});

afterAll(async () => {
  await db?.close();
});

describe('end of today matches the domain helper', () => {
  it.each(['America/New_York', 'Pacific/Auckland', 'Asia/Kolkata'])('%s', async (tz) => {
    const [row] = await adminSqlRows<{ e: Date }>(
      db,
      `select (date_trunc('day', now() at time zone $1) + interval '1 day') at time zone $1 as e`,
      [tz],
    );
    expect(row.e.getTime()).toBe(endOfDayInTz(tz, Date.now()).getTime());
  });
});

describe('tab boundaries in the caller time zone (America/New_York vs Pacific/Auckland)', () => {
  const zones = { ny: 'America/New_York', akl: 'Pacific/Auckland' } as const;
  const users = { ny: '', akl: '', admin: '' };
  const planned: Record<'ny' | 'akl', Planned[]> = { ny: [], akl: [] };
  let now = 0;
  const ends = { ny: 0, akl: 0 };

  beforeAll(async () => {
    users.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Tab Admin', timezone: zones.ny });
    users.ny = await createAuthUser(db, { name: 'Nia York', timezone: zones.ny });
    users.akl = await createAuthUser(db, { name: 'Aroha Auckland', timezone: zones.akl });

    now = Date.now();
    ends.ny = endOfDayInTz(zones.ny, now).getTime();
    ends.akl = endOfDayInTz(zones.akl, now).getTime();
    // Due between the two local midnights: "today" for the zone whose day ends later, "upcoming" for the other.
    const between = Math.round((ends.ny + ends.akl) / 2);

    for (const key of ['ny', 'akl'] as const) {
      const end = ends[key];
      const lead = await createLeadRow(db, { assigned_to: users[key], business_name: `Tab lead ${key}` });
      const plan: Array<{ due: number; completedAt?: number }> = [
        { due: now - 3 * DAY },
        { due: now - 5 * SECOND },
        { due: now + Math.round((end - now) / 2) },
        { due: end - 1 },
        { due: end },
        { due: end + 5 * DAY },
        { due: between },
        { due: now - DAY, completedAt: now - 2 * HOUR },
        { due: now + 2 * DAY, completedAt: now - HOUR },
      ];
      for (const [index, item] of plan.entries()) {
        const row = await createFollowUpRow(db, {
          lead_id: lead.id,
          user_id: users[key],
          due_at: new Date(item.due),
          completed_at: item.completedAt === undefined ? null : new Date(item.completedAt),
          note: `${key} #${index}`,
        });
        planned[key].push({ id: row.id, due: item.due, completedAt: item.completedAt ?? null });
      }
    }
  });

  it('puts each follow-up in the right tab, ordered as specified, for each agent', async () => {
    for (const key of ['ny', 'akl'] as const) {
      for (const tab of TABS) {
        expect(await ids(users[key], tab), `${key} ${tab}`).toEqual(expectedIds(planned[key], tab, now, ends[key]));
      }
    }
  });

  it('treats end-of-day as exclusive: 1 ms before local midnight is today, midnight itself is upcoming', async () => {
    for (const key of ['ny', 'akl'] as const) {
      const lastMoment = planned[key].find((item) => item.due === ends[key] - 1);
      const midnight = planned[key].find((item) => item.due === ends[key]);
      expect(await ids(users[key], 'today')).toContain(lastMoment?.id);
      expect(await ids(users[key], 'upcoming')).toContain(midnight?.id);
    }
  });

  it('the same instant is today in one zone and upcoming in the other', async () => {
    const between = Math.round((ends.ny + ends.akl) / 2);
    const nyItem = planned.ny.find((item) => item.due === between && item.completedAt === null);
    const aklItem = planned.akl.find((item) => item.due === between && item.completedAt === null);
    const nyEndsLater = ends.ny > ends.akl;
    expect(await ids(users.ny, nyEndsLater ? 'today' : 'upcoming')).toContain(nyItem?.id);
    expect(await ids(users.akl, nyEndsLater ? 'upcoming' : 'today')).toContain(aklItem?.id);
  });

  it('counts match the lists', async () => {
    for (const key of ['ny', 'akl'] as const) {
      const c = await counts(users[key]);
      for (const tab of TABS) expect(c[tab], `${key} ${tab}`).toBe(expectedIds(planned[key], tab, now, ends[key]).length);
      expect(c.voicemails_unheard).toBe(0);
      expect(c.voicemails_total).toBe(0);
    }
  });

  it("an admin sees every agent's follow-ups with the admin's own day boundary and owner names", async () => {
    const all = [...planned.ny, ...planned.akl];
    for (const tab of TABS) {
      const rows = await list(users.admin, tab);
      const mine = rows.map((row) => row.follow_up_id).filter((id) => all.some((item) => item.id === id));
      // The admin is in New York, so the Auckland agent's rows are split by the New York day boundary.
      expect(mine, tab).toEqual(expectedIds(all, tab, now, ends.ny));
    }
    const overdue = await list(users.admin, 'overdue');
    const names = new Map(overdue.map((row) => [row.follow_up_id, row.owner_name]));
    expect(names.get(planned.ny[0].id)).toBe('Nia York');
    expect(names.get(planned.akl[0].id)).toBe('Aroha Auckland');
  });

  it('agents never get owner names', async () => {
    for (const key of ['ny', 'akl'] as const) {
      for (const tab of TABS) {
        expect((await list(users[key], tab)).every((row) => row.owner_name === null)).toBe(true);
      }
    }
  });

  it('returns lead fields and a total count', async () => {
    const rows = await list(users.ny, 'overdue');
    expect(rows[0]).toMatchObject({ business_name: 'Tab lead ny', lead_status: 'NEW', note: 'ny #0' });
    expect(Number(rows[0].total_count)).toBe(rows.length);
  });
});

describe('scoping (RLS)', () => {
  const u = { a: '', b: '', admin: '' };
  const f = { aOpen: '', aDone: '', bOpen: '', bDone: '', aOnBLead: '', bOnALead: '' };

  beforeAll(async () => {
    u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Scope Admin' });
    u.a = await createAuthUser(db, { name: 'Scope Agent A' });
    u.b = await createAuthUser(db, { name: 'Scope Agent B' });
    const leadA = await createLeadRow(db, { assigned_to: u.a });
    const leadB = await createLeadRow(db, { assigned_to: u.b });
    const past = new Date(Date.now() - 2 * DAY);
    const future = new Date(Date.now() + 3 * DAY);
    f.aOpen = (await createFollowUpRow(db, { lead_id: leadA.id, user_id: u.a, due_at: past })).id;
    f.aDone = (await createFollowUpRow(db, { lead_id: leadA.id, user_id: u.a, due_at: past, completed_at: new Date() })).id;
    f.bOpen = (await createFollowUpRow(db, { lead_id: leadB.id, user_id: u.b, due_at: past })).id;
    f.bDone = (await createFollowUpRow(db, { lead_id: leadB.id, user_id: u.b, due_at: future, completed_at: new Date() })).id;
    // Rows whose user and lead owner disagree are visible to neither agent.
    f.aOnBLead = (await createFollowUpRow(db, { lead_id: leadB.id, user_id: u.a, due_at: future })).id;
    f.bOnALead = (await createFollowUpRow(db, { lead_id: leadA.id, user_id: u.b, due_at: future })).id;
    await createCallRow(db, {
      lead_id: leadB.id,
      user_id: u.b,
      direction: 'INBOUND',
      mode: 'IN_APP',
      provider_call_sid: fakeTwilioSid('CA'),
      voicemail_recording_sid: fakeTwilioSid('RE'),
    });
  });

  it("agent A never sees B's follow-ups in any tab", async () => {
    const seenByA = (await Promise.all(TABS.map((tab) => ids(u.a, tab)))).flat();
    expect(seenByA.sort()).toEqual([f.aOpen, f.aDone].sort());
    const seenByB = (await Promise.all(TABS.map((tab) => ids(u.b, tab)))).flat();
    expect(seenByB.sort()).toEqual([f.bOpen, f.bDone].sort());
  });

  it("counts exclude B's follow-ups and voicemails", async () => {
    // B's single voicemail is unheard, so B's badge and unheard count agree here; A has none at all.
    expect(await counts(u.a)).toEqual({ overdue: 1, today: 0, upcoming: 0, completed: 1, voicemails_unheard: 0, voicemails_total: 0 });
    expect(await counts(u.b)).toEqual({ overdue: 1, today: 0, upcoming: 0, completed: 1, voicemails_unheard: 1, voicemails_total: 1 });
  });

  it('voicemails_unheard equals unheard_voicemail_count for every caller', async () => {
    for (const user of [u.a, u.b, u.admin]) {
      const [row] = await userRows<{ n: number }>(db, user, 'select public.unheard_voicemail_count() as n');
      expect((await counts(user)).voicemails_unheard).toBe(row.n);
    }
  });

  it('an admin sees all of them', async () => {
    const seen = new Set((await Promise.all(TABS.map((tab) => ids(u.admin, tab)))).flat());
    for (const id of Object.values(f)) expect(seen.has(id)).toBe(true);
    const upcoming = await list(u.admin, 'upcoming');
    expect(upcoming.find((row) => row.follow_up_id === f.aOnBLead)?.owner_name).toBe('Scope Agent A');
  });

  it('a disabled agent gets no rows and zero counts', async () => {
    const lead = await createLeadRow(db);
    const gone = await createAuthUser(db, { name: 'Soon Disabled' });
    await db.query('update public.leads set assigned_to = $1 where id = $2', [gone, lead.id]);
    await createFollowUpRow(db, { lead_id: lead.id, user_id: gone, due_at: new Date(Date.now() - HOUR) });
    expect(await ids(gone, 'overdue')).toHaveLength(1);
    await deactivate(gone);
    for (const tab of TABS) expect(await ids(gone, tab)).toEqual([]);
    expect(await counts(gone)).toEqual({ overdue: 0, today: 0, upcoming: 0, completed: 0, voicemails_unheard: 0, voicemails_total: 0 });
  });

  it('anon cannot execute either function', async () => {
    expect((await pgError(anonRows(db, 'select * from public.list_follow_ups($1)', ['today']))).code).toBe('42501');
    expect((await pgError(anonRows(db, 'select public.follow_up_tab_counts()'))).code).toBe('42501');
  });

  it('rejects an invalid tab with 22023', async () => {
    for (const tab of ['bogus', '', null, 'voicemails']) {
      expect((await pgError(list(u.a, tab))).code, String(tab)).toBe('22023');
    }
  });
});

describe('paging', () => {
  let agent = '';
  const created: string[] = [];

  beforeAll(async () => {
    agent = await createAuthUser(db, { name: 'Paging Agent' });
    const lead = await createLeadRow(db, { assigned_to: agent });
    for (let i = 1; i <= 3; i += 1) {
      created.push((await createFollowUpRow(db, { lead_id: lead.id, user_id: agent, due_at: new Date(Date.now() + (10 + i) * DAY) })).id);
    }
  });

  it('clamps the limit to 1..100 and the offset to >= 0, with the full total on every page', async () => {
    const one = await list(agent, 'upcoming', 0);
    expect(one.map((row) => row.follow_up_id)).toEqual([created[0]]);
    expect(Number(one[0].total_count)).toBe(3);
    expect((await list(agent, 'upcoming', 1000)).map((row) => row.follow_up_id)).toEqual(created);
    expect((await list(agent, 'upcoming', 25, -5)).map((row) => row.follow_up_id)).toEqual(created);
    const last = await list(agent, 'upcoming', 2, 2);
    expect(last.map((row) => row.follow_up_id)).toEqual([created[2]]);
    expect(Number(last[0].total_count)).toBe(3);
    const [dflt] = await userRows<{ n: number }>(db, agent, `select count(*)::int as n from public.list_follow_ups('upcoming')`);
    expect(dflt.n).toBe(3);
  });
});

describe('reassignment', () => {
  const u = { from: '', to: '', admin: '' };
  let openId = '';
  let doneId = '';

  beforeAll(async () => {
    u.admin = await createAuthUser(db, { role: 'ADMIN', name: 'Move Admin' });
    u.from = await createAuthUser(db, { name: 'Previous Owner' });
    u.to = await createAuthUser(db, { name: 'New Owner' });
    const lead = await createLeadRow(db, { assigned_to: u.from });
    openId = (await createFollowUpRow(db, { lead_id: lead.id, user_id: u.from, due_at: new Date(Date.now() + 4 * DAY) })).id;
    doneId = (await createFollowUpRow(db, { lead_id: lead.id, user_id: u.from, due_at: new Date(Date.now() - DAY), completed_at: new Date() })).id;
    expect(await ids(u.from, 'upcoming')).toEqual([openId]);
    await asUser(db, u.admin, (tx) => tx.query('select public.reassign_leads($1::uuid[], $2::uuid)', [[lead.id], u.to]));
  });

  it('the new owner sees the moved open follow-up; the previous owner sees nothing', async () => {
    expect(await ids(u.to, 'upcoming')).toEqual([openId]);
    for (const tab of TABS) expect(await ids(u.from, tab), tab).toEqual([]);
    expect(await counts(u.from)).toEqual({ overdue: 0, today: 0, upcoming: 0, completed: 0, voicemails_unheard: 0, voicemails_total: 0 });
  });

  it("the completed follow-up keeps its user, so neither agent lists it; the admin still does", async () => {
    expect(await ids(u.to, 'completed')).toEqual([]);
    const completed = await list(u.admin, 'completed');
    expect(completed.find((row) => row.follow_up_id === doneId)?.owner_name).toBe('Previous Owner');
    expect((await list(u.admin, 'upcoming')).find((row) => row.follow_up_id === openId)?.owner_name).toBe('New Owner');
  });
});
