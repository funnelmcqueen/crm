import { describe, expect, it } from 'vitest';
import {
  ALL_PIPELINE_COLUMNS,
  boardReducer,
  compareCards,
  decideMove,
  findCard,
  hasMoreCards,
  initBoardState,
  moveTargets,
  nextOffset,
  resolveDrop,
  visiblePipelineColumns,
  type BoardState,
} from '@/components/pipeline/board-state';
import type { LeadStatus, PipelineColumnKey } from '@/lib/domain/statuses';
import type { PipelineCard, PipelineColumnPage } from '@/server/services/pipeline';

let seq = 0;
function card(status: LeadStatus, overrides: Partial<PipelineCard> = {}): PipelineCard {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    businessName: `Biz ${seq}`,
    contactName: null,
    status,
    assignedTo: null,
    nextFollowUpAt: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    callCount: 0,
    ...overrides,
  };
}

function page(key: PipelineColumnKey, cards: PipelineCard[], total = cards.length, offset = 0): PipelineColumnPage {
  return { key, cards, total, offset };
}

function board(closed = false): { state: BoardState; cards: Record<string, PipelineCard> } {
  const cards = {
    newA: card('NEW', { updatedAt: '2026-09-02T00:00:00.000Z' }),
    newB: card('NEW'),
    noAnswer: card('NO_ANSWER'),
    followUp: card('FOLLOW_UP', { nextFollowUpAt: '2026-09-20T15:00:00.000Z' }),
    dnc: card('DO_NOT_CONTACT'),
  };
  const pages = visiblePipelineColumns(closed).map((column) => {
    const inColumn = Object.values(cards).filter((c) => column.statuses.includes(c.status));
    return page(column.key, inColumn, column.key === 'NEW' ? 25 : inColumn.length);
  });
  return { state: initBoardState(pages), cards };
}

const ids = (state: BoardState, key: PipelineColumnKey) => state.columns[key]?.cards.map((c) => c.id) ?? [];
const NOW = '2026-09-15T12:00:00.000Z';

describe('initBoardState', () => {
  it('keeps column order, cards and totals', () => {
    const { state, cards } = board();
    expect(state.order).toEqual(['NEW', 'TO_CALL', 'CONNECTED', 'INTERESTED', 'APPOINTMENT', 'PROPOSAL', 'CLIENT']);
    expect(ids(state, 'NEW')).toEqual([cards.newA.id, cards.newB.id]);
    expect(state.columns.NEW?.total).toBe(25);
    expect(state.columns.DO_NOT_CONTACT).toBeUndefined();
    expect(board(true).state.order).toHaveLength(9);
  });

  it('never reports a total below the cards shown', () => {
    const state = initBoardState([page('NEW', [card('NEW'), card('NEW')], 1)]);
    expect(state.columns.NEW?.total).toBe(2);
  });

  it('pages: hasMoreCards and nextOffset follow the cards shown', () => {
    const { state } = board();
    expect(hasMoreCards(state.columns.NEW!)).toBe(true);
    expect(nextOffset(state.columns.NEW!)).toBe(2);
    expect(hasMoreCards(state.columns.TO_CALL!)).toBe(false);
  });
});

describe('compareCards', () => {
  it('orders by next follow-up asc with nulls last, then updated desc, then id', () => {
    const soon = card('NEW', { nextFollowUpAt: '2026-09-16T00:00:00.000Z' });
    const later = card('NEW', { nextFollowUpAt: '2026-09-17T00:00:00.000Z' });
    const recent = card('NEW', { updatedAt: '2026-09-10T00:00:00.000Z' });
    const tieA = card('NEW', { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' });
    const tieB = card('NEW', { id: 'b', updatedAt: '2026-01-01T00:00:00.000Z' });
    const oldest = card('NEW', { updatedAt: '2025-01-01T00:00:00.000Z' });
    const sorted = [oldest, tieB, later, recent, tieA, soon].sort(compareCards);
    expect(sorted).toEqual([soon, later, recent, tieA, tieB, oldest]);
  });
});

describe('boardReducer: optimistic move', () => {
  it('moves a card, adjusts both totals, sets the drop status and records the rollback', () => {
    const { state, cards } = board();
    const next = boardReducer(state, { type: 'move', leadId: cards.newB.id, to: 'CLIENT', now: NOW });
    expect(ids(next, 'NEW')).toEqual([cards.newA.id]);
    expect(next.columns.NEW?.total).toBe(24);
    expect(ids(next, 'CLIENT')).toEqual([cards.newB.id]);
    expect(next.columns.CLIENT?.total).toBe(1);
    expect(findCard(next, cards.newB.id)?.card).toMatchObject({ status: 'CLIENT', updatedAt: NOW });
    expect(next.pending[cards.newB.id]).toMatchObject({ from: 'NEW', fromIndex: 1, to: 'CLIENT', previous: cards.newB });
    // The previous state is untouched.
    expect(ids(state, 'NEW')).toEqual([cards.newA.id, cards.newB.id]);
  });

  it('inserts at the sorted position of the target column', () => {
    const { state, cards } = board();
    // CONNECTED holds a FOLLOW_UP card with a follow-up date; the moved card has none, so it goes after it.
    const next = boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'CONNECTED', now: NOW });
    expect(ids(next, 'CONNECTED')).toEqual([cards.followUp.id, cards.newA.id]);
    const withDate = card('NEW', { nextFollowUpAt: '2026-09-16T00:00:00.000Z' });
    const s2 = initBoardState([page('NEW', [withDate]), page('CONNECTED', [cards.followUp])]);
    expect(ids(boardReducer(s2, { type: 'move', leadId: withDate.id, to: 'CONNECTED', now: NOW }), 'CONNECTED')).toEqual([
      withDate.id,
      cards.followUp.id,
    ]);
  });

  it('is a no-op for the card\'s own column (No Answer stays No Answer inside To Call)', () => {
    const { state, cards } = board();
    expect(boardReducer(state, { type: 'move', leadId: cards.noAnswer.id, to: 'TO_CALL', now: NOW })).toBe(state);
    expect(boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'NEW', now: NOW })).toBe(state);
  });

  it('ignores unknown cards, unknown columns and a second move while one is pending', () => {
    const { state, cards } = board();
    expect(boardReducer(state, { type: 'move', leadId: 'missing', to: 'CLIENT', now: NOW })).toBe(state);
    expect(boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'NOPE' as PipelineColumnKey, now: NOW })).toBe(state);
    const moved = boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'CLIENT', now: NOW });
    expect(boardReducer(moved, { type: 'move', leadId: cards.newA.id, to: 'PROPOSAL', now: NOW })).toBe(moved);
  });

  it('takes the card off the board when the target column is hidden, and rollback brings it back', () => {
    const { state, cards } = board(false);
    const moved = boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'NOT_INTERESTED', now: NOW });
    expect(findCard(moved, cards.newA.id)).toBeNull();
    expect(moved.columns.NEW?.total).toBe(24);
    const rolledBack = boardReducer(moved, { type: 'moveFailed', leadId: cards.newA.id });
    expect(ids(rolledBack, 'NEW')).toEqual([cards.newA.id, cards.newB.id]);
    expect(rolledBack.columns.NEW?.total).toBe(25);
    expect(rolledBack.pending).toEqual({});
  });
});

describe('boardReducer: server answer', () => {
  it('moveFailed snaps the card back to its original index and status', () => {
    const { state, cards } = board(true);
    const moved = boardReducer(state, { type: 'move', leadId: cards.dnc.id, to: 'CLIENT', now: NOW });
    const back = boardReducer(moved, { type: 'moveFailed', leadId: cards.dnc.id });
    expect(ids(back, 'DO_NOT_CONTACT')).toEqual([cards.dnc.id]);
    expect(ids(back, 'CLIENT')).toEqual([]);
    expect(back.columns.CLIENT?.total).toBe(0);
    expect(back.columns.DO_NOT_CONTACT?.total).toBe(1);
    expect(findCard(back, cards.dnc.id)?.card).toEqual(cards.dnc);
    expect(back.pending).toEqual({});
  });

  it('moveFailed restores the first card of a column at index 0', () => {
    const { state, cards } = board();
    const moved = boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'PROPOSAL', now: NOW });
    expect(ids(boardReducer(moved, { type: 'moveFailed', leadId: cards.newA.id }), 'NEW')).toEqual([cards.newA.id, cards.newB.id]);
  });

  it('moveSucceeded clears the pending move and applies the server status', () => {
    const { state, cards } = board();
    const moved = boardReducer(state, { type: 'move', leadId: cards.newA.id, to: 'CLIENT', now: NOW });
    const done = boardReducer(moved, { type: 'moveSucceeded', leadId: cards.newA.id, status: 'CLIENT' });
    expect(done.pending).toEqual({});
    expect(findCard(done, cards.newA.id)).toMatchObject({ column: 'CLIENT', card: { status: 'CLIENT' } });
    // A late failure for a settled move changes nothing.
    expect(boardReducer(done, { type: 'moveFailed', leadId: cards.newA.id })).toBe(done);
    expect(boardReducer(done, { type: 'moveSucceeded', leadId: cards.newA.id, status: 'CLIENT' })).toBe(done);
  });
});

describe('boardReducer: pageLoaded', () => {
  it('appends new cards, skips cards already on the board and takes the server total', () => {
    const { state, cards } = board();
    const extra = card('NEW');
    const next = boardReducer(state, { type: 'pageLoaded', page: page('NEW', [cards.newB, cards.noAnswer, extra], 26, 2) });
    expect(ids(next, 'NEW')).toEqual([cards.newA.id, cards.newB.id, extra.id]);
    expect(next.columns.NEW?.total).toBe(26);
  });

  it('does not re-add a card that is being moved elsewhere', () => {
    const { state, cards } = board();
    const moved = boardReducer(state, { type: 'move', leadId: cards.newB.id, to: 'NOT_INTERESTED', now: NOW });
    const next = boardReducer(moved, { type: 'pageLoaded', page: page('NEW', [cards.newB], 25, 1) });
    expect(ids(next, 'NEW')).toEqual([cards.newA.id]);
  });

  it('ignores pages for hidden columns', () => {
    const { state } = board(false);
    expect(boardReducer(state, { type: 'pageLoaded', page: page('DO_NOT_CONTACT', [card('DO_NOT_CONTACT')]) })).toBe(state);
  });
});

describe('decideMove / resolveDrop', () => {
  const agent = { isAdmin: false };
  const admin = { isAdmin: true };

  it('moves to another column with that column\'s drop status', () => {
    expect(decideMove('NEW', 'CONNECTED', agent)).toMatchObject({ kind: 'move', to: { dropStatus: 'CONNECTED' } });
    expect(decideMove('VOICEMAIL', 'NEW', agent)).toMatchObject({ kind: 'move', to: { dropStatus: 'NEW' } });
    expect(decideMove('FOLLOW_UP', 'TO_CALL', agent)).toMatchObject({ kind: 'move', to: { dropStatus: 'TO_CALL' } });
  });

  it('is a no-op inside the same column and for unknown targets', () => {
    for (const status of ['TO_CALL', 'NO_ANSWER', 'VOICEMAIL'] as const) expect(decideMove(status, 'TO_CALL', agent)).toEqual({ kind: 'noop' });
    expect(decideMove('FOLLOW_UP', 'CONNECTED', admin)).toEqual({ kind: 'noop' });
    expect(decideMove('NEW', 'FOLLOW_UP', admin)).toEqual({ kind: 'noop' });
    expect(decideMove('NEW', null, admin)).toEqual({ kind: 'noop' });
  });

  it('locks Do Not Contact leads for agents only (D12)', () => {
    expect(decideMove('DO_NOT_CONTACT', 'CLIENT', agent)).toEqual({ kind: 'locked' });
    expect(decideMove('DO_NOT_CONTACT', 'CLIENT', admin)).toMatchObject({ kind: 'move' });
    expect(decideMove('DO_NOT_CONTACT', 'DO_NOT_CONTACT', agent)).toEqual({ kind: 'noop' });
  });

  it('asks agents to confirm Do Not Contact', () => {
    expect(decideMove('NEW', 'DO_NOT_CONTACT', agent)).toMatchObject({ kind: 'confirm', to: { key: 'DO_NOT_CONTACT' } });
    expect(decideMove('NEW', 'DO_NOT_CONTACT', admin)).toMatchObject({ kind: 'move' });
  });

  it('resolveDrop only accepts visible columns', () => {
    const visible = visiblePipelineColumns(false).map((c) => c.key);
    expect(resolveDrop('NEW', 'CLIENT', visible, agent)).toMatchObject({ kind: 'move' });
    expect(resolveDrop('NEW', 'NOT_INTERESTED', visible, agent)).toEqual({ kind: 'noop' });
    expect(resolveDrop('NEW', 'some-card-id', visible, agent)).toEqual({ kind: 'noop' });
    expect(resolveDrop('NEW', null, visible, agent)).toEqual({ kind: 'noop' });
    expect(resolveDrop(null, 'CLIENT', visible, agent)).toEqual({ kind: 'noop' });
    expect(resolveDrop('NO_ANSWER', 'TO_CALL', visible, agent)).toEqual({ kind: 'noop' });
  });
});

describe('moveTargets', () => {
  it('lists every other column, open first, closed separately', () => {
    const targets = moveTargets('NO_ANSWER', { isAdmin: false });
    expect(targets.open.map((c) => c.key)).toEqual(['NEW', 'CONNECTED', 'INTERESTED', 'APPOINTMENT', 'PROPOSAL', 'CLIENT']);
    expect(targets.closed.map((c) => c.key)).toEqual(['NOT_INTERESTED', 'DO_NOT_CONTACT']);
    expect(moveTargets('NOT_INTERESTED', { isAdmin: false }).closed.map((c) => c.key)).toEqual(['DO_NOT_CONTACT']);
  });

  it('is empty for an agent on a Do Not Contact lead, full for an admin', () => {
    expect(moveTargets('DO_NOT_CONTACT', { isAdmin: false })).toEqual({ open: [], closed: [] });
    const admin = moveTargets('DO_NOT_CONTACT', { isAdmin: true });
    expect(admin.open).toHaveLength(7);
    expect(admin.closed.map((c) => c.key)).toEqual(['NOT_INTERESTED']);
    expect(admin.open.length + admin.closed.length).toBe(ALL_PIPELINE_COLUMNS.length - 1);
  });
});
