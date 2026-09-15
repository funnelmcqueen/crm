// Leads list service (SPEC 8 "Leads list", SPEC 1 isolation): server-side pagination, search, filters and
// sort through search_leads with the caller's own session.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '@/server/context';
import { listAgentsForFilter, listLeadSources, listLeads, LEADS_PAGE_SIZE } from '@/server/services/leads';
import { SEED_LEADS } from '../../../scripts/lib/seed-data';
import { serviceClient } from '../../helpers/clients';
import { createLead, createUser, fictionalPhone, type FixtureUser } from '../../helpers/fixtures';
import { seededLeadId, seededUserId, signInSeeded } from '../../helpers/seeded';
import { contextFor, contextForUser } from '../../helpers/context';

const TAG = `LL${randomUUID().slice(0, 8)}`;
const STATUS_CYCLE = ['NEW', 'TO_CALL', 'INTERESTED'] as const;

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxAdmin: RequestContext;
let phonesA: string[] = [];

beforeAll(async () => {
  [agentA, agentB] = await Promise.all([
    createUser({ name: `List Agent A ${TAG}` }),
    createUser({ name: `List Agent B ${TAG}` }),
  ]);
  phonesA = Array.from({ length: 30 }, () => fictionalPhone());
  const rows = phonesA.map((phone, i) => ({
    business_name: `${TAG} Alpha ${String(i).padStart(2, '0')}`,
    phone,
    city: 'Testville',
    state: 'TX',
    status: STATUS_CYCLE[i % 3],
    source: `ListSrc-${TAG}`,
    call_count: i,
    assigned_to: agentA.id,
  }));
  const inserted = await serviceClient().from('leads').insert(rows).select('id');
  if (inserted.error || inserted.data.length !== 30) throw new Error(`bulk insert failed: ${inserted.error?.message}`);

  await Promise.all([
    createLead({ business_name: `${TAG} Bravo secret`, source: `OtherSrc-${TAG}`, assigned_to: agentB.id }),
    createLead({ business_name: `${TAG} Pool one`, assigned_to: null }),
    createLead({ business_name: `${TAG} Pool two`, assigned_to: null }),
  ]);

  [ctxA, ctxAdmin] = await Promise.all([contextForUser(agentA), signInSeeded('admin').then(contextFor)]);
});

describe('listLeads for an agent', () => {
  it('returns only the seeded agent\'s own leads', async () => {
    const alex = await contextFor(await signInSeeded('alex'));
    const alexId = await seededUserId('alex');
    const result = await listLeads(alex, {});
    const ids = result.rows.map((r) => r.id);

    const alexSeeded = await Promise.all(SEED_LEADS.filter((l) => l.owner === 'alex').map((l) => seededLeadId(l.ref)));
    const blairSeeded = await Promise.all(SEED_LEADS.filter((l) => l.owner === 'blair').map((l) => seededLeadId(l.ref)));
    expect(alexSeeded).toHaveLength(12);
    expect(ids).toEqual(expect.arrayContaining(alexSeeded));
    for (const id of blairSeeded) expect(ids).not.toContain(id);

    const owners = await serviceClient().from('leads').select('id, assigned_to').in('id', ids);
    expect(owners.data?.every((l) => l.assigned_to === alexId)).toBe(true);
    // Agents never receive assigned_to.
    expect(result.rows.every((r) => r.assignedTo === null)).toBe(true);

    const blairName = SEED_LEADS.find((l) => l.ref === 'blair-01')?.businessName ?? '';
    const search = await listLeads(alex, { query: blairName });
    for (const id of blairSeeded) expect(search.rows.map((r) => r.id)).not.toContain(id);
  });

  it('paginates 25 per page with page info', async () => {
    const page1 = await listLeads(ctxA, { sort: 'business_name', dir: 'asc' });
    expect(LEADS_PAGE_SIZE).toBe(25);
    expect(page1.rows).toHaveLength(25);
    expect(page1).toMatchObject({ page: 1, pageSize: 25, total: 30, pageCount: 2, from: 1, to: 25 });
    expect(page1.rows[0].businessName).toBe(`${TAG} Alpha 00`);

    const page2 = await listLeads(ctxA, { sort: 'business_name', dir: 'asc', page: 2 });
    expect(page2.rows).toHaveLength(5);
    expect(page2).toMatchObject({ page: 2, total: 30, from: 26, to: 30 });
    expect(page2.rows.map((r) => r.businessName)).toEqual([25, 26, 27, 28, 29].map((i) => `${TAG} Alpha ${i}`));

    const beyond = await listLeads(ctxA, { page: 3 });
    expect(beyond.rows).toEqual([]);
    expect(beyond).toMatchObject({ total: 30, from: 0, to: 0, pageCount: 2 });
  });

  it('searches by business name and by phone digits', async () => {
    const byName = await listLeads(ctxA, { query: `${TAG} Alpha 07` });
    expect(byName.rows.map((r) => r.businessName)).toEqual([`${TAG} Alpha 07`]);

    const phone = phonesA[12];
    const formatted = `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
    const byPhone = await listLeads(ctxA, { query: formatted });
    expect(byPhone.rows.map((r) => r.phone)).toEqual([phone]);

    const otherAgents = await listLeads(ctxA, { query: `${TAG} Bravo` });
    expect(otherAgents.total).toBe(0);
    expect(otherAgents.rows).toEqual([]);
  });

  it('filters by status and source', async () => {
    const interested = await listLeads(ctxA, { statuses: ['INTERESTED'] });
    expect(interested.total).toBe(10);
    expect(interested.rows.every((r) => r.status === 'INTERESTED')).toBe(true);

    const two = await listLeads(ctxA, { statuses: ['NEW', 'TO_CALL'] });
    expect(two.total).toBe(20);

    const source = await listLeads(ctxA, { source: `ListSrc-${TAG}` });
    expect(source.total).toBe(30);
    const otherSource = await listLeads(ctxA, { source: `OtherSrc-${TAG}` });
    expect(otherSource.total).toBe(0);
  });

  it('sorts by call count in both directions', async () => {
    const desc = await listLeads(ctxA, { sort: 'call_count', dir: 'desc' });
    expect(desc.rows.slice(0, 3).map((r) => r.callCount)).toEqual([29, 28, 27]);
    const asc = await listLeads(ctxA, { sort: 'call_count', dir: 'asc' });
    expect(asc.rows.slice(0, 3).map((r) => r.callCount)).toEqual([0, 1, 2]);
  });

  it('ignores the admin-only agent and unassigned filters', async () => {
    const byOtherAgent = await listLeads(ctxA, { agentId: agentB.id });
    expect(byOtherAgent.total).toBe(30);
    expect(byOtherAgent.rows.every((r) => r.businessName.startsWith(`${TAG} Alpha`))).toBe(true);

    const unassigned = await listLeads(ctxA, { unassigned: true, query: TAG });
    expect(unassigned.total).toBe(30);
    expect(unassigned.rows.map((r) => r.businessName)).not.toContain(`${TAG} Pool one`);
  });

  it('rejects invalid service input', async () => {
    await expect(listLeads(ctxA, { sort: 'phone' as never })).rejects.toThrow();
    await expect(listLeads(ctxA, { page: 0 })).rejects.toThrow();
  });

  it('lists only its own sources and cannot list agents', async () => {
    const sources = await listLeadSources(ctxA);
    expect(sources).toContain(`ListSrc-${TAG}`);
    expect(sources).not.toContain(`OtherSrc-${TAG}`);
    await expect(listAgentsForFilter(ctxA)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('listLeads for an admin', () => {
  it('filters by agent', async () => {
    const result = await listLeads(ctxAdmin, { agentId: agentA.id });
    expect(result.total).toBe(30);
    expect(result.rows.every((r) => r.assignedTo === agentA.id)).toBe(true);

    const other = await listLeads(ctxAdmin, { agentId: agentB.id, query: TAG });
    expect(other.rows.map((r) => r.businessName)).toEqual([`${TAG} Bravo secret`]);
  });

  it('filters unassigned leads', async () => {
    const result = await listLeads(ctxAdmin, { unassigned: true, query: TAG, sort: 'business_name', dir: 'asc' });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.businessName)).toEqual([`${TAG} Pool one`, `${TAG} Pool two`]);
    expect(result.rows.every((r) => r.assignedTo === null)).toBe(true);
  });

  it('sees every source and every agent', async () => {
    const sources = await listLeadSources(ctxAdmin);
    expect(sources).toEqual(expect.arrayContaining([`ListSrc-${TAG}`, `OtherSrc-${TAG}`]));
    const agents = await listAgentsForFilter(ctxAdmin);
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: agentA.id, name: `List Agent A ${TAG}`, active: true, role: 'AGENT' }),
      ]),
    );
  });
});
