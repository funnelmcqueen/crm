// pipeline_column (stage 8): agent scoping like search_leads, admin filters, column order, paging, grants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  createLeadRow,
  pgError,
  userRows,
  type PGlite,
} from '../helpers/pglite';

let db: PGlite;
const u = { admin: '', a: '', b: '', inactive: '' };

interface ColumnArgs {
  statuses: string[] | null;
  limit?: number | null;
  offset?: number | null;
  assignedTo?: string | null;
  unassigned?: boolean;
}

interface ColumnRow {
  id: string;
  business_name: string;
  status: string;
  assigned_to: string | null;
  next_follow_up_at: Date | null;
  updated_at: Date;
  total_count: number | bigint;
}

function column(userId: string, args: ColumnArgs): Promise<ColumnRow[]> {
  return userRows<ColumnRow>(
    db,
    userId,
    `select id, business_name, status, assigned_to, next_follow_up_at, updated_at, total_count
       from public.pipeline_column(
         p_statuses => $1::text[]::public.lead_status[], p_limit => $2, p_offset => $3,
         p_assigned_to => $4::uuid, p_unassigned => $5)`,
    [args.statuses, args.limit === undefined ? 20 : args.limit, args.offset ?? 0, args.assignedTo ?? null, args.unassigned ?? false],
  );
}

const names = (rows: ColumnRow[]): string[] => rows.map((r) => r.business_name).sort();

async function setTimes(id: string, nextFollowUp: string | null, updatedAt: string): Promise<void> {
  // As postgres: the triggers would otherwise recompute both columns.
  await db.exec('alter table public.leads disable trigger user');
  try {
    await adminSqlRows(db, `update public.leads set next_follow_up_at = $2, updated_at = $3 where id = $1`, [id, nextFollowUp, updatedAt]);
  } finally {
    await db.exec('alter table public.leads enable trigger user');
  }
}

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.a = await createAuthUser(db);
  u.b = await createAuthUser(db);
  u.inactive = await createAuthUser(db, { active: false });

  await createLeadRow(db, { assigned_to: u.a, business_name: 'A new', status: 'NEW' });
  await createLeadRow(db, { assigned_to: u.a, business_name: 'A to call', status: 'TO_CALL' });
  await createLeadRow(db, { assigned_to: u.a, business_name: 'A no answer', status: 'NO_ANSWER' });
  await createLeadRow(db, { assigned_to: u.a, business_name: 'A voicemail', status: 'VOICEMAIL' });
  await createLeadRow(db, { assigned_to: u.b, business_name: 'B to call', status: 'TO_CALL' });
  await createLeadRow(db, { assigned_to: u.b, business_name: 'B new', status: 'NEW' });
  await createLeadRow(db, { business_name: 'Unassigned to call', status: 'TO_CALL' });
  await createLeadRow(db, { assigned_to: u.inactive, business_name: 'Inactive to call', status: 'TO_CALL' });
});

afterAll(async () => {
  await db?.close();
});

const TO_CALL = ['TO_CALL', 'NO_ANSWER', 'VOICEMAIL'];

describe('pipeline_column scoping', () => {
  it('agents see only their own leads; admins see all; inactive users see nothing; anon cannot execute', async () => {
    expect(names(await column(u.a, { statuses: TO_CALL }))).toEqual(['A no answer', 'A to call', 'A voicemail']);
    expect(names(await column(u.b, { statuses: TO_CALL }))).toEqual(['B to call']);
    expect(names(await column(u.admin, { statuses: TO_CALL }))).toEqual([
      'A no answer',
      'A to call',
      'A voicemail',
      'B to call',
      'Inactive to call',
      'Unassigned to call',
    ]);
    expect(await column(u.inactive, { statuses: TO_CALL })).toEqual([]);
    expect((await pgError(anonRows(db, `select * from public.pipeline_column(array['NEW']::public.lead_status[])`))).code).toBe('42501');
  });

  it('ignores p_assigned_to and p_unassigned for agents', async () => {
    expect(names(await column(u.a, { statuses: TO_CALL, assignedTo: u.b }))).toEqual(['A no answer', 'A to call', 'A voicemail']);
    expect(names(await column(u.a, { statuses: TO_CALL, unassigned: true }))).toEqual(['A no answer', 'A to call', 'A voicemail']);
  });

  it('applies the admin agent and unassigned filters', async () => {
    expect(names(await column(u.admin, { statuses: TO_CALL, assignedTo: u.b }))).toEqual(['B to call']);
    expect(names(await column(u.admin, { statuses: TO_CALL, unassigned: true }))).toEqual(['Unassigned to call']);
  });

  it('returns nothing for a null or empty status list', async () => {
    expect(await column(u.admin, { statuses: null })).toEqual([]);
    expect(await column(u.admin, { statuses: [] })).toEqual([]);
  });

  it('total_count counts only the visible rows of the column', async () => {
    const rows = await column(u.a, { statuses: TO_CALL, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_count)).toBe(3);
    const b = await column(u.b, { statuses: ['NEW'], limit: 1 });
    expect(Number(b[0].total_count)).toBe(1);
  });
});

describe('pipeline_column order and paging', () => {
  let agent = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    agent = await createAuthUser(db);
    for (const name of ['later', 'soon', 'none-old', 'none-new', 'tie-a', 'tie-b']) {
      ids[name] = (await createLeadRow(db, { assigned_to: agent, business_name: `order ${name}`, status: 'INTERESTED' })).id;
    }
    await setTimes(ids.later, '2030-01-02T00:00:00Z', '2026-01-01T00:00:00Z');
    await setTimes(ids.soon, '2030-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    await setTimes(ids['none-old'], null, '2026-01-01T00:00:00Z');
    await setTimes(ids['none-new'], null, '2026-06-01T00:00:00Z');
    await setTimes(ids['tie-a'], null, '2025-01-01T00:00:00Z');
    await setTimes(ids['tie-b'], null, '2025-01-01T00:00:00Z');
  });

  it('orders by next_follow_up_at asc nulls last, then updated_at desc, then id', async () => {
    const rows = await column(agent, { statuses: ['INTERESTED'] });
    const ties = [ids['tie-a'], ids['tie-b']].sort();
    expect(rows.map((r) => r.id)).toEqual([ids.soon, ids.later, ids['none-new'], ids['none-old'], ...ties]);
  });

  it('pages without repeats or gaps and clamps the limit to 1..100', async () => {
    const all = (await column(agent, { statuses: ['INTERESTED'] })).map((r) => r.id);
    const first = await column(agent, { statuses: ['INTERESTED'], limit: 4, offset: 0 });
    const second = await column(agent, { statuses: ['INTERESTED'], limit: 4, offset: 4 });
    expect([...first, ...second].map((r) => r.id)).toEqual(all);
    expect(second.every((r) => Number(r.total_count) === 6)).toBe(true);
    expect(await column(agent, { statuses: ['INTERESTED'], limit: 4, offset: 99 })).toEqual([]);
    expect(await column(agent, { statuses: ['INTERESTED'], limit: 0 })).toHaveLength(1);
    expect(await column(agent, { statuses: ['INTERESTED'], limit: -5, offset: -3 })).toHaveLength(1);
    expect(await column(agent, { statuses: ['INTERESTED'], limit: null, offset: null })).toHaveLength(6);
  });
});

describe('pipeline_column definition', () => {
  it('is SECURITY INVOKER with an empty search_path, executable by authenticated and service_role only', async () => {
    const [fn] = await adminSqlRows<{
      prosecdef: boolean;
      proconfig: string[];
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
    }>(
      db,
      `select p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'pipeline_column'`,
    );
    expect(fn).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: true, service_role: true });
  });
});
