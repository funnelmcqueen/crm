// Leads page selection rules (docs/DEVIATIONS.md D41): what keeps a selection, the header checkbox's three states,
// shift-click ranges and the selection cap.
import { describe, expect, it } from 'vitest';
import {
  headerCheckState,
  selectAllMatchingLabel,
  selectionScope,
  togglePage,
  toggleRow,
} from '@/components/leads/bulk/selection';
import { parseLeadListParams } from '@/components/leads/list-params';
import { MAX_BULK_LEADS } from '@/lib/domain/bulk-leads';

const ids = (n: number, prefix = 'id') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

describe('selectionScope', () => {
  it('keeps the selection while paging or sorting, and starts over when search or filters change', () => {
    const base = parseLeadListParams({ q: 'pizza', status: 'NEW,TO_CALL' });
    const scope = selectionScope('ADMIN', base);
    expect(selectionScope('ADMIN', parseLeadListParams({ q: 'pizza', status: 'TO_CALL,NEW', page: '3', sort: 'call_count', dir: 'asc' }))).toBe(scope);
    expect(selectionScope('ADMIN', parseLeadListParams({ q: ' PIZZA ', status: 'NEW,TO_CALL' }))).toBe(scope);

    expect(selectionScope('ADMIN', parseLeadListParams({ q: 'pizzeria', status: 'NEW,TO_CALL' }))).not.toBe(scope);
    expect(selectionScope('ADMIN', parseLeadListParams({ q: 'pizza', status: 'NEW' }))).not.toBe(scope);
    expect(selectionScope('ADMIN', parseLeadListParams({ q: 'pizza', status: 'NEW,TO_CALL', unassigned: '1' }))).not.toBe(scope);
    expect(selectionScope('ADMIN', parseLeadListParams({ q: 'pizza', status: 'NEW,TO_CALL', source: 'Expo' }))).not.toBe(scope);
    expect(selectionScope('AGENT', base)).not.toBe(scope);
  });

  it('ignores the admin-only agent filters for agents, as the list does', () => {
    const agent = selectionScope('AGENT', parseLeadListParams({}));
    expect(selectionScope('AGENT', parseLeadListParams({ unassigned: '1' }))).toBe(agent);
    expect(selectionScope('AGENT', parseLeadListParams({ agent: '4b7f8d3c-1f5e-4f4c-9a51-6d1f0d4d2b11' }))).toBe(agent);
  });
});

describe('headerCheckState', () => {
  it('is unchecked, indeterminate or checked for the rows on this page only', () => {
    const page = ids(3);
    expect(headerCheckState(page, new Set())).toBe('unchecked');
    expect(headerCheckState(page, new Set(['other-page']))).toBe('unchecked');
    expect(headerCheckState(page, new Set([page[1]]))).toBe('indeterminate');
    expect(headerCheckState(page, new Set([...page, 'other-page']))).toBe('checked');
    expect(headerCheckState([], new Set(['x']))).toBe('unchecked');
  });
});

describe('togglePage', () => {
  it('selects the whole page, keeping other pages, and clears it when it was all selected', () => {
    const page = ids(3);
    const selected = togglePage(page, new Set(['elsewhere', page[0]]));
    expect([...selected].sort()).toEqual(['elsewhere', ...page].sort());
    expect([...togglePage(page, selected)]).toEqual(['elsewhere']);
  });

  it('never exceeds the selection cap', () => {
    const almostFull = new Set(ids(MAX_BULK_LEADS - 1, 'held'));
    const result = togglePage(ids(5), almostFull);
    expect(result.size).toBe(MAX_BULK_LEADS);
  });
});

describe('toggleRow', () => {
  const page = ids(6);

  it('toggles one row without an anchor', () => {
    expect([...toggleRow(page, new Set(), page[2])]).toEqual([page[2]]);
    expect([...toggleRow(page, new Set([page[2]]), page[2])]).toEqual([]);
  });

  it('shift-click applies the clicked row\'s new state to the whole range, in either direction', () => {
    expect([...toggleRow(page, new Set([page[1]]), page[4], page[1])].sort()).toEqual(page.slice(1, 5).sort());
    expect([...toggleRow(page, new Set([page[4]]), page[1], page[4])].sort()).toEqual(page.slice(1, 5).sort());
    const all = new Set(page);
    expect([...toggleRow(page, all, page[3], page[1])].sort()).toEqual([page[0], page[4], page[5]].sort());
  });

  it('falls back to a single toggle when the anchor is not on this page', () => {
    expect([...toggleRow(page, new Set(), page[3], 'gone')]).toEqual([page[3]]);
  });
});

describe('selectAllMatchingLabel', () => {
  it('offers the rest of the matching leads, capped, and nothing once everything is selected', () => {
    expect(selectAllMatchingLabel(25, 1240)).toBe('Select all 1,240 matching');
    expect(selectAllMatchingLabel(25, 7300)).toBe(`Select the first 5,000 of 7,300`);
    expect(selectAllMatchingLabel(1240, 1240)).toBeNull();
    expect(selectAllMatchingLabel(MAX_BULK_LEADS, 7300)).toBeNull();
    expect(selectAllMatchingLabel(1, 1)).toBeNull();
  });
});
