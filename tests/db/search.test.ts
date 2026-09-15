// search_leads scoping, matching, sort whitelist, paging; list_lead_sources; dedupe_name_key parity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nameCityKey } from '../../src/lib/domain/dedupe';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createLeadRow,
  nextPhone,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '', inactive: '' };
const lead = { pizza: '', percent: '', underscore: '', bPizza: '', unassigned: '', inactive: '' };

interface SearchArgs {
  query?: string | null;
  statuses?: string[] | null;
  source?: string | null;
  assignedTo?: string | null;
  unassigned?: boolean;
  sort?: string;
  dir?: string;
  limit?: number | null;
  offset?: number | null;
}

interface SearchRow {
  id: string;
  business_name: string;
  total_count: number | bigint;
}

function search(userId: string, args: SearchArgs = {}): Promise<SearchRow[]> {
  return userRows<SearchRow>(
    db,
    userId,
    `select id, business_name, total_count from public.search_leads(
       p_query => $1, p_statuses => $2::text[]::public.lead_status[], p_source => $3, p_assigned_to => $4::uuid,
       p_unassigned => $5, p_sort => $6, p_dir => $7, p_limit => $8, p_offset => $9)`,
    [
      args.query ?? null,
      args.statuses ?? null,
      args.source ?? null,
      args.assignedTo ?? null,
      args.unassigned ?? false,
      args.sort ?? 'created_at',
      args.dir ?? 'desc',
      args.limit === undefined ? 25 : args.limit,
      args.offset === undefined ? 0 : args.offset,
    ],
  );
}

const names = (rows: SearchRow[]): string[] => rows.map((r) => r.business_name).sort();

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.a = await createAuthUser(db);
  u.b = await createAuthUser(db);
  u.inactive = await createAuthUser(db, { active: false });

  lead.pizza = (
    await createLeadRow(db, {
      assigned_to: u.a,
      business_name: "Joe's Pizza & Grill",
      contact_name: 'Joe Smith',
      email: 'joe@joespizza.test',
      website: 'https://joespizza.test/menu',
      city: 'Austin',
      phone: '+12125550142',
      source: 'Yelp',
      status: 'NEW',
      call_count: 2,
    })
  ).id;
  lead.percent = (await createLeadRow(db, { assigned_to: u.a, business_name: '100% Real Deal', source: 'Referral', status: 'INTERESTED', call_count: 7 })).id;
  lead.underscore = (await createLeadRow(db, { assigned_to: u.a, business_name: 'snake_case Studio', status: 'NO_ANSWER', call_count: 0 })).id;
  lead.bPizza = (
    await createLeadRow(db, { assigned_to: u.b, business_name: 'Pizza Palace', phone: '+13125550142', city: 'Austin', source: 'Google Maps' })
  ).id;
  lead.unassigned = (await createLeadRow(db, { business_name: 'Unassigned Pizza', source: 'Cold List' })).id;
  lead.inactive = (await createLeadRow(db, { assigned_to: u.inactive, business_name: 'Inactive Pizza', source: 'Secret' })).id;
});

afterAll(async () => {
  await db?.close();
});

describe('search_leads scoping', () => {
  it('agents only find their own leads; admins find all; inactive users and anon find nothing', async () => {
    expect(names(await search(u.a, { query: 'pizza' }))).toEqual(["Joe's Pizza & Grill"]);
    expect(names(await search(u.b, { query: 'pizza' }))).toEqual(['Pizza Palace']);
    expect(names(await search(u.admin, { query: 'pizza' }))).toEqual(['Inactive Pizza', "Joe's Pizza & Grill", 'Pizza Palace', 'Unassigned Pizza']);
    expect(await search(u.inactive, { query: 'pizza' })).toEqual([]);
    expect((await pgError(anonRows(db, `select * from public.search_leads('pizza')`))).code).toBe('42501');
  });

  it('ignores p_assigned_to and p_unassigned for agents', async () => {
    expect(names(await search(u.a, { query: 'pizza', assignedTo: u.b }))).toEqual(["Joe's Pizza & Grill"]);
    expect(names(await search(u.a, { query: 'pizza', unassigned: true }))).toEqual(["Joe's Pizza & Grill"]);
    expect(names(await search(u.a, { query: '5550142' }))).toEqual(["Joe's Pizza & Grill"]);
  });

  it('applies admin filters for agent and unassigned', async () => {
    expect(names(await search(u.admin, { query: 'pizza', assignedTo: u.b }))).toEqual(['Pizza Palace']);
    expect(names(await search(u.admin, { query: 'pizza', unassigned: true }))).toEqual(['Unassigned Pizza']);
  });

  it('total_count reflects only visible rows', async () => {
    const rows = await search(u.a, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_count)).toBe(3);
  });
});

describe('search_leads matching', () => {
  it.each([
    ['contact', 'smith'],
    ['email', 'JOE@JOESPIZZA'],
    ['website', 'joespizza.test/me'],
    ['city', 'aust'],
    ['business', "joe's"],
    ['phone digits', '(212) 555-0142'],
    ['partial phone digits', '555014'],
  ])('matches by %s', async (_field, query) => {
    expect(names(await search(u.a, { query }))).toEqual(["Joe's Pizza & Grill"]);
  });

  it('does not treat fewer than 3 digits as a phone search', async () => {
    expect(await search(u.a, { query: '42' })).toEqual([]);
  });

  it('escapes LIKE wildcards in the query', async () => {
    expect(names(await search(u.a, { query: '%' }))).toEqual(['100% Real Deal']);
    expect(names(await search(u.a, { query: '_' }))).toEqual(['snake_case Studio']);
    expect(await search(u.a, { query: '\\' })).toEqual([]);
    expect(await search(u.a, { query: 'x'.repeat(5000) })).toEqual([]);
  });

  it('filters by status list and exact source', async () => {
    expect(names(await search(u.a, { statuses: ['INTERESTED', 'NO_ANSWER'] }))).toEqual(['100% Real Deal', 'snake_case Studio']);
    expect(names(await search(u.a, { statuses: [] }))).toHaveLength(3);
    expect(names(await search(u.a, { source: ' Yelp ' }))).toEqual(["Joe's Pizza & Grill"]);
    expect(await search(u.a, { source: 'yelp' })).toEqual([]);
    expect(await search(u.a, { source: 'Google Maps' })).toEqual([]);
  });
});

describe('search_leads sorting and paging', () => {
  it('sorts by the whitelisted columns', async () => {
    expect((await search(u.a, { sort: 'business_name', dir: 'asc' })).map((r) => r.business_name)).toEqual([
      '100% Real Deal',
      "Joe's Pizza & Grill",
      'snake_case Studio',
    ]);
    expect((await search(u.a, { sort: 'call_count', dir: 'DESC' })).map((r) => r.business_name)).toEqual([
      '100% Real Deal',
      "Joe's Pizza & Grill",
      'snake_case Studio',
    ]);
  });

  it.each([
    'business_name; drop table public.leads; --',
    'created_at desc, (select 1)',
    '(select assigned_to)',
    'id',
    "'; select pg_sleep(1); --",
    '',
  ])('treats a hostile or unknown sort (%j) as created_at and runs no SQL from it', async (sort) => {
    const rows = await search(u.a, { sort, dir: 'asc; drop table public.leads' });
    expect(rows).toHaveLength(3);
    expect(await adminSqlRows(db, 'select count(*)::int as n from public.leads')).toEqual([{ n: 6 }]);
  });

  it('clamps limit to 1..100 and offset to >= 0', async () => {
    await db.query(
      `insert into public.leads (business_name, phone) select 'Bulk ' || g, '+1202555' || lpad((g % 100 + 100)::text, 4, '0') from generate_series(1, 105) g`,
    );
    try {
      const big = await search(u.admin, { query: 'bulk', limit: 1000 });
      expect(big).toHaveLength(100);
      expect(Number(big[0].total_count)).toBe(105);
      expect(await search(u.admin, { query: 'bulk', limit: 0 })).toHaveLength(1);
      expect(await search(u.admin, { query: 'bulk', limit: -5 })).toHaveLength(1);
      expect(await search(u.admin, { query: 'bulk', limit: null })).toHaveLength(25);
      expect(await search(u.admin, { query: 'bulk', offset: -10, limit: 100 })).toHaveLength(100);
      expect(await search(u.admin, { query: 'bulk', offset: 100, limit: 100 })).toHaveLength(5);
    } finally {
      await db.query(`delete from public.leads where business_name like 'Bulk %'`);
    }
  });
});

describe('list_lead_sources', () => {
  it('lists only sources of leads visible to the caller', async () => {
    const sources = async (userId: string) => (await userRows<{ s: string }>(db, userId, 'select s from public.list_lead_sources() s')).map((r) => r.s);
    expect(await sources(u.a)).toEqual(['Referral', 'Yelp']);
    expect(await sources(u.b)).toEqual(['Google Maps']);
    expect(await sources(u.admin)).toEqual(['Cold List', 'Google Maps', 'Referral', 'Secret', 'Yelp']);
    expect(await sources(u.inactive)).toEqual([]);
  });
});

describe('dedupe_name_key parity with nameCityKey()', () => {
  const SAMPLES: Array<[string, string | null]> = [
    ["Joe's Pizza & Grill", 'New York'],
    ['ACME, Inc.', null],
    ['ACME, Inc.', ''],
    ['Café Olé', 'São Paulo'],
    ['Straße GmbH', 'München'],
    ['ＡＣＭＥ Full Width', 'Tōkyō'],
    ['123 Plumbing', 'St. Louis'],
    ['  Tab\tName\n ', 'city_name'],
    ['Pizza \u{1F355} Place', 'Austin'],
    ['MiXeD CaSe_under_score', 'LOS-ANGELES'],
    ['a-b.c/d\\e', '"quoted"'],
    ['!!!', 'Austin'],
    ['x'.repeat(500), 'y'.repeat(300)],
    ['Zero​Width', 'Non Breaking'],
    ['İstanbul Kebab', 'İzmir'],
  ];

  it('the generated leads.dedupe_name_key equals nameCityKey for tricky names', async () => {
    for (const [business, city] of SAMPLES) {
      const row = await createLeadRow(db, { business_name: business, city, phone: nextPhone() });
      const jsKey = nameCityKey(business, city);
      if (jsKey === null) {
        expect(row.dedupe_name_key.startsWith('|')).toBe(true);
      } else {
        expect({ business, key: row.dedupe_name_key }).toEqual({ business, key: jsKey });
      }
    }
  });
});
