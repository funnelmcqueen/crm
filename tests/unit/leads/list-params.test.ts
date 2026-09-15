import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration } from '@/components/common/datetime';
import {
  DEFAULT_LEAD_LIST_PARAMS,
  hasActiveFilters,
  leadListHref,
  pageWindow,
  parseLeadListParams,
  serializeLeadListParams,
} from '@/components/leads/list-params';

const UUID = '3f1c2b7e-8a9d-4c1e-9b2a-6d5e4f3a2b1c';

describe('parseLeadListParams', () => {
  it('returns defaults for an empty query', () => {
    expect(parseLeadListParams({})).toEqual({
      q: '',
      statuses: [],
      source: null,
      agent: null,
      unassigned: false,
      sort: 'created_at',
      dir: 'desc',
      page: 1,
    });
  });

  it('reads every field from a record', () => {
    expect(
      parseLeadListParams({
        q: '  pizza  ',
        status: ['NEW', 'interested'],
        source: ' Yelp ',
        agent: UUID.toUpperCase(),
        unassigned: 'true',
        sort: 'business_name',
        dir: 'DESC',
        page: '3',
      }),
    ).toEqual({
      q: 'pizza',
      statuses: ['NEW', 'INTERESTED'],
      source: 'Yelp',
      agent: UUID,
      unassigned: true,
      sort: 'business_name',
      dir: 'desc',
      page: 3,
    });
  });

  it('accepts comma lists and repeated status params, deduplicated in enum order', () => {
    const search = new URLSearchParams('status=CLIENT,NEW&status=NEW&status=TO_CALL');
    expect(parseLeadListParams(search).statuses).toEqual(['NEW', 'TO_CALL', 'CLIENT']);
  });

  it('falls back to defaults for bad values instead of failing', () => {
    const parsed = parseLeadListParams({
      status: 'NOPE,,DROP TABLE',
      agent: 'not-a-uuid',
      unassigned: 'yes',
      sort: 'phone',
      dir: 'sideways',
      page: '-2',
      source: '   ',
    });
    expect(parsed).toEqual(DEFAULT_LEAD_LIST_PARAMS);
    for (const page of ['0', '1.5', 'abc', '1e3', '99999999999']) {
      expect(parseLeadListParams({ page }).page).toBe(1);
    }
  });

  it('uses the natural direction of each sort when dir is missing', () => {
    expect(parseLeadListParams({ sort: 'business_name' }).dir).toBe('asc');
    expect(parseLeadListParams({ sort: 'next_follow_up_at' }).dir).toBe('asc');
    expect(parseLeadListParams({ sort: 'call_count' }).dir).toBe('desc');
    expect(parseLeadListParams({ sort: 'last_contacted_at' }).dir).toBe('desc');
  });

  it('caps the query and source length', () => {
    const parsed = parseLeadListParams({ q: 'x'.repeat(500), source: 'y'.repeat(500) });
    expect(parsed.q).toHaveLength(200);
    expect(parsed.source).toHaveLength(200);
  });

  it('uses the first value of repeated scalar params', () => {
    expect(parseLeadListParams({ q: ['first', 'second'], page: ['2', '9'] })).toMatchObject({ q: 'first', page: 2 });
  });
});

describe('serializeLeadListParams', () => {
  it('omits defaults', () => {
    expect(serializeLeadListParams(DEFAULT_LEAD_LIST_PARAMS)).toBe('');
    expect(leadListHref(DEFAULT_LEAD_LIST_PARAMS)).toBe('/leads');
  });

  it('round-trips through the parser', () => {
    const params = {
      q: 'acme & sons',
      statuses: ['NEW' as const, 'CLIENT' as const],
      source: 'Google Maps',
      agent: UUID,
      unassigned: false,
      sort: 'call_count' as const,
      dir: 'asc' as const,
      page: 4,
    };
    const query = serializeLeadListParams(params);
    expect(query).toContain('status=NEW%2CCLIENT');
    expect(query).toContain('dir=asc');
    expect(parseLeadListParams(new URLSearchParams(query))).toEqual(params);
  });

  it('drops the agent when unassigned is on', () => {
    const query = serializeLeadListParams({ ...DEFAULT_LEAD_LIST_PARAMS, agent: UUID, unassigned: true });
    expect(query).toBe('unassigned=1');
  });

  it('omits dir when it equals the default for the sort', () => {
    expect(serializeLeadListParams({ ...DEFAULT_LEAD_LIST_PARAMS, sort: 'business_name', dir: 'asc' })).toBe('sort=business_name');
    expect(serializeLeadListParams({ ...DEFAULT_LEAD_LIST_PARAMS, sort: 'business_name', dir: 'desc' })).toBe(
      'sort=business_name&dir=desc',
    );
  });
});

describe('hasActiveFilters', () => {
  it('ignores sort and page', () => {
    expect(hasActiveFilters({ ...DEFAULT_LEAD_LIST_PARAMS, sort: 'call_count', page: 3 })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_LEAD_LIST_PARAMS, q: 'a' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_LEAD_LIST_PARAMS, statuses: ['NEW'] })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_LEAD_LIST_PARAMS, source: 'Yelp' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_LEAD_LIST_PARAMS, unassigned: true })).toBe(true);
  });
});

describe('pageWindow', () => {
  it('computes "Showing 26-50 of 137"', () => {
    expect(pageWindow(2, 25, 137, 25)).toEqual({ page: 2, pageSize: 25, total: 137, pageCount: 6, from: 26, to: 50 });
    expect(pageWindow(6, 25, 137, 12)).toMatchObject({ from: 126, to: 137 });
    expect(pageWindow(1, 25, 0, 0)).toMatchObject({ pageCount: 1, from: 0, to: 0 });
    expect(pageWindow(9, 25, 137, 0)).toMatchObject({ pageCount: 6, from: 0, to: 0 });
  });
});

describe('formatDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('0:00');
    expect(formatDuration(-3)).toBe('0:00');
  });
});

describe('formatDateTime', () => {
  const instant = '2026-03-10T14:30:00Z';
  it('formats in the viewer time zone', () => {
    expect(formatDateTime(instant, 'America/New_York', 'datetime')).toBe('Mar 10, 2026, 10:30 AM');
    expect(formatDateTime(instant, 'America/Los_Angeles', 'date')).toBe('Mar 10, 2026');
  });

  it('drops the year for the current year only', () => {
    expect(formatDateTime(instant, 'America/Chicago', 'smart', '2026-09-15T12:00:00Z')).toBe('Tue, Mar 10, 9:30 AM');
    expect(formatDateTime(instant, 'America/Chicago', 'smart', '2027-01-15T12:00:00Z')).toBe('Mar 10, 2026, 9:30 AM');
  });

  it('falls back to a valid zone for a bad one', () => {
    expect(formatDateTime(instant, 'Not/AZone', 'datetime')).toBe('Mar 10, 2026, 10:30 AM');
  });
});
