import { describe, expect, it } from 'vitest';
import {
  endOfDayInTz,
  followUpQuickPicks,
  formatInTz,
  isValidTimeZone,
  startOfDayInTz,
  tryZonedLocalInputToUtc,
  utcToZonedLocalInput,
  zonedLocalInputToUtc,
} from '../../../src/lib/domain/time';

const NY = 'America/New_York';
const HOUR = 3_600_000;
const iso = (date: Date) => date.toISOString();

describe('isValidTimeZone', () => {
  it.each(['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Asia/Tokyo', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'])(
    'accepts %j',
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(true);
    },
  );

  it.each(['utc', 'america/new_york', '+05:00', '-0500', '', 'Foo/Bar', 'America/New_York ', 'America//New_York', 'Mars/Olympus_Mons', null, undefined, 5])(
    'rejects %j',
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(false);
    },
  );
});

describe('startOfDayInTz / endOfDayInTz', () => {
  it('handles a regular day', () => {
    expect(iso(startOfDayInTz(NY, '2026-09-15T12:00:00Z'))).toBe('2026-09-15T04:00:00.000Z');
    expect(iso(endOfDayInTz(NY, '2026-09-15T12:00:00Z'))).toBe('2026-09-16T04:00:00.000Z');
  });

  it('handles the 23-hour spring-forward day (America/New_York, 2026-03-08)', () => {
    const start = startOfDayInTz(NY, '2026-03-08T12:00:00Z');
    const end = endOfDayInTz(NY, '2026-03-08T12:00:00Z');
    expect(iso(start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(end)).toBe('2026-03-09T04:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
    // 01:59 EST, before the jump, is the same local day.
    expect(iso(startOfDayInTz(NY, '2026-03-08T06:59:00Z'))).toBe('2026-03-08T05:00:00.000Z');
  });

  it('handles the 25-hour fall-back day (America/New_York, 2026-11-01)', () => {
    const start = startOfDayInTz(NY, '2026-11-01T12:00:00Z');
    const end = endOfDayInTz(NY, '2026-11-01T12:00:00Z');
    expect(iso(start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(end)).toBe('2026-11-02T05:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
    // Both 01:30 occurrences belong to the same day.
    expect(iso(startOfDayInTz(NY, '2026-11-01T05:30:00Z'))).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(startOfDayInTz(NY, '2026-11-01T06:30:00Z'))).toBe('2026-11-01T04:00:00.000Z');
  });

  it('uses the local calendar day, not the UTC one', () => {
    // 23:30 EDT on Sep 15 is already Sep 16 in UTC.
    expect(iso(startOfDayInTz(NY, '2026-09-16T03:30:00Z'))).toBe('2026-09-15T04:00:00.000Z');
    expect(iso(startOfDayInTz(NY, '2026-09-16T04:00:00Z'))).toBe('2026-09-16T04:00:00.000Z');
    expect(iso(startOfDayInTz('Asia/Tokyo', '2026-09-15T16:00:00Z'))).toBe('2026-09-15T15:00:00.000Z');
    expect(iso(startOfDayInTz('Asia/Kolkata', '2026-01-01T00:00:00Z'))).toBe('2025-12-31T18:30:00.000Z');
    expect(iso(startOfDayInTz('UTC', '2026-01-01T23:59:59Z'))).toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts Date, timestamp and ISO string references', () => {
    const expected = '2026-09-15T05:00:00.000Z';
    expect(iso(startOfDayInTz('America/Chicago', new Date('2026-09-15T12:00:00Z')))).toBe(expected);
    expect(iso(startOfDayInTz('America/Chicago', Date.parse('2026-09-15T12:00:00Z')))).toBe(expected);
    expect(iso(startOfDayInTz('America/Chicago', '2026-09-15T07:00:00-05:00'))).toBe(expected);
  });

  it('defaults to now', () => {
    const now = Date.now();
    expect(startOfDayInTz(NY).getTime()).toBeLessThanOrEqual(now);
    expect(endOfDayInTz(NY).getTime()).toBeGreaterThan(now);
  });

  it('throws on invalid input', () => {
    expect(() => startOfDayInTz('Not/AZone', '2026-01-01T00:00:00Z')).toThrow(RangeError);
    expect(() => endOfDayInTz(NY, 'not a date')).toThrow(RangeError);
    expect(() => startOfDayInTz(NY, new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('followUpQuickPicks', () => {
  it('crosses the spring-forward transition at 09:00 local', () => {
    // Fri 2026-03-06 10:00 EST
    const picks = followUpQuickPicks(NY, '2026-03-06T15:00:00Z');
    expect(iso(picks.tomorrow9am)).toBe('2026-03-07T14:00:00.000Z'); // Sat 09:00 EST
    expect(iso(picks.in3Days)).toBe('2026-03-09T13:00:00.000Z'); // Mon 09:00 EDT
    expect(iso(picks.nextWeek)).toBe('2026-03-13T13:00:00.000Z'); // Fri 09:00 EDT
  });

  it('crosses the fall-back transition at 09:00 local', () => {
    // Fri 2026-10-30 12:00 EDT
    const picks = followUpQuickPicks(NY, '2026-10-30T16:00:00Z');
    expect(iso(picks.tomorrow9am)).toBe('2026-10-31T13:00:00.000Z'); // Sat 09:00 EDT
    expect(iso(picks.in3Days)).toBe('2026-11-02T14:00:00.000Z'); // Mon 09:00 EST
    expect(iso(picks.nextWeek)).toBe('2026-11-06T14:00:00.000Z'); // Fri 09:00 EST
  });

  it('counts from the local day even when UTC is already tomorrow', () => {
    // 23:30 EDT on Sep 15
    const picks = followUpQuickPicks(NY, '2026-09-16T03:30:00Z');
    expect(iso(picks.tomorrow9am)).toBe('2026-09-16T13:00:00.000Z');
    expect(iso(picks.in3Days)).toBe('2026-09-18T13:00:00.000Z');
    expect(iso(picks.nextWeek)).toBe('2026-09-22T13:00:00.000Z');
  });

  it('is tomorrow even before 9am today', () => {
    expect(iso(followUpQuickPicks(NY, '2026-09-15T11:00:00Z').tomorrow9am)).toBe('2026-09-16T13:00:00.000Z');
  });

  it('rolls over months and years', () => {
    const picks = followUpQuickPicks(NY, '2026-12-31T20:00:00Z');
    expect(iso(picks.tomorrow9am)).toBe('2027-01-01T14:00:00.000Z');
    expect(iso(picks.in3Days)).toBe('2027-01-03T14:00:00.000Z');
    expect(iso(picks.nextWeek)).toBe('2027-01-07T14:00:00.000Z');
    expect(iso(followUpQuickPicks('America/Los_Angeles', '2026-02-26T18:00:00Z').in3Days)).toBe('2026-03-01T17:00:00.000Z');
  });

  it('works in other zones', () => {
    expect(iso(followUpQuickPicks('America/Los_Angeles', '2026-09-15T18:00:00Z').tomorrow9am)).toBe('2026-09-16T16:00:00.000Z');
    expect(iso(followUpQuickPicks('Asia/Kolkata', '2026-09-15T20:00:00Z').tomorrow9am)).toBe('2026-09-17T03:30:00.000Z');
  });

  it('throws for an invalid time zone', () => {
    expect(() => followUpQuickPicks('Nowhere/City', '2026-09-15T12:00:00Z')).toThrow(RangeError);
  });
});

describe('zonedLocalInputToUtc', () => {
  it.each([
    ['2026-09-15T14:30', NY, '2026-09-15T18:30:00.000Z'],
    ['2026-01-15T14:30', NY, '2026-01-15T19:30:00.000Z'],
    ['2026-07-04T09:00:30', 'America/Los_Angeles', '2026-07-04T16:00:30.000Z'],
    ['2026-02-28T23:59', 'Asia/Kolkata', '2026-02-28T18:29:00.000Z'],
    ['2028-02-29T10:00', 'UTC', '2028-02-29T10:00:00.000Z'],
    // Spring forward: 02:00-02:59 does not exist and moves forward one hour.
    ['2026-03-08T01:30', NY, '2026-03-08T06:30:00.000Z'],
    ['2026-03-08T02:30', NY, '2026-03-08T07:30:00.000Z'],
    ['2026-03-08T03:00', NY, '2026-03-08T07:00:00.000Z'],
    // Fall back: 01:00-01:59 happens twice; the first (EDT) occurrence wins.
    ['2026-11-01T00:30', NY, '2026-11-01T04:30:00.000Z'],
    ['2026-11-01T01:30', NY, '2026-11-01T05:30:00.000Z'],
    ['2026-11-01T02:00', NY, '2026-11-01T07:00:00.000Z'],
  ])('converts %s in %s to %s', (value, tz, expected) => {
    expect(iso(zonedLocalInputToUtc(value, tz))).toBe(expected);
    expect(tryZonedLocalInputToUtc(value, tz)?.toISOString()).toBe(expected);
  });

  it.each([
    '',
    '2026-02-30T10:00',
    '2026-02-29T10:00',
    '2026-13-01T10:00',
    '2026-00-10T10:00',
    '2026-01-00T10:00',
    '2026-01-01 10:00',
    '2026-01-01T24:00',
    '2026-01-01T10:60',
    '2026-01-01T10:00:60',
    '2026-1-1T10:00',
    '2026-01-01T10:00Z',
    'yesterday',
    '0999-01-01T10:00',
  ])('rejects %j', (value) => {
    expect(() => zonedLocalInputToUtc(value, NY)).toThrow(RangeError);
    expect(tryZonedLocalInputToUtc(value, NY)).toBeNull();
  });

  it('rejects an invalid time zone', () => {
    expect(() => zonedLocalInputToUtc('2026-01-01T10:00', 'Bad/Zone')).toThrow(RangeError);
    expect(tryZonedLocalInputToUtc('2026-01-01T10:00', 'Bad/Zone')).toBeNull();
    expect(tryZonedLocalInputToUtc(null, NY)).toBeNull();
  });
});

describe('utcToZonedLocalInput', () => {
  it.each([
    ['2026-09-15T18:30:00Z', NY, '2026-09-15T14:30'],
    ['2026-03-08T06:30:00Z', NY, '2026-03-08T01:30'],
    ['2026-03-08T07:30:00Z', NY, '2026-03-08T03:30'],
    ['2026-11-01T05:30:00Z', NY, '2026-11-01T01:30'],
    ['2026-11-01T06:30:00Z', NY, '2026-11-01T01:30'],
    ['2026-09-15T20:00:00Z', 'Asia/Kolkata', '2026-09-16T01:30'],
  ])('formats %s in %s as %s', (value, tz, expected) => {
    expect(utcToZonedLocalInput(new Date(value), tz)).toBe(expected);
    expect(utcToZonedLocalInput(value, tz)).toBe(expected);
  });

  it('round-trips every 15 minutes across both DST weekends', () => {
    const windows: Array<[string, string]> = [
      ['2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'],
      ['2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'],
    ];
    for (const [from, to] of windows) {
      for (let t = Date.parse(from); t < Date.parse(to); t += 15 * 60_000) {
        const local = utcToZonedLocalInput(t, NY);
        const back = zonedLocalInputToUtc(local, NY).getTime();
        // Only the repeated fall-back hour maps to its earlier (EDT) occurrence.
        const repeatedHour = t >= Date.parse('2026-11-01T06:00:00Z') && t < Date.parse('2026-11-01T07:00:00Z');
        expect(back).toBe(repeatedHour ? t - HOUR : t);
      }
    }
  });
});

describe('formatInTz', () => {
  it('formats in the given zone regardless of the machine zone', () => {
    expect(formatInTz(new Date('2026-09-15T16:05:00Z'), 'America/Chicago', 'yyyy-MM-dd HH:mm')).toBe('2026-09-15 11:05');
    expect(formatInTz('2026-09-15T16:05:00Z', 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')).toBe('2026-09-16 01:05');
    expect(formatInTz(Date.parse('2026-09-15T16:05:00Z'), NY, 'EEE MMM d, h:mm a')).toBe('Tue Sep 15, 12:05 PM');
  });

  it('throws on invalid input', () => {
    expect(() => formatInTz('garbage', NY, 'yyyy')).toThrow(RangeError);
    expect(() => formatInTz(new Date(), 'Nope/Zone', 'yyyy')).toThrow(RangeError);
  });
});
