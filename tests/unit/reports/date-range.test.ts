// Report date ranges: presets per timezone, URL parsing, and local-midnight instants across DST.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_PRESET,
  MAX_REPORT_DAYS,
  addLocalDays,
  formatRangeLabel,
  isLocalDate,
  localDaySpan,
  matchPreset,
  parseReportRangeParams,
  presetRange,
  rangeToInstants,
  reportRangeHref,
  todayInTz,
  validateLocalRange,
} from '@/components/admin/reports/date-range';

const NY = 'America/New_York';
const HOUR = 3_600_000;

function spanHours(range: { from: string; to: string }, tz: string): number {
  const { fromIso, toIso } = rangeToInstants(range, tz);
  return (Date.parse(toIso) - Date.parse(fromIso)) / HOUR;
}

describe('local date helpers', () => {
  it('accepts only real yyyy-MM-dd dates', () => {
    expect(isLocalDate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '20260105', '1999-12-31', '', null, 20260101]) {
      expect(isLocalDate(bad)).toBe(false);
    }
  });

  it('adds calendar days across months, leap days and years', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addLocalDays('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('counts inclusive days', () => {
    expect(localDaySpan({ from: '2026-03-08', to: '2026-03-08' })).toBe(1);
    expect(localDaySpan({ from: '2024-01-01', to: '2024-12-31' })).toBe(366);
  });
});

describe('todayInTz and presets', () => {
  // 2026-03-09 03:30 UTC is still March 8 in the Americas, already March 9 in UTC and Tokyo.
  const lateEvening = Date.parse('2026-03-09T03:30:00Z');

  it('resolves "today" in the admin timezone', () => {
    expect(todayInTz(NY, lateEvening)).toBe('2026-03-08');
    expect(todayInTz('America/Los_Angeles', lateEvening)).toBe('2026-03-08');
    expect(todayInTz('UTC', lateEvening)).toBe('2026-03-09');
    expect(todayInTz('Asia/Tokyo', lateEvening)).toBe('2026-03-09');
  });

  it('builds each preset as inclusive local dates', () => {
    expect(presetRange('today', NY, lateEvening)).toEqual({ from: '2026-03-08', to: '2026-03-08' });
    expect(presetRange('yesterday', NY, lateEvening)).toEqual({ from: '2026-03-07', to: '2026-03-07' });
    expect(presetRange('last7', NY, lateEvening)).toEqual({ from: '2026-03-02', to: '2026-03-08' });
    expect(presetRange('last30', NY, lateEvening)).toEqual({ from: '2026-02-07', to: '2026-03-08' });
    expect(presetRange('thisMonth', NY, lateEvening)).toEqual({ from: '2026-03-01', to: '2026-03-08' });
    expect(presetRange('today', 'Asia/Tokyo', lateEvening)).toEqual({ from: '2026-03-09', to: '2026-03-09' });
  });

  it('handles month and year edges', () => {
    const newYear = Date.parse('2026-01-01T10:00:00Z');
    expect(presetRange('yesterday', NY, newYear)).toEqual({ from: '2025-12-31', to: '2025-12-31' });
    expect(presetRange('thisMonth', NY, newYear)).toEqual({ from: '2026-01-01', to: '2026-01-01' });
    expect(presetRange('last7', NY, newYear)).toEqual({ from: '2025-12-26', to: '2026-01-01' });
  });

  it('matches a range back to its preset', () => {
    expect(matchPreset({ from: '2026-03-02', to: '2026-03-08' }, NY, lateEvening)).toBe('last7');
    expect(matchPreset({ from: '2026-03-08', to: '2026-03-08' }, NY, lateEvening)).toBe('today');
    expect(matchPreset({ from: '2026-03-03', to: '2026-03-08' }, NY, lateEvening)).toBeNull();
  });

  it('falls back to New York for an invalid timezone instead of throwing', () => {
    expect(todayInTz('Not/AZone', lateEvening)).toBe('2026-03-08');
  });
});

describe('validateLocalRange and parseReportRangeParams', () => {
  const now = Date.parse('2026-09-15T16:00:00Z');

  it('validates dates, order and length', () => {
    expect(validateLocalRange('2026-09-01', '2026-09-15')).toBeNull();
    expect(validateLocalRange('2026-09-15', '2026-09-15')).toBeNull();
    expect(validateLocalRange('2026-09-16', '2026-09-15')).toBe('reversed');
    expect(validateLocalRange('2026-02-30', '2026-03-01')).toBe('invalid_date');
    expect(validateLocalRange(undefined, '2026-03-01')).toBe('invalid_date');
    expect(validateLocalRange('2024-01-01', '2024-12-31')).toBeNull();
    expect(validateLocalRange('2025-01-01', '2026-01-01')).toBeNull();
    expect(validateLocalRange('2025-01-01', '2026-01-02')).toBe('too_long');
  });

  it('uses the default preset when the URL has no range', () => {
    expect(parseReportRangeParams({}, NY, now)).toEqual({
      range: presetRange(DEFAULT_REPORT_PRESET, NY, now),
      preset: DEFAULT_REPORT_PRESET,
      problem: null,
    });
  });

  it('keeps a valid custom range and recognizes presets', () => {
    expect(parseReportRangeParams({ from: '2026-08-01', to: '2026-08-31' }, NY, now)).toEqual({
      range: { from: '2026-08-01', to: '2026-08-31' },
      preset: null,
      problem: null,
    });
    expect(parseReportRangeParams({ from: '2026-09-15', to: '2026-09-15' }, NY, now).preset).toBe('today');
    expect(parseReportRangeParams({ from: ['2026-09-14', 'x'], to: ['2026-09-14'] }, NY, now)).toMatchObject({
      range: { from: '2026-09-14', to: '2026-09-14' },
      preset: 'yesterday',
    });
  });

  it('falls back to the default and reports the problem for unusable ranges', () => {
    const fallback = presetRange(DEFAULT_REPORT_PRESET, NY, now);
    expect(parseReportRangeParams({ from: '2026-09-15', to: '2026-09-01' }, NY, now)).toEqual({
      range: fallback,
      preset: DEFAULT_REPORT_PRESET,
      problem: 'reversed',
    });
    expect(parseReportRangeParams({ from: '2026-09-01' }, NY, now).problem).toBe('invalid_date');
    expect(parseReportRangeParams({ from: 'yesterday', to: 'today' }, NY, now).problem).toBe('invalid_date');
    expect(parseReportRangeParams({ from: '2020-01-01', to: '2026-01-01' }, NY, now).problem).toBe('too_long');
  });

  it('builds the URL', () => {
    expect(reportRangeHref({ from: '2026-09-01', to: '2026-09-15' })).toBe('/admin/reports?from=2026-09-01&to=2026-09-15');
  });

  it('labels ranges', () => {
    expect(formatRangeLabel({ from: '2026-03-08', to: '2026-03-08' })).toBe('Mar 8, 2026');
    expect(formatRangeLabel({ from: '2026-03-02', to: '2026-03-08' })).toBe('Mar 2 – Mar 8, 2026');
    expect(formatRangeLabel({ from: '2025-12-26', to: '2026-01-01' })).toBe('Dec 26, 2025 – Jan 1, 2026');
  });
});

describe('rangeToInstants across DST', () => {
  it('uses local midnights in New York (23-hour spring day, 25-hour fall day)', () => {
    expect(rangeToInstants({ from: '2026-03-08', to: '2026-03-08' }, NY)).toEqual({
      fromIso: '2026-03-08T05:00:00.000Z',
      toIso: '2026-03-09T04:00:00.000Z',
    });
    expect(spanHours({ from: '2026-03-08', to: '2026-03-08' }, NY)).toBe(23);
    expect(rangeToInstants({ from: '2026-11-01', to: '2026-11-01' }, NY)).toEqual({
      fromIso: '2026-11-01T04:00:00.000Z',
      toIso: '2026-11-02T05:00:00.000Z',
    });
    expect(spanHours({ from: '2026-11-01', to: '2026-11-01' }, NY)).toBe(25);
    expect(rangeToInstants({ from: '2026-03-01', to: '2026-03-31' }, NY)).toEqual({
      fromIso: '2026-03-01T05:00:00.000Z',
      toIso: '2026-04-01T04:00:00.000Z',
    });
  });

  it('uses local midnights in London and Chicago', () => {
    expect(rangeToInstants({ from: '2026-03-29', to: '2026-03-29' }, 'Europe/London')).toEqual({
      fromIso: '2026-03-29T00:00:00.000Z',
      toIso: '2026-03-29T23:00:00.000Z',
    });
    expect(rangeToInstants({ from: '2026-09-15', to: '2026-09-15' }, 'America/Chicago')).toEqual({
      fromIso: '2026-09-15T05:00:00.000Z',
      toIso: '2026-09-16T05:00:00.000Z',
    });
  });

  it('keeps consecutive days contiguous where DST switches at midnight', { timeout: 30_000 }, () => {
    // Windows covering the 2026 transitions: Santiago (Apr 5, Sep 6, at midnight), Havana and New York
    // (Mar 8, Nov 1), Asuncion (no DST since 2024, a control). One conversion per day keeps this fast.
    const windows: Array<[string, number]> = [
      ['2026-02-25', 50],
      ['2026-08-25', 75],
    ];
    for (const tz of ['America/Santiago', 'America/Havana', 'America/Asuncion', NY]) {
      for (const [start, days] of windows) {
        let previous: { day: string; fromIso: string; toIso: string } | null = null;
        for (let offset = 0; offset < days; offset += 1) {
          const day = addLocalDays(start, offset);
          const current = { day, ...rangeToInstants({ from: day, to: day }, tz) };
          if (previous) expect(previous.toIso, `${tz} ${previous.day}`).toBe(current.fromIso);
          const hours = (Date.parse(current.toIso) - Date.parse(current.fromIso)) / HOUR;
          expect(hours, `${tz} ${day}`).toBeGreaterThanOrEqual(23);
          expect(hours, `${tz} ${day}`).toBeLessThanOrEqual(25);
          previous = current;
        }
      }
    }
    // The Santiago spring-forward day starts at 01:00 local, because 00:00 does not exist.
    expect(spanHours({ from: '2026-09-06', to: '2026-09-06' }, 'America/Santiago')).toBe(23);
  });

  it('never exceeds the SQL limit (366 days plus one hour) for the longest allowed range', () => {
    for (const tz of [NY, 'Europe/London', 'Australia/Sydney', 'America/Santiago']) {
      for (const from of ['2026-03-01', '2026-06-01', '2026-10-15', '2027-01-01']) {
        const range = { from, to: addLocalDays(from, MAX_REPORT_DAYS - 1) };
        expect(validateLocalRange(range.from, range.to)).toBeNull();
        expect(spanHours(range, tz)).toBeLessThanOrEqual(366 * 24 + 1);
      }
    }
  });
});
