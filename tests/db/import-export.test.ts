// Stage 9 RPCs: find_duplicate_leads (admin-only duplicate lookup for the CSV import) and export_leads
// (keyset-paged, RLS-scoped rows for /api/leads/export).
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
const u = { admin: '', agent: '', other: '', inactiveAdmin: '', inactiveAgent: '' };
const lead = { acme: '', bakery: '', unassigned: '', agentSecond: '' };
const phone = { acme: '', bakery: '', unassigned: '' };

const FIND = 'select * from public.find_duplicate_leads($1::text[], $2::text[], $3::text[])';

interface DupRow {
  lead_id: string;
  business_name: string;
  city: string | null;
  phone: string;
  website_domain: string | null;
  dedupe_name_key: string;
}

function find(userId: string, phones: string[] | null, domains: string[] | null, nameKeys: string[] | null): Promise<DupRow[]> {
  return userRows<DupRow>(db, userId, FIND, [phones, domains, nameKeys]);
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.agent = await createAuthUser(db);
  u.other = await createAuthUser(db);
  u.inactiveAdmin = await createAuthUser(db, { role: 'ADMIN', active: false });
  u.inactiveAgent = await createAuthUser(db, { active: false });
  phone.acme = nextPhone();
  phone.bakery = nextPhone();
  phone.unassigned = nextPhone();
  lead.acme = (
    await createLeadRow(db, { business_name: 'Acme Plumbing', city: 'Austin', phone: phone.acme, website_domain: 'acme.test', assigned_to: u.agent, status: 'NEW', source: 'Yelp' })
  ).id;
  lead.bakery = (await createLeadRow(db, { business_name: 'Blue Sky Bakery', city: 'Dallas', phone: phone.bakery, assigned_to: u.other, status: 'CLIENT' })).id;
  lead.unassigned = (await createLeadRow(db, { business_name: 'Unassigned 100% Co', city: null, phone: phone.unassigned, notes: '=1+1' })).id;
  lead.agentSecond = (await createLeadRow(db, { business_name: 'Second Agent Lead', city: 'Austin', assigned_to: u.agent, status: 'CLIENT' })).id;
  await createLeadRow(db, { business_name: 'Inactive Agent Lead', assigned_to: u.inactiveAgent });
});

afterAll(async () => {
  await db?.close();
});

describe('find_duplicate_leads', () => {
  it('matches a normalized phone and returns the lead columns', async () => {
    expect(await find(u.admin, [phone.acme], [], [])).toEqual([
      {
        lead_id: lead.acme,
        business_name: 'Acme Plumbing',
        city: 'Austin',
        phone: phone.acme,
        website_domain: 'acme.test',
        dedupe_name_key: 'acmeplumbing|austin',
      },
    ]);
  });

  it('matches a website domain, ignoring case and surrounding spaces', async () => {
    expect((await find(u.admin, null, [' ACME.test '], null)).map((row) => row.lead_id)).toEqual([lead.acme]);
  });

  it('matches the business name + city key of any agent\'s lead and of unassigned leads', async () => {
    expect((await find(u.admin, [], [], [nameCityKey('BLUE-SKY bakery!', 'dallas') as string])).map((row) => row.lead_id)).toEqual([lead.bakery]);
    expect((await find(u.admin, [], [], [nameCityKey('Unassigned 100% Co', null) as string])).map((row) => row.lead_id)).toEqual([lead.unassigned]);
  });

  it('returns each matching lead once, whichever keys match, oldest first', async () => {
    const rows = await find(u.admin, [phone.acme, phone.unassigned], ['acme.test'], ['acmeplumbing|austin', 'blueskybakery|dallas']);
    expect(rows.map((row) => row.lead_id)).toEqual([lead.acme, lead.bakery, lead.unassigned]);
  });

  it('ignores blank keys and punctuation-only name keys, and returns nothing for unknown keys', async () => {
    expect(await find(u.admin, ['', '  '], [''], ['', '|austin'])).toEqual([]);
    expect(await find(u.admin, null, null, null)).toEqual([]);
    expect(await find(u.admin, ['+12125550000'], ['nope.test'], ['nobody|nowhere'])).toEqual([]);
  });

  it('is admin only: agents, disabled admins and anon get 42501', async () => {
    expect((await pgError(find(u.agent, [phone.acme], [], []))).code).toBe('42501');
    expect((await pgError(find(u.agent, [phone.bakery], [], []))).code).toBe('42501');
    expect((await pgError(find(u.inactiveAdmin, [phone.acme], [], []))).code).toBe('42501');
    expect((await pgError(anonRows(db, FIND, [[phone.acme], [], []]))).code).toBe('42501');
  });

  it('accepts up to 1000 keys per array and rejects more with 22023', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `+1212555${String(i).padStart(4, '0')}`);
    expect(await find(u.admin, many, many.map((_, i) => `d${i}.test`), many.map((_, i) => `n${i}|c`))).toEqual([]);
    expect((await find(u.admin, [...many.slice(1), phone.acme], [], [])).map((row) => row.lead_id)).toEqual([lead.acme]);
    expect((await pgError(find(u.admin, [...many, '+12125559999'], [], []))).code).toBe('22023');
    expect((await pgError(find(u.admin, [], [], [...many, 'x|y']))).code).toBe('22023');
  });
});

interface ExportRow {
  id: string;
  created_at: Date;
  business_name: string;
  assigned_to: string | null;
  notes: string | null;
}

const EXPORT_COLUMNS = 'id, created_at, business_name, assigned_to, notes';

function exportRows(userId: string, args: string, params: unknown[] = []): Promise<ExportRow[]> {
  return userRows<ExportRow>(db, userId, `select ${EXPORT_COLUMNS} from public.export_leads(${args})`, params);
}

describe('export_leads', () => {
  it('gives an agent only their own assigned leads, whatever agent or unassigned filter they pass', async () => {
    const own = [lead.acme, lead.agentSecond];
    expect((await exportRows(u.agent, '')).map((row) => row.id)).toEqual(own);
    expect((await exportRows(u.agent, 'p_assigned_to => $1::uuid', [u.other])).map((row) => row.id)).toEqual(own);
    expect((await exportRows(u.agent, 'p_unassigned => true')).map((row) => row.id)).toEqual(own);
    expect((await exportRows(u.other, '')).map((row) => row.id)).toEqual([lead.bakery]);
  });

  it('gives disabled users and anon nothing', async () => {
    expect(await exportRows(u.inactiveAgent, '')).toEqual([]);
    expect(await exportRows(u.inactiveAdmin, '')).toEqual([]);
    expect((await pgError(anonRows(db, 'select id from public.export_leads()'))).code).toBe('42501');
  });

  it('gives an admin every lead with the leads list filters', async () => {
    const all = await adminSqlRows<{ id: string }>(db, 'select id from public.leads order by created_at, id');
    expect((await exportRows(u.admin, '')).map((row) => row.id)).toEqual(all.map((row) => row.id));
    expect((await exportRows(u.admin, 'p_assigned_to => $1::uuid', [u.agent])).map((row) => row.id)).toEqual([lead.acme, lead.agentSecond]);
    expect((await exportRows(u.admin, 'p_unassigned => true')).map((row) => row.id)).toEqual([lead.unassigned]);
    expect((await exportRows(u.admin, 'p_statuses => $1::text[]::public.lead_status[]', [['CLIENT']])).map((row) => row.id)).toEqual([lead.bakery, lead.agentSecond]);
    expect((await exportRows(u.admin, 'p_source => $1', ['Yelp'])).map((row) => row.id)).toEqual([lead.acme]);
    expect((await exportRows(u.admin, 'p_query => $1', ['100%'])).map((row) => row.id)).toEqual([lead.unassigned]);
    expect((await exportRows(u.admin, 'p_query => $1', ['blue sky'])).map((row) => row.id)).toEqual([lead.bakery]);
    expect((await exportRows(u.admin, 'p_query => $1', [phone.bakery.slice(2)])).map((row) => row.id)).toEqual([lead.bakery]);
    const unassigned = await exportRows(u.admin, 'p_unassigned => true');
    expect(unassigned[0].notes).toBe('=1+1');
  });

  it('pages with a (created_at, id) keyset that returns every row exactly once', async () => {
    const all = (await exportRows(u.admin, '')).map((row) => row.id);
    const seen: string[] = [];
    let after: ExportRow | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: ExportRow[] = after
        ? await exportRows(u.admin, 'p_after_created_at => $1::timestamptz, p_after_id => $2::uuid, p_limit => 2', [after.created_at, after.id])
        : await exportRows(u.admin, 'p_limit => 2');
      seen.push(...page.map((row) => row.id));
      if (page.length < 2) break;
      after = page[page.length - 1];
    }
    expect(seen).toEqual(all);
  });

  it('clamps the page size to 1..1000', async () => {
    expect(await exportRows(u.admin, 'p_limit => 0')).toHaveLength(1);
    expect((await exportRows(u.admin, 'p_limit => 100000')).length).toBeLessThanOrEqual(1000);
  });
});
