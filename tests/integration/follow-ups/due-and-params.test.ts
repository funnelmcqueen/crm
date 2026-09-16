// Pure helpers behind /follow-ups: relative due labels in the viewer's time zone and URL params.
import { describe, expect, it } from 'vitest';
import { describeDue } from '@/components/follow-ups/due';
import { defaultFollowUpTab, followUpsHref, parseFollowUpParams } from '@/components/follow-ups/params';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NY = 'America/New_York';
const AKL = 'Pacific/Auckland';

describe('describeDue', () => {
  // 2026-03-10 10:00 in New York (EDT, UTC-4), 2026-03-11 03:00 in Auckland (NZDT, UTC+13).
  const now = Date.parse('2026-03-10T14:00:00Z');

  it('counts local calendar days for overdue items', () => {
    expect(describeDue('2026-03-09T21:00:00Z', now, NY)).toEqual({ tone: 'overdue', label: '1 day overdue' });
    expect(describeDue('2026-03-07T15:00:00Z', now, NY)).toEqual({ tone: 'overdue', label: '3 days overdue' });
  });

  it('counts minutes and hours within the same local day', () => {
    expect(describeDue(now - 30 * MINUTE, now, NY)).toEqual({ tone: 'overdue', label: '30 min overdue' });
    expect(describeDue(now - 3 * HOUR - 5 * MINUTE, now, NY)).toEqual({ tone: 'overdue', label: '3h overdue' });
    expect(describeDue(now - 20_000, now, NY)).toEqual({ tone: 'overdue', label: 'Due now' });
  });

  it('labels later today, tomorrow and later days', () => {
    expect(describeDue(now + 45 * MINUTE, now, NY)).toEqual({ tone: 'today', label: 'In 45 min' });
    expect(describeDue('2026-03-11T03:30:00Z', now, NY)).toEqual({ tone: 'today', label: 'In 13h' });
    expect(describeDue('2026-03-11T13:00:00Z', now, NY)).toEqual({ tone: 'later', label: 'Tomorrow' });
    expect(describeDue('2026-03-13T13:00:00Z', now, NY)).toEqual({ tone: 'later', label: 'In 3 days' });
  });

  it('depends on the viewer time zone', () => {
    // 2026-03-10T10:00Z is 06:00 the same day in New York but 23:00 the previous day in Auckland.
    expect(describeDue('2026-03-10T10:00:00Z', now, NY)).toEqual({ tone: 'overdue', label: '4h overdue' });
    expect(describeDue('2026-03-10T10:00:00Z', now, AKL)).toEqual({ tone: 'overdue', label: '1 day overdue' });
  });

  it('handles the DST change (23-hour day) as whole days', () => {
    // New York springs forward on 2026-03-08. 09:00 EST on Mar 7 to 09:00 EDT on Mar 9 is 47 hours.
    expect(describeDue('2026-03-07T14:00:00Z', Date.parse('2026-03-09T13:00:00Z'), NY)).toEqual({
      tone: 'overdue',
      label: '2 days overdue',
    });
  });

  it('returns null for invalid input', () => {
    expect(describeDue('not a date', now, NY)).toBeNull();
  });
});

describe('follow-up URL params', () => {
  it('parses leniently', () => {
    expect(parseFollowUpParams({ tab: 'VOICEMAILS', page: '2' })).toEqual({ tab: 'voicemails', page: 2 });
    expect(parseFollowUpParams({ tab: 'bogus', page: '-1' })).toEqual({ tab: null, page: 1 });
    expect(parseFollowUpParams({ tab: ['today', 'overdue'], page: '1e3' })).toEqual({ tab: 'today', page: 1 });
    expect(parseFollowUpParams(new URLSearchParams('tab=completed&page=3'))).toEqual({ tab: 'completed', page: 3 });
    expect(parseFollowUpParams({})).toEqual({ tab: null, page: 1 });
  });

  it('builds hrefs and picks the default tab', () => {
    expect(followUpsHref('today')).toBe('/follow-ups?tab=today');
    expect(followUpsHref('voicemails', 2)).toBe('/follow-ups?tab=voicemails&page=2');
    expect(defaultFollowUpTab(3)).toBe('overdue');
    expect(defaultFollowUpTab(0)).toBe('today');
  });
});
