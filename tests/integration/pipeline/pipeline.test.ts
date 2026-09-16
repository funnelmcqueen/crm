// Pipeline (SPEC 8, SPEC 1 isolation): per-column pages scoped like search_leads, admin filters ignored for
// agents, moves through the server action with updateLeadStatus semantics (not_found, D12 forbidden).
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { pipelineColumnFor, type LeadStatus, type PipelineColumnKey } from '@/lib/domain/statuses';
import type { RequestContext } from '@/server/context';
import { loadPipelineColumnAction, moveLeadToColumnAction } from '@/server/actions/pipeline';
import {
  PIPELINE_COLUMN_KEYS,
  PIPELINE_PAGE_SIZE,
  getPipelineBoard,
  loadPipelineColumn,
  type PipelineBoard,
  type PipelineColumnPage,
} from '@/server/services/pipeline';
import { serviceClient } from '../../helpers/clients';
import { contextFor, contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser, type Lead } from '../../helpers/fixtures';
import { signInSeeded } from '../../helpers/seeded';

// Server actions read the session from next/headers cookies; tests hand them a real RLS context instead.
const session = vi.hoisted(() => ({ current: null as RequestContext | null }));
vi.mock('@/server/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/context')>()),
  getActionContext: async () => session.current,
}));

const TAG = `PL${randomUUID().slice(0, 8)}`;

const A_STATUSES: LeadStatus[] = [
  'NEW',
  'NEW',
  'TO_CALL',
  'NO_ANSWER',
  'VOICEMAIL',
  'CONNECTED',
  'FOLLOW_UP',
  'INTERESTED',
  'APPOINTMENT',
  'PROPOSAL',
  'CLIENT',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
];
const B_STATUSES: LeadStatus[] = ['NEW', 'TO_CALL', 'NO_ANSWER', 'CLIENT', 'DO_NOT_CONTACT'];

let agentA: FixtureUser;
let agentB: FixtureUser;
let ctxA: RequestContext;
let ctxB: RequestContext;
let ctxAdmin: RequestContext;
let leadsA: Lead[];
let leadsB: Lead[];
let unassignedLead: Lead;

function expectedTotals(leads: Lead[]): Record<PipelineColumnKey, number> {
  const totals = Object.fromEntries(PIPELINE_COLUMN_KEYS.map((key) => [key, 0])) as Record<PipelineColumnKey, number>;
  for (const lead of leads) totals[pipelineColumnFor(lead.status).key] += 1;
  return totals;
}

const totalsOf = (board: PipelineBoard) => Object.fromEntries(board.columns.map((c) => [c.key, c.total]));
const cardIds = (board: PipelineBoard) => board.columns.flatMap((c) => c.cards.map((card) => card.id));

async function leadRow(id: string) {
  const { data } = await serviceClient().from('leads').select('id, status, assigned_to, updated_at').eq('id', id).maybeSingle();
  return data;
}

beforeAll(async () => {
  [agentA, agentB] = await Promise.all([
    createUser({ name: `Pipeline Agent A ${TAG}` }),
    createUser({ name: `Pipeline Agent B ${TAG}` }),
  ]);
  [ctxA, ctxB, ctxAdmin] = await Promise.all([contextForUser(agentA), contextForUser(agentB), signInSeeded('admin').then(contextFor)]);
  leadsA = await Promise.all(
    A_STATUSES.map((status, i) => createLead({ business_name: `${TAG} A ${i} ${status}`, status, assigned_to: agentA.id })),
  );
  leadsB = await Promise.all(
    B_STATUSES.map((status, i) => createLead({ business_name: `${TAG} B ${i} ${status}`, status, assigned_to: agentB.id })),
  );
  unassignedLead = await createLead({ business_name: `${TAG} unassigned`, status: 'TO_CALL', assigned_to: null });
});

describe('agent isolation', () => {
  it('an agent board holds exactly their own leads, per column', async () => {
    const board = await getPipelineBoard(ctxA, { closed: true });
    expect(board.columns.map((c) => c.key)).toEqual([...PIPELINE_COLUMN_KEYS]);
    expect(totalsOf(board)).toEqual(expectedTotals(leadsA));
    expect(new Set(cardIds(board))).toEqual(new Set(leadsA.map((l) => l.id)));
    for (const column of board.columns) {
      for (const card of column.cards) {
        expect(pipelineColumnFor(card.status).key).toBe(column.key);
        expect(card.assignedTo).toBeNull();
      }
    }

    const boardB = await getPipelineBoard(ctxB, { closed: true });
    expect(totalsOf(boardB)).toEqual(expectedTotals(leadsB));
    const idsB = new Set(cardIds(boardB));
    for (const lead of [...leadsA, unassignedLead]) expect(idsB.has(lead.id)).toBe(false);
  });

  it('hides the closed columns unless asked', async () => {
    const board = await getPipelineBoard(ctxA);
    expect(board.closed).toBe(false);
    expect(board.columns.map((c) => c.key)).toEqual(['NEW', 'TO_CALL', 'CONNECTED', 'INTERESTED', 'APPOINTMENT', 'PROPOSAL', 'CLIENT']);
    expect(board.columns.find((c) => c.key === 'TO_CALL')?.total).toBe(3);
    expect(board.columns.find((c) => c.key === 'CONNECTED')?.total).toBe(2);
  });

  it('ignores the admin agent and unassigned filters for agents (service and action)', async () => {
    expect(totalsOf(await getPipelineBoard(ctxA, { closed: true, agentId: agentB.id }))).toEqual(expectedTotals(leadsA));
    expect(totalsOf(await getPipelineBoard(ctxA, { closed: true, unassigned: true }))).toEqual(expectedTotals(leadsA));

    session.current = ctxA;
    const result = await loadPipelineColumnAction({ column: 'TO_CALL', offset: 0, agentId: agentB.id, unassigned: false });
    expect(result.ok).toBe(true);
    const page = (result as { ok: true; data: PipelineColumnPage }).data;
    expect(page.total).toBe(3);
    expect(new Set(page.cards.map((c) => c.id))).toEqual(
      new Set(leadsA.filter((l) => pipelineColumnFor(l.status).key === 'TO_CALL').map((l) => l.id)),
    );
    const unassigned = await loadPipelineColumnAction({ column: 'TO_CALL', offset: 0, agentId: null, unassigned: true });
    expect(unassigned.ok && unassigned.data.cards.map((c) => c.id).sort()).toEqual(page.cards.map((c) => c.id).sort());
  });

  it('refuses a signed-out caller', async () => {
    session.current = null;
    expect(await loadPipelineColumnAction({ column: 'NEW', offset: 0, agentId: null, unassigned: false })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await moveLeadToColumnAction(leadsA[0].id, 'CLIENT')).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});

describe('admin filters', () => {
  it('the agent filter shows exactly that agent\'s leads, with the owner on each card', async () => {
    const boardA = await getPipelineBoard(ctxAdmin, { closed: true, agentId: agentA.id });
    expect(totalsOf(boardA)).toEqual(expectedTotals(leadsA));
    expect(boardA.columns.flatMap((c) => c.cards).every((card) => card.assignedTo === agentA.id)).toBe(true);

    const boardB = await getPipelineBoard(ctxAdmin, { closed: true, agentId: agentB.id });
    expect(totalsOf(boardB)).toEqual(expectedTotals(leadsB));
  });

  it('the unassigned filter shows only unassigned leads', async () => {
    let offset = 0;
    let found = false;
    for (let guard = 0; guard < 100 && !found; guard += 1) {
      const page = await loadPipelineColumn(ctxAdmin, { column: 'TO_CALL', offset, unassigned: true });
      expect(page.cards.every((card) => card.assignedTo === null)).toBe(true);
      found = page.cards.some((card) => card.id === unassignedLead.id);
      if (page.cards.length < PIPELINE_PAGE_SIZE) break;
      offset += page.cards.length;
    }
    expect(found).toBe(true);
  });

  it('rejects malformed filters and columns', async () => {
    await expect(loadPipelineColumn(ctxAdmin, { column: 'FOLLOW_UP', offset: 0 })).rejects.toThrow();
    await expect(loadPipelineColumn(ctxAdmin, { column: 'NEW', offset: -1 })).rejects.toThrow();
    session.current = ctxAdmin;
    expect(await loadPipelineColumnAction({ column: 'NEW', offset: 0, agentId: 'not-a-uuid', unassigned: false })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
  });
});

describe('paging', () => {
  it('serves 20 cards per page with a column total and no repeats', async () => {
    const agent = await createUser({ name: `Pipeline Pager ${TAG}` });
    const leads = await Promise.all(
      Array.from({ length: 23 }, (_, i) => createLead({ business_name: `${TAG} page ${i}`, status: 'INTERESTED', assigned_to: agent.id })),
    );
    const ctx = await contextForUser(agent);

    const board = await getPipelineBoard(ctx);
    const first = board.columns.find((c) => c.key === 'INTERESTED')!;
    expect(first.cards).toHaveLength(PIPELINE_PAGE_SIZE);
    expect(first.total).toBe(23);

    session.current = ctx;
    const more = await loadPipelineColumnAction({ column: 'INTERESTED', offset: 20, agentId: null, unassigned: false });
    expect(more.ok).toBe(true);
    const second = (more as { ok: true; data: PipelineColumnPage }).data;
    expect(second).toMatchObject({ key: 'INTERESTED', offset: 20, total: 23 });
    expect(second.cards).toHaveLength(3);
    const all = [...first.cards, ...second.cards].map((c) => c.id);
    expect(new Set(all)).toEqual(new Set(leads.map((l) => l.id)));

    // Past the end: no cards, but the total still comes back.
    expect(await loadPipelineColumn(ctx, { column: 'INTERESTED', offset: 40 })).toMatchObject({ cards: [], total: 23 });

    // Column order: updated_at desc when nobody has a follow-up.
    const updated = [...first.cards, ...second.cards].map((c) => Date.parse(c.updatedAt));
    expect(updated).toEqual([...updated].sort((x, y) => y - x));
  });
});

describe('moving cards', () => {
  let mover: FixtureUser;
  let ctxMover: RequestContext;

  beforeAll(async () => {
    mover = await createUser({ name: `Pipeline Mover ${TAG}` });
    ctxMover = await contextForUser(mover);
  });

  it('moving another agent\'s lead is not_found and changes nothing', async () => {
    const leadB = await createLead({ business_name: `${TAG} B move target`, status: 'NEW', assigned_to: agentB.id });
    const before = await leadRow(leadB.id);
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(leadB.id, 'CLIENT')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // Same answer for a random id and a malformed id.
    expect(await moveLeadToColumnAction(randomUUID(), 'CLIENT')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await moveLeadToColumnAction('nope', 'CLIENT')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await leadRow(leadB.id)).toEqual(before);
  });

  it('an agent cannot move a Do Not Contact lead out (D12); an admin can', async () => {
    const lead = await createLead({ business_name: `${TAG} dnc`, status: 'DO_NOT_CONTACT', assigned_to: mover.id });
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(lead.id, 'CLIENT')).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'Only an admin can reopen a Do Not Contact lead.' },
    });
    expect((await leadRow(lead.id))?.status).toBe('DO_NOT_CONTACT');

    session.current = ctxAdmin;
    expect(await moveLeadToColumnAction(lead.id, 'TO_CALL')).toEqual({
      ok: true,
      data: { id: lead.id, status: 'TO_CALL', changed: true },
    });
    expect((await leadRow(lead.id))?.status).toBe('TO_CALL');
  });

  it('a move to Client persists and shows on the next board load', async () => {
    const lead = await createLead({ business_name: `${TAG} win`, status: 'PROPOSAL', assigned_to: mover.id });
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(lead.id, 'CLIENT')).toEqual({ ok: true, data: { id: lead.id, status: 'CLIENT', changed: true } });
    expect((await leadRow(lead.id))?.status).toBe('CLIENT');
    const board = await getPipelineBoard(ctxMover);
    expect(board.columns.find((c) => c.key === 'CLIENT')?.cards.map((c) => c.id)).toContain(lead.id);
    expect(board.columns.find((c) => c.key === 'PROPOSAL')?.cards.map((c) => c.id)).not.toContain(lead.id);
  });

  it('an agent can move their own lead to Do Not Contact and Not Interested', async () => {
    const lead = await createLead({ business_name: `${TAG} closing`, status: 'CONNECTED', assigned_to: mover.id });
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(lead.id, 'NOT_INTERESTED')).toMatchObject({ ok: true, data: { status: 'NOT_INTERESTED' } });
    expect(await moveLeadToColumnAction(lead.id, 'DO_NOT_CONTACT')).toMatchObject({ ok: true, data: { status: 'DO_NOT_CONTACT' } });
    expect((await leadRow(lead.id))?.status).toBe('DO_NOT_CONTACT');
  });

  it('dropping on the card\'s own column is a no-op: No Answer stays No Answer in To Call', async () => {
    const lead = await createLead({ business_name: `${TAG} no answer`, status: 'NO_ANSWER', assigned_to: mover.id });
    const before = await leadRow(lead.id);
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(lead.id, 'TO_CALL')).toEqual({
      ok: true,
      data: { id: lead.id, status: 'NO_ANSWER', changed: false },
    });
    expect(await leadRow(lead.id)).toEqual(before);
  });

  it('rejects an unknown column without touching the lead', async () => {
    const lead = await createLead({ business_name: `${TAG} bad column`, status: 'NEW', assigned_to: mover.id });
    session.current = ctxMover;
    expect(await moveLeadToColumnAction(lead.id, 'FOLLOW_UP')).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect((await leadRow(lead.id))?.status).toBe('NEW');
  });
});
