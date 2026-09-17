// CSV import services (SPEC section 9) with real sessions: admin inserts under RLS with the
// normalized values and the chosen assignment; agents and bad assignments are refused.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildImportBatches,
  buildImportPlan,
  buildImportPreview,
  checkImportRows,
  chunkDuplicateKeys,
  duplicateKeysFor,
  parseImportCsv,
  summarizeImport,
  toBatchAssignment,
  type BatchRowResult,
  type ExistingDuplicateLead,
  type ImportBatchRow,
} from '@/components/import/import-model';
import type { Database } from '@/lib/database.types';
import { splitCounts } from '@/lib/domain/split';
import { guessMapping, type ImportMapping } from '@/lib/domain/import-mapping';
import { PROFILE_COLUMNS, type RequestContext } from '@/server/context';
import { checkImportDuplicates, importLeadsBatch, listImportAgents } from '@/server/services/import';
import { startLocalbase, type Localbase } from '../../../localbase/server';
import { EXPECTED_IMPORT_PREVIEW, SAMPLE_ROW_COUNT } from '../../../scripts/gen-sample-csv';
import { SEED_ADMIN_EMAIL, SEED_PASSWORD } from '../../../scripts/lib/seed-data';
import { seed } from '../../../scripts/seed';
import { serviceClient, signInAs } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import { isLocalbaseStack } from '../../helpers/env';
import { createLead, createUser, fictionalPhone, type FixtureUser } from '../../helpers/fixtures';
import { seededUserId, signInSeeded } from '../../helpers/seeded';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAMPLE_PATH = path.join(REPO_ROOT, 'samples', 'leads.csv');

const MAPPING: ImportMapping = { Company: 'business_name', Phone: 'phone', Site: 'website', Town: 'city', Industry: null };

let admin: RequestContext;
let agentOne: FixtureUser;
let agentTwo: FixtureUser;

/** `+17375550123` -> `(737) 555-0123`, the way a spreadsheet usually holds it. */
function national(e164: string): string {
  const digits = e164.slice(2);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function batchRows(count: number, tag: string): { rows: ImportBatchRow[]; phones: string[] } {
  const phones = Array.from({ length: count }, () => fictionalPhone());
  const rows = phones.map((phone, i) => ({
    rowIndex: i + 10,
    position: i,
    cells: { Company: `  Import ${tag} ${i}  `, Phone: national(phone), Site: `https://WWW.import-${tag}-${i}.test/about`, Town: 'Austin', Industry: 'HVAC' },
  }));
  return { rows, phones };
}

async function leadsByPhone(phones: string[]) {
  const { data, error } = await serviceClient()
    .from('leads')
    .select('id, business_name, phone, phone_raw, website, website_domain, city, notes, assigned_to, status, dedupe_name_key')
    .in('phone', phones);
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  admin = await contextFor(await signInSeeded('admin'));
  [agentOne, agentTwo] = await Promise.all([createUser({ name: 'Import Agent One' }), createUser({ name: 'Import Agent Two' })]);
});

describe('importLeadsBatch as admin', () => {
  it('inserts re-normalized rows with an even split, returning one lead id per row', async () => {
    const tag = randomUUID().slice(0, 8);
    const { rows, phones } = batchRows(3, tag);
    const { results } = await importLeadsBatch(admin, { mapping: MAPPING, appendUnmappedToNotes: true, rows }, { mode: 'split', agentIds: [agentOne.id, agentTwo.id], total: 3 });
    expect(results.map((result) => [result.rowIndex, result.ok])).toEqual([
      [10, true],
      [11, true],
      [12, true],
    ]);

    const stored = await leadsByPhone(phones);
    expect(stored).toHaveLength(3);
    for (const [i, phone] of phones.entries()) {
      const lead = stored.find((row) => row.phone === phone);
      const result = results[i];
      expect(result.ok && result.leadId).toBe(lead?.id);
      expect(lead).toMatchObject({
        business_name: `Import ${tag} ${i}`,
        phone,
        phone_raw: national(phone),
        website: `https://WWW.import-${tag}-${i}.test/about`,
        website_domain: `import-${tag}-${i}.test`,
        city: 'Austin',
        notes: 'Industry: HVAC',
        status: 'NEW',
        dedupe_name_key: `import${tag}${i}|austin`,
        assigned_to: i < 2 ? agentOne.id : agentTwo.id,
      });
    }
  });

  it('assigns everything to one agent, or leaves the leads unassigned', async () => {
    const one = batchRows(2, randomUUID().slice(0, 8));
    await importLeadsBatch(admin, { mapping: MAPPING, appendUnmappedToNotes: false, rows: one.rows }, { mode: 'agent', agentId: agentTwo.id });
    expect((await leadsByPhone(one.phones)).map((lead) => [lead.assigned_to, lead.notes])).toEqual([
      [agentTwo.id, null],
      [agentTwo.id, null],
    ]);

    const none = batchRows(1, randomUUID().slice(0, 8));
    await importLeadsBatch(admin, { mapping: MAPPING, appendUnmappedToNotes: true, rows: none.rows }, { mode: 'unassigned' });
    expect((await leadsByPhone(none.phones)).map((lead) => lead.assigned_to)).toEqual([null]);
  });

  it('re-validates every row server-side: a row the client should not have sent fails alone', async () => {
    const tag = randomUUID().slice(0, 8);
    const { rows, phones } = batchRows(2, tag);
    rows[0].cells.Phone = 'N/A';
    rows[1].cells.Company = 'x'.repeat(201);
    const good = batchRows(1, tag);
    good.rows[0].rowIndex = 99;
    good.rows[0].position = 2;
    const { results } = await importLeadsBatch(admin, { mapping: MAPPING, appendUnmappedToNotes: true, rows: [...rows, ...good.rows] }, { mode: 'unassigned' });
    expect(results).toEqual([
      { rowIndex: 10, ok: false, reason: 'Unusable phone' },
      { rowIndex: 11, ok: false, reason: 'Business name is too long (max 200 characters)' },
      { rowIndex: 99, ok: true, leadId: expect.any(String) },
    ]);
    expect(await leadsByPhone(phones)).toEqual([]);
    expect(await leadsByPhone(good.phones)).toHaveLength(1);
  });

  it('rejects malformed batches with a validation error and inserts nothing', async () => {
    const { rows, phones } = batchRows(1, randomUUID().slice(0, 8));
    const cases: Array<[unknown, unknown]> = [
      [{ mapping: { ...MAPPING, Company: 'assigned_to' }, appendUnmappedToNotes: true, rows }, { mode: 'unassigned' }],
      [{ mapping: { Phone: 'phone' }, appendUnmappedToNotes: true, rows }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows: [] }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows, assigned_to: agentOne.id }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows: [...rows, rows[0]] }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows: [{ ...rows[0], lead: { phone: '+15555550100' } }] }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows: Array.from({ length: 501 }, (_, i) => ({ ...rows[0], rowIndex: i, position: i })) }, { mode: 'unassigned' }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows }, { mode: 'split', agentIds: [agentOne.id], total: 0 }],
      [{ mapping: MAPPING, appendUnmappedToNotes: true, rows: [{ ...rows[0], position: 5 }] }, { mode: 'split', agentIds: [agentOne.id], total: 3 }],
    ];
    for (const [batch, assignment] of cases) {
      await expect(importLeadsBatch(admin, batch, assignment)).rejects.toMatchObject({ code: 'validation' });
    }
    expect(await leadsByPhone(phones)).toEqual([]);
  });

  it('refuses assigned agent ids that are not active agents (inactive, nonexistent, an admin) and inserts nothing', async () => {
    const inactive = await createUser({ active: false });
    const adminId = await seededUserId('admin');
    const { rows, phones } = batchRows(2, randomUUID().slice(0, 8));
    const batch = { mapping: MAPPING, appendUnmappedToNotes: true, rows };
    for (const assignment of [
      { mode: 'agent', agentId: inactive.id },
      { mode: 'agent', agentId: randomUUID() },
      { mode: 'agent', agentId: adminId },
      { mode: 'agent', agentId: await seededUserId('dana') },
      { mode: 'split', agentIds: [agentOne.id, inactive.id], total: 2 },
      { mode: 'split', agentIds: [agentOne.id, randomUUID()], total: 2 },
      { mode: 'split', agentIds: [agentOne.id, agentOne.id], total: 2 },
    ]) {
      await expect(importLeadsBatch(admin, batch, assignment)).rejects.toMatchObject({ code: 'validation' });
    }
    expect(await leadsByPhone(phones)).toEqual([]);
  });

  it('lists only active agents for assignment', async () => {
    const inactive = await createUser({ active: false });
    const ids = (await listImportAgents(admin)).map((agent) => agent.id);
    expect(ids).toEqual(expect.arrayContaining([agentOne.id, agentTwo.id, await seededUserId('alex')]));
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(await seededUserId('dana'));
    expect(ids).not.toContain(await seededUserId('admin'));
  });

  it('finds existing duplicates by phone, website domain and name + city through the admin session', async () => {
    const tag = randomUUID().slice(0, 8);
    const lead = await createLead({ business_name: `Dup Check ${tag}`, city: 'El Paso', website: `https://dup-${tag}.test`, website_domain: `dup-${tag}.test`, assigned_to: agentOne.id });
    const byPhone = await checkImportDuplicates(admin, { phones: [lead.phone], domains: [], nameKeys: [] });
    const byDomain = await checkImportDuplicates(admin, { phones: [], domains: [`dup-${tag}.test`], nameKeys: [] });
    const byName = await checkImportDuplicates(admin, { phones: [], domains: [], nameKeys: [`dupcheck${tag}|elpaso`] });
    for (const found of [byPhone, byDomain, byName]) {
      expect(found).toEqual([
        { leadId: lead.id, businessName: lead.business_name, city: 'El Paso', phone: lead.phone, websiteDomain: `dup-${tag}.test`, nameCityKey: `dupcheck${tag}|elpaso` },
      ]);
    }
    await expect(checkImportDuplicates(admin, { phones: Array.from({ length: 1001 }, () => '+1'), domains: [], nameKeys: [] })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('import as an agent', () => {
  it('every import service and the duplicate RPC are forbidden, and nothing is inserted', async () => {
    const agent = await contextForUser(agentOne);
    const { rows, phones } = batchRows(2, randomUUID().slice(0, 8));
    await expect(listImportAgents(agent)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(checkImportDuplicates(agent, { phones, domains: [], nameKeys: [] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(importLeadsBatch(agent, { mapping: MAPPING, appendUnmappedToNotes: true, rows }, { mode: 'agent', agentId: agentOne.id })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(importLeadsBatch(agent, { mapping: MAPPING, appendUnmappedToNotes: true, rows }, { mode: 'unassigned' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(importLeadsBatch(null, { mapping: MAPPING, appendUnmappedToNotes: true, rows }, { mode: 'unassigned' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await leadsByPhone(phones)).toEqual([]);

    const session = await signInAs(agentOne.email, agentOne.password);
    const rpc = await session.client.rpc('find_duplicate_leads', { p_phones: phones, p_domains: [], p_name_keys: [] });
    expect(rpc.error?.code).toBe('42501');
    const direct = await session.client.from('leads').insert({ business_name: 'Agent insert', phone: phones[0] }).select('id');
    expect(direct.data ?? []).toEqual([]);
    expect(await leadsByPhone(phones)).toEqual([]);
  });
});

// samples/leads.csv holds fictional phones that fixtures may also draw, so the end-to-end import runs
// in its own freshly seeded in-memory localbase: its 92 inserted rows never touch the shared stack.
describe.runIf(isLocalbaseStack())('samples/leads.csv end to end (private seeded localbase)', () => {
  let stack: Localbase;
  let ctx: RequestContext;

  beforeAll(async () => {
    stack = await startLocalbase({ port: 0, silent: true, migrationsDir: path.join(REPO_ROOT, 'supabase', 'migrations') });
    await seed({ url: stack.url, serviceRoleKey: stack.serviceRoleKey });
    const client = createClient<Database>(stack.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: SEED_ADMIN_EMAIL, password: SEED_PASSWORD });
    if (error || !data.user) throw new Error(`private stack sign-in failed: ${error?.message}`);
    const profile = await client.from('profiles').select(PROFILE_COLUMNS).eq('id', data.user.id).single();
    if (profile.error || !profile.data) throw new Error('private stack profile missing');
    ctx = { supabase: client, userId: data.user.id, profile: profile.data };
  }, 240_000);

  afterAll(async () => {
    await stack?.stop();
  });

  async function previewSample() {
    const parsed = parseImportCsv(readFileSync(SAMPLE_PATH, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.error);
    const mapping = guessMapping(parsed.file.headers);
    const checks = checkImportRows(parsed.file, mapping, true);
    const existing: ExistingDuplicateLead[] = [];
    for (const chunk of chunkDuplicateKeys(duplicateKeysFor(checks))) existing.push(...(await checkImportDuplicates(ctx, chunk)));
    return { file: parsed.file, mapping, preview: buildImportPreview(checks, existing) };
  }

  it('reports the documented preview counts, imports the ready rows split across the agents, and every row is accounted for', async () => {
    const { file, mapping, preview } = await previewSample();
    expect(preview.counts).toEqual({
      total: SAMPLE_ROW_COUNT,
      ready: EXPECTED_IMPORT_PREVIEW.ready,
      duplicates: EXPECTED_IMPORT_PREVIEW.possibleDuplicates,
      invalid: EXPECTED_IMPORT_PREVIEW.invalid,
    });

    const plan = buildImportPlan(preview, {});
    const agents = await listImportAgents(ctx);
    expect(agents.map((agent) => agent.email).sort()).toEqual(['alex@funnelmcqueen.test', 'blair@funnelmcqueen.test', 'casey@funnelmcqueen.test']);
    const assignment = toBatchAssignment({ mode: 'split', agentIds: agents.map((agent) => agent.id) }, plan.insert.length);

    const results: BatchRowResult[] = [];
    const batches = buildImportBatches(file, plan, 40);
    expect(batches.map((batch) => batch.length)).toEqual([40, 40, 12]);
    for (const batch of batches) {
      results.push(...(await importLeadsBatch(ctx, { mapping, appendUnmappedToNotes: true, rows: batch }, assignment)).results);
    }

    const summary = summarizeImport(preview, plan, results);
    expect(summary.counts).toEqual({ total: 100, inserted: 92, skipped: 5, invalid: 3, failed: 0 });
    expect(summary.counts.inserted + summary.counts.skipped + summary.counts.invalid + summary.counts.failed).toBe(SAMPLE_ROW_COUNT);

    const ids = results.flatMap((result) => (result.ok ? [result.leadId] : []));
    const stored = await ctx.supabase.from('leads').select('id, assigned_to, phone, notes').in('id', ids);
    expect(stored.error).toBeNull();
    expect(stored.data).toHaveLength(92);
    const perAgent = agents.map((agent) => (stored.data ?? []).filter((lead) => lead.assigned_to === agent.id).length);
    expect(perAgent).toEqual(splitCounts(92, 3));
    expect((stored.data ?? []).every((lead) => /^\+1\d{10}$/.test(lead.phone))).toBe(true);
    // "Industry" is now a recognized business type column (Task 11); "Employees" stays unmapped and still lands in notes.
    expect((stored.data ?? []).some((lead) => lead.notes?.includes('Employees: '))).toBe(true);

    // Importing the same file again finds every valid row as a duplicate; nothing is ready.
    const again = await previewSample();
    expect(again.preview.counts).toEqual({ total: 100, ready: 0, duplicates: 97, invalid: 3 });
  }, 240_000);
});
