import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Localbase } from '../../localbase/server';
import {
  FIXTURE_SQL,
  createConfirmedUser,
  makeClient,
  serviceClient,
  signedInClient,
  startTestLocalbase,
} from './helpers';

let lb: Localbase;
let alice: SupabaseClient;
let bob: SupabaseClient;
let anon: SupabaseClient;
let service: SupabaseClient;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  lb = await startTestLocalbase();
  await lb.db.exec(FIXTURE_SQL);
  aliceId = await createConfirmedUser(lb, 'alice@rest.test');
  bobId = await createConfirmedUser(lb, 'bob@rest.test');
  const insert = `insert into public.items (owner, name, kind, qty, tags, meta, code) values ($1, $2, $3, $4, $5, $6, $7)`;
  const rows: [string, string, string, number | null, string | null, string | null, string][] = [
    [aliceId, 'Alpha', 'A', 1, '{red,blue}', '{"level":1}', 'a1'],
    [aliceId, 'Beta, Inc. (West)', 'B', 5, '{blue}', null, 'a2'],
    [aliceId, 'gamma', 'C', null, null, null, 'a3'],
    [aliceId, 'Delta "quoted"', 'A', 10, '{green}', null, 'a4'],
    [aliceId, 'epsilon', 'B', 3, null, null, 'a5'],
    [bobId, 'Bob thing', 'A', 2, null, null, 'b1'],
    [bobId, 'Beta, Inc. (West)', 'B', 7, null, null, 'b2'],
  ];
  for (const row of rows) await lb.db.query(insert, row);
  alice = await signedInClient(lb, 'alice@rest.test');
  bob = await signedInClient(lb, 'bob@rest.test');
  anon = makeClient(lb);
  service = serviceClient(lb);
});

afterAll(async () => {
  await lb?.stop();
});

async function names(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<string[]> {
  const { data, error } = await query;
  expect(error).toBeNull();
  return (data as { name: string }[]).map((r) => r.name).sort();
}

describe('select', () => {
  it('returns column lists, aliases and casts', async () => {
    const { data, error, status } = await alice.from('items').select('name, amount:qty, qty_text:qty::text').eq('code', 'a2');
    expect(error).toBeNull();
    expect(status).toBe(200);
    expect(data).toEqual([{ name: 'Beta, Inc. (West)', amount: 5, qty_text: '5' }]);
  });

  it('serializes arrays, jsonb and timestamptz like PostgREST', async () => {
    const { data } = await alice.from('items').select('tags, meta, created_at').eq('code', 'a1').single();
    expect(data).toMatchObject({ tags: ['red', 'blue'], meta: { level: 1 } });
    expect((data as { created_at: string }).created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);
  });
});

describe('filters', () => {
  it('supports comparison operators', async () => {
    expect(await names(alice.from('items').select('name').eq('kind', 'B'))).toEqual(['Beta, Inc. (West)', 'epsilon']);
    expect(await names(alice.from('items').select('name').neq('kind', 'A'))).toEqual(['Beta, Inc. (West)', 'epsilon', 'gamma']);
    expect(await names(alice.from('items').select('name').gt('qty', 3))).toEqual(['Beta, Inc. (West)', 'Delta "quoted"']);
    expect(await names(alice.from('items').select('name').gte('qty', 5))).toEqual(['Beta, Inc. (West)', 'Delta "quoted"']);
    expect(await names(alice.from('items').select('name').lt('qty', 3))).toEqual(['Alpha']);
    expect(await names(alice.from('items').select('name').lte('qty', 3))).toEqual(['Alpha', 'epsilon']);
  });

  it('supports like, ilike (with * wildcards), match and imatch', async () => {
    expect(await names(alice.from('items').select('name').like('name', '%lph%'))).toEqual(['Alpha']);
    expect(await names(alice.from('items').select('name').like('name', '*lph*'))).toEqual(['Alpha']);
    expect(await names(alice.from('items').select('name').ilike('name', 'ALPHA'))).toEqual(['Alpha']);
    expect(await names(alice.from('items').select('name').ilike('name', '*GAM*'))).toEqual(['gamma']);
    expect(await names(alice.from('items').select('name').filter('name', 'match', '^[A-Z]'))).toEqual([
      'Alpha',
      'Beta, Inc. (West)',
      'Delta "quoted"',
    ]);
    expect(await names(alice.from('items').select('name').filter('name', 'imatch', '^G'))).toEqual(['gamma']);
  });

  it('supports is null / not is null / isdistinct', async () => {
    expect(await names(alice.from('items').select('name').is('qty', null))).toEqual(['gamma']);
    expect(await names(alice.from('items').select('name').not('qty', 'is', null))).toHaveLength(4);
    expect(await names(alice.from('items').select('name').filter('qty', 'isdistinct', '5'))).toEqual([
      'Alpha',
      'Delta "quoted"',
      'epsilon',
      'gamma',
    ]);
  });

  it('supports in / not.in with quoted values containing commas and parentheses', async () => {
    expect(await names(alice.from('items').select('name').in('name', ['Beta, Inc. (West)', 'Alpha']))).toEqual([
      'Alpha',
      'Beta, Inc. (West)',
    ]);
    expect(await names(alice.from('items').select('name').not('name', 'in', '("Beta, Inc. (West)",Alpha)'))).toEqual([
      'Delta "quoted"',
      'epsilon',
      'gamma',
    ]);
    expect(await names(alice.from('items').select('name').in('code', []))).toEqual([]);
  });

  it('supports or/and nesting with quoted values', async () => {
    expect(
      await names(alice.from('items').select('name').or('name.eq."Beta, Inc. (West)",and(kind.eq.C,qty.is.null)')),
    ).toEqual(['Beta, Inc. (West)', 'gamma']);
    expect(await names(alice.from('items').select('name').or('qty.gte.10,not.and(kind.eq.A,qty.lt.100)'))).toEqual([
      'Beta, Inc. (West)',
      'Delta "quoted"',
      'epsilon',
      'gamma',
    ]);
    expect(await names(alice.from('items').select('name').or('name.eq."Delta \\"quoted\\"",code.in.(a1,"a,3")'))).toEqual([
      'Alpha',
      'Delta "quoted"',
    ]);
    expect(await names(alice.from('items').select('name').eq('kind', 'A').or('qty.eq.1,qty.eq.10'))).toEqual([
      'Alpha',
      'Delta "quoted"',
    ]);
  });

  it('supports array operators and quantifiers', async () => {
    expect(await names(alice.from('items').select('name').contains('tags', ['blue']))).toEqual(['Alpha', 'Beta, Inc. (West)']);
    expect(await names(alice.from('items').select('name').overlaps('tags', ['green', 'red']))).toEqual(['Alpha', 'Delta "quoted"']);
    expect(await names(alice.from('items').select('name').containedBy('tags', ['red', 'blue', 'x']))).toEqual([
      'Alpha',
      'Beta, Inc. (West)',
    ]);
    expect(await names(alice.from('items').select('name').filter('code', 'eq(any)', '{a1,a3}'))).toEqual(['Alpha', 'gamma']);
    expect(await names(alice.from('items').select('name').likeAnyOf('name', ['Al%', 'ga%']))).toEqual(['Alpha', 'gamma']);
  });
});

describe('ordering, paging and counts', () => {
  it('orders with nulls first/last and multiple columns', async () => {
    const first = await alice.from('items').select('name').order('qty', { ascending: true, nullsFirst: true });
    expect((first.data as { name: string }[])[0].name).toBe('gamma');
    const last = await alice.from('items').select('name, qty').order('qty', { ascending: false, nullsFirst: false });
    const rows = last.data as { name: string }[];
    expect(rows[0].name).toBe('Delta "quoted"');
    expect(rows[rows.length - 1].name).toBe('gamma');
    const multi = await alice.from('items').select('kind, name').order('kind', { ascending: false }).order('name');
    expect((multi.data as { name: string }[]).map((r) => r.name)).toEqual([
      'gamma',
      'Beta, Inc. (West)',
      'epsilon',
      'Alpha',
      'Delta "quoted"',
    ]);
  });

  it('supports limit, range with exact count (206) and head', async () => {
    const limited = await alice.from('items').select('name').order('name').limit(2);
    expect(limited.data).toHaveLength(2);

    const ranged = await alice.from('items').select('name', { count: 'exact' }).order('name').range(1, 2);
    expect(ranged.error).toBeNull();
    expect(ranged.status).toBe(206);
    expect(ranged.count).toBe(5);
    expect((ranged.data as { name: string }[]).map((r) => r.name)).toEqual(['Beta, Inc. (West)', 'Delta "quoted"']);

    const head = await alice.from('items').select('*', { count: 'exact', head: true });
    expect(head.error).toBeNull();
    expect(head.data).toBeNull();
    expect(head.count).toBe(5);

    const all = await alice.from('items').select('id', { count: 'exact' });
    expect(all.status).toBe(200);
    expect(all.count).toBe(5);
  });

  it('rejects planned and estimated counts instead of silently computing an exact count', async () => {
    for (const count of ['planned', 'estimated'] as const) {
      const table = await alice.from('items').select('id', { count });
      expect(table.status, count).toBe(400);
      expect(table.error?.code, count).toBe('PGRST100');
      expect(table.count, count).toBeNull();
      const rpc = await alice.rpc('fx_items', {}, { count });
      expect(rpc.status, count).toBe(400);
      expect(rpc.error?.code, count).toBe('PGRST100');
    }
  });

  it('single and maybeSingle', async () => {
    const none = await alice.from('items').select('name').eq('code', 'zzz').single();
    expect(none.status).toBe(406);
    expect(none.error).toMatchObject({ code: 'PGRST116', details: 'The result contains 0 rows' });

    const one = await alice.from('items').select('name').eq('code', 'a1').single();
    expect(one.error).toBeNull();
    expect(one.data).toEqual({ name: 'Alpha' });

    const maybeNone = await alice.from('items').select('name').eq('code', 'zzz').maybeSingle();
    expect(maybeNone.error).toBeNull();
    expect(maybeNone.data).toBeNull();

    const maybeMany = await alice.from('items').select('name').maybeSingle();
    expect(maybeMany.error).toMatchObject({ code: 'PGRST116' });
  });
});

describe('rpc', () => {
  it('converts uuid[], timestamptz, enum, jsonb args and applies defaults', async () => {
    const ids = ['6f1c1a5e-6d2c-4b8e-9a53-0d9e3c1f0a11', '0b6a4a9e-3a7d-4f0e-8a6b-2f1c9d8e7a65'];
    const { data, error } = await alice.rpc('fx_types', {
      p_ids: ids,
      p_at: '2026-01-02T03:04:05Z',
      p_kind: 'B',
      p_meta: { a: [1, { b: true }] },
    });
    expect(error).toBeNull();
    expect(data).toEqual({
      ids,
      ids_type: 'uuid[]',
      at: '2026-01-02T03:04:05+00:00',
      at_type: 'timestamp with time zone',
      kind: 'B',
      kind_type: 'item_kind',
      meta: { a: [1, { b: true }] },
      meta_type: 'jsonb',
      n: 7,
      label: 'dflt',
    });
    const overridden = await alice.rpc('fx_types', { p_ids: [], p_at: null, p_kind: 'A', p_meta: null, p_n: 3 });
    expect(overridden.data).toMatchObject({ ids: [], n: 3, label: 'dflt', at: null, meta: null });
  });

  it('returns table functions as arrays and supports select/filter/order/limit/count/single', async () => {
    const all = await alice.rpc('fx_items');
    expect(all.error).toBeNull();
    expect((all.data as { name: string }[]).map((r) => r.name)).toEqual([
      'Alpha',
      'Beta, Inc. (West)',
      'Delta "quoted"',
      'epsilon',
      'gamma',
    ]);
    const shaped = await alice.rpc('fx_items', { p_min: 3 }).select('name').order('qty', { ascending: false }).limit(1);
    expect(shaped.data).toEqual([{ name: 'Delta "quoted"' }]);
    const counted = await alice.rpc('fx_items', {}, { count: 'exact' });
    expect(counted.count).toBe(5);
    const single = await alice.rpc('fx_items').eq('name', 'gamma').single();
    expect(single.data).toMatchObject({ name: 'gamma', qty: null });
    const bobs = await bob.rpc('fx_items');
    expect((bobs.data as unknown[]).length).toBe(2);
  });

  it('returns setof scalar, scalar, composite and void shapes', async () => {
    expect((await alice.rpc('fx_names')).data).toEqual(['x', 'y', 'z']);
    expect((await alice.rpc('fx_add', { a: 2, b: 3 })).data).toBe(5);
    expect((await alice.rpc('fx_note')).data).toEqual({ id: 1, body: 'hello', secret: 'classified' });
    const voided = await alice.rpc('fx_void');
    expect(voided.error).toBeNull();
    expect(voided.status).toBe(204);
    expect(voided.data).toBeNull();
  });

  it('runs as the JWT role with claims set', async () => {
    const { data } = await alice.rpc('fx_whoami');
    expect(data).toEqual({ current_user: 'authenticated', uid: aliceId, role: 'authenticated', method: 'POST' });
    const anonWho = await anon.rpc('fx_whoami');
    expect(anonWho.data).toMatchObject({ current_user: 'anon', uid: null, role: 'anon' });
    const serviceWho = await service.rpc('fx_whoami');
    expect(serviceWho.data).toMatchObject({ current_user: 'service_role' });
  });

  it('supports GET rpc and rejects writes in read-only GET', async () => {
    expect((await alice.rpc('fx_add', { a: 1, b: 2 }, { get: true })).data).toBe(3);
    const write = await service.rpc('fx_bump', {}, { get: true });
    expect(write.status).toBe(405);
    expect(write.error).toMatchObject({ code: '25006' });
  });

  it('reports missing functions and argument mismatches as PGRST202', async () => {
    const missing = await alice.rpc('nope');
    expect(missing.status).toBe(404);
    expect(missing.error).toMatchObject({ code: 'PGRST202' });
    const missingArg = await alice.rpc('fx_add', { a: 1 });
    expect(missingArg.status).toBe(404);
    expect(missingArg.error).toMatchObject({ code: 'PGRST202' });
    const extraArg = await alice.rpc('fx_add', { a: 1, b: 2, c: 3 });
    expect(extraArg.error).toMatchObject({ code: 'PGRST202' });
  });

  it('enforces EXECUTE grants', async () => {
    const denied = await anon.rpc('fx_authed_only');
    expect(denied.status).toBe(401);
    expect(denied.error).toMatchObject({ code: '42501' });
    expect((await alice.rpc('fx_authed_only')).data).toBe(42);
  });
});

describe('errors', () => {
  it('uses the PostgREST error shape and status mapping', async () => {
    const badUuid = await alice.from('items').select('id').eq('id', 'nope');
    expect(badUuid.status).toBe(400);
    expect(badUuid.error).toEqual({ code: '22P02', details: null, hint: null, message: 'invalid input syntax for type uuid: "nope"' });

    const badColumn = await alice.from('items').select('nope');
    expect(badColumn.status).toBe(400);
    expect(badColumn.error).toMatchObject({ code: '42703' });

    const badTable = await alice.from('nope').select('id');
    expect(badTable.status).toBe(404);
    expect(badTable.error).toMatchObject({ code: '42P01' });

    const raised = await alice.rpc('fx_raise', { p_code: 'P0001', p_message: 'do_not_contact' });
    expect(raised.status).toBe(400);
    expect(raised.error).toEqual({ code: 'P0001', details: 'the detail', hint: 'the hint', message: 'do_not_contact' });
    expect((await alice.rpc('fx_raise', { p_code: 'P0002' })).status).toBe(500);
    expect((await alice.rpc('fx_raise', { p_code: '22023' })).status).toBe(400);
    expect((await alice.rpc('fx_raise', { p_code: '42501' })).status).toBe(403);
    expect((await anon.rpc('fx_raise', { p_code: '42501' })).status).toBe(401);
    expect((await alice.rpc('fx_raise', { p_code: 'PT418' })).status).toBe(418);

    const duplicate = await alice.from('items').insert({ name: 'dup', code: 'a1' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.error).toMatchObject({ code: '23505' });

    const fk = await service.from('children').insert({ id: 1, item_id: '6f1c1a5e-6d2c-4b8e-9a53-0d9e3c1f0a11' });
    expect(fk.status).toBe(409);
    expect(fk.error).toMatchObject({ code: '23503' });
  });

  it('rejects unsupported syntax instead of ignoring it', async () => {
    const unknownOperator = await alice.from('items').select('id').filter('qty', 'foo', '1');
    expect(unknownOperator.status).toBe(400);
    expect(unknownOperator.error).toMatchObject({ code: 'PGRST100' });

    const embed = await alice.from('items').select('id, children(id)');
    expect(embed.status).toBe(400);
    expect(embed.error).toMatchObject({ code: 'PGRST100' });

    const otherSchema = await alice.schema('auth').from('users').select('id');
    expect(otherSchema.status).toBe(406);
    expect(otherSchema.error).toMatchObject({ code: 'PGRST106' });

    const csv = await alice.from('items').select('id').csv();
    expect(csv.status).toBe(406);

    const jsonPath = await alice.from('items').select('meta->level');
    expect(jsonPath.status).toBe(400);
  });
});

describe('mutations', () => {
  it('insert without and with select', async () => {
    const plain = await alice.from('items').insert({ name: 'm-plain', code: 'm1' });
    expect(plain.error).toBeNull();
    expect(plain.status).toBe(201);
    expect(plain.data).toBeNull();

    const selected = await alice.from('items').insert({ name: 'm-selected', code: 'm2', qty: 4 }).select('name, owner, kind').single();
    expect(selected.status).toBe(201);
    expect(selected.data).toEqual({ name: 'm-selected', owner: aliceId, kind: 'A' });

    const bulk = await alice
      .from('items')
      .insert([
        { name: 'm-bulk-1', code: 'm3' },
        { name: 'm-bulk-2', qty: 4 },
      ])
      .select('name, code, qty');
    expect(bulk.data).toEqual([
      { name: 'm-bulk-1', code: 'm3', qty: null },
      { name: 'm-bulk-2', code: null, qty: 4 },
    ]);

    const nullDefault = await alice.from('items').insert([{ name: 'm-nd-1' }, { name: 'm-nd-2', kind: 'C' }]);
    expect(nullDefault.status).toBe(400);
    expect(nullDefault.error).toMatchObject({ code: '23502' });

    const missingDefault = await alice
      .from('items')
      .insert([{ name: 'm-md-1' }, { name: 'm-md-2', kind: 'C' }], { defaultToNull: false })
      .select('name, kind');
    expect(missingDefault.error).toBeNull();
    expect(missingDefault.data).toEqual([
      { name: 'm-md-1', kind: 'A' },
      { name: 'm-md-2', kind: 'C' },
    ]);

    const counted = await alice.from('items').insert({ name: 'm-count' }, { count: 'exact' });
    expect(counted.count).toBe(1);
  });

  it('upsert merge and ignore duplicates', async () => {
    const { data: existing } = await alice.from('items').select('id').eq('code', 'm2').single();
    const merged = await alice
      .from('items')
      .upsert({ id: (existing as { id: string }).id, name: 'm-merged', code: 'm2' })
      .select('name, qty');
    expect(merged.data).toEqual([{ name: 'm-merged', qty: 4 }]);

    const ignored = await alice
      .from('items')
      .upsert({ name: 'ignored', code: 'm2' }, { onConflict: 'code', ignoreDuplicates: true })
      .select('name');
    expect(ignored.error).toBeNull();
    expect(ignored.data).toEqual([]);

    const onConflict = await alice.from('items').upsert({ name: 'm-conflict', code: 'm2' }, { onConflict: 'code' }).select('name');
    expect(onConflict.data).toEqual([{ name: 'm-conflict' }]);
  });

  it('update and delete with and without select', async () => {
    const plain = await alice.from('items').update({ qty: 99 }).eq('code', 'm1');
    expect(plain.status).toBe(204);
    expect(plain.data).toBeNull();
    const selected = await alice.from('items').update({ qty: 100 }).eq('code', 'm1').select('qty');
    expect(selected.status).toBe(200);
    expect(selected.data).toEqual([{ qty: 100 }]);

    const deleted = await alice.from('items').delete().eq('code', 'm1');
    expect(deleted.status).toBe(204);
    const deletedCounted = await alice.from('items').delete({ count: 'exact' }).eq('code', 'm3').select('code');
    expect(deletedCounted.data).toEqual([{ code: 'm3' }]);
    expect(deletedCounted.count).toBe(1);

    const unfiltered = await alice.from('items').update({ qty: 1 });
    expect(unfiltered.status).toBe(400);
    expect(unfiltered.error).toMatchObject({ code: '21000' });
    const unfilteredDelete = await alice.from('items').delete();
    expect(unfilteredDelete.error).toMatchObject({ code: '21000' });

    const unknownColumn = await alice.from('items').update({ nope: 1 }).eq('code', 'm2');
    expect(unknownColumn.error).toMatchObject({ code: 'PGRST204' });
  });
});

describe('row level security and grants', () => {
  it('scopes rows per user, blocks anon, lets service_role bypass', async () => {
    const aliceCodes = await alice.from('items').select('code').like('code', '_%').in('code', ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2']);
    expect((aliceCodes.data as { code: string }[]).map((r) => r.code).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    const bobRows = await bob.from('items').select('code').order('code');
    expect(bobRows.data).toEqual([{ code: 'b1' }, { code: 'b2' }]);
    expect((await alice.from('items').select('id').eq('code', 'b1')).data).toEqual([]);

    const anonRead = await anon.from('items').select('id');
    expect(anonRead.status).toBe(401);
    expect(anonRead.error).toMatchObject({ code: '42501', message: 'permission denied for table items' });

    const serviceRead = await service.from('items').select('code', { count: 'exact', head: true }).in('code', ['a1', 'b1', 'b2']);
    expect(serviceRead.count).toBe(3);
  });

  it('cannot touch other users rows and WITH CHECK violations are 403', async () => {
    const update = await alice.from('items').update({ qty: 0 }).eq('code', 'b1').select('code');
    expect(update.data).toEqual([]);
    const del = await alice.from('items').delete({ count: 'exact' }).eq('code', 'b2');
    expect(del.count).toBe(0);
    const { data: b1 } = await service.from('items').select('qty').eq('code', 'b1').single();
    expect(b1).toEqual({ qty: 2 });

    const foreignInsert = await alice.from('items').insert({ name: 'sneaky', owner: bobId });
    expect(foreignInsert.status).toBe(403);
    expect(foreignInsert.error).toMatchObject({ code: '42501' });

    const handOff = await alice.from('items').update({ owner: bobId }).eq('code', 'a5');
    expect(handOff.status).toBe(403);
    expect(handOff.error).toMatchObject({ code: '42501' });
  });

  it('enforces column grants (select * denied, explicit columns allowed)', async () => {
    const star = await alice.from('notes').select('*');
    expect(star.status).toBe(403);
    expect(star.error).toMatchObject({ code: '42501' });
    expect((await alice.from('notes').select('id, body')).data).toEqual([{ id: 1, body: 'hello' }]);
    expect((await alice.from('notes').select('secret')).status).toBe(403);
    expect((await alice.from('notes').select('id').eq('secret', 'classified')).status).toBe(403);
    const insertReturning = await service.from('notes').select('secret').eq('id', 1).single();
    expect(insertReturning.data).toEqual({ secret: 'classified' });
  });
});

describe('isolation under concurrency', () => {
  it('never interleaves roles or claims between concurrent requests', async () => {
    const aliceCount = (await alice.from('items').select('id', { count: 'exact', head: true })).count;
    const bobCount = (await bob.from('items').select('id', { count: 'exact', head: true })).count;
    const tasks = Array.from({ length: 40 }, (_, i) => {
      if (i % 4 === 0) return alice.from('items').select('id', { count: 'exact', head: true }).then((r) => ['alice-count', r.count]);
      if (i % 4 === 1) return bob.from('items').select('id', { count: 'exact', head: true }).then((r) => ['bob-count', r.count]);
      if (i % 4 === 2) return alice.rpc('fx_whoami').then((r) => ['alice-who', (r.data as { uid: string }).uid]);
      return anon.from('items').select('id').then((r) => ['anon', r.status]);
    });
    const results = await Promise.all(tasks);
    for (const [label, value] of results) {
      if (label === 'alice-count') expect(value).toBe(aliceCount);
      if (label === 'bob-count') expect(value).toBe(bobCount);
      if (label === 'alice-who') expect(value).toBe(aliceId);
      if (label === 'anon') expect(value).toBe(401);
    }
    const session = await lb.db.query<{ current_user: string }>('select current_user::text as current_user');
    expect(session.rows[0].current_user).toBe('postgres');
  });
});
