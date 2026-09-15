import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  endOfDayInTz,
  followUpQuickPicks,
  formatInTz,
  startOfDayInTz,
  utcToZonedLocalInput,
  zonedLocalInputToUtc,
} from '../../../src/lib/domain/time';

// Browsers run in the user's zone and servers usually in UTC, so results must not depend on the host.
// Node applies `process.env.TZ` changes at runtime in the process that owns the test (vitest forks pool).
const HOST_ZONES = ['America/Los_Angeles', 'Pacific/Auckland', 'Europe/London', 'Asia/Kolkata', 'UTC'];
const NY = 'America/New_York';
const HOUR = 3_600_000;

const originalEnvTz = process.env.TZ;
const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// V8 reports some zones under their legacy canonical name (Asia/Kolkata -> Asia/Calcutta).
function canonicalZone(zone: string): string {
  return Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
}

function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function hostCanSwitchZones(): boolean {
  const probe = canonicalZone(originalZone) === canonicalZone('Pacific/Chatham') ? 'Pacific/Kiritimati' : 'Pacific/Chatham';
  process.env.TZ = probe;
  const switched = hostZone() === canonicalZone(probe);
  process.env.TZ = originalEnvTz ?? originalZone;
  return switched;
}

describe.skipIf(!hostCanSwitchZones()).each(HOST_ZONES)('time helpers with the host time zone set to %s', (zone) => {
  beforeAll(() => {
    process.env.TZ = zone;
  });

  afterAll(() => {
    process.env.TZ = originalEnvTz ?? originalZone;
  });

  it('runs in that host zone', () => {
    expect(hostZone()).toBe(canonicalZone(zone));
  });

  it('resolves skipped and repeated wall times identically', () => {
    expect(zonedLocalInputToUtc('2026-11-01T01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedLocalInputToUtc('2026-03-08T02:30', NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(zonedLocalInputToUtc('2026-03-08T02:30', 'America/Chicago').toISOString()).toBe('2026-03-08T08:30:00.000Z');
    // New Zealand falls back at 03:00 NZDT on 2026-04-05; the first 02:30 is NZDT (+13).
    expect(zonedLocalInputToUtc('2026-04-05T02:30', 'Pacific/Auckland').toISOString()).toBe('2026-04-04T13:30:00.000Z');
    // Wall times that do not exist in some host zones but do in the target zone.
    expect(zonedLocalInputToUtc('2026-03-08T02:30', 'UTC').toISOString()).toBe('2026-03-08T02:30:00.000Z');
    expect(zonedLocalInputToUtc('2026-03-29T01:30', 'UTC').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedLocalInputToUtc('2026-09-27T02:30', 'UTC').toISOString()).toBe('2026-09-27T02:30:00.000Z');
  });

  it('computes day bounds and quick picks identically', () => {
    expect(startOfDayInTz(NY, '2026-03-08T12:00:00Z').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(endOfDayInTz(NY, '2026-03-08T12:00:00Z').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(startOfDayInTz(NY, '2026-11-01T12:00:00Z').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(endOfDayInTz(NY, '2026-11-01T12:00:00Z').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(startOfDayInTz('Asia/Kolkata', '2026-01-01T00:00:00Z').toISOString()).toBe('2025-12-31T18:30:00.000Z');

    const spring = followUpQuickPicks(NY, '2026-03-06T15:00:00Z');
    expect([spring.tomorrow9am, spring.in3Days, spring.nextWeek].map((d) => d.toISOString())).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
      '2026-03-13T13:00:00.000Z',
    ]);
    const fall = followUpQuickPicks(NY, '2026-10-30T16:00:00Z');
    expect([fall.tomorrow9am, fall.in3Days, fall.nextWeek].map((d) => d.toISOString())).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-06T14:00:00.000Z',
    ]);
  });

  it('formats instants identically, including wall times inside the host zone DST gaps', () => {
    expect(utcToZonedLocalInput('2026-03-08T02:30:00Z', 'UTC')).toBe('2026-03-08T02:30');
    expect(utcToZonedLocalInput('2026-03-29T01:30:00Z', 'UTC')).toBe('2026-03-29T01:30');
    expect(utcToZonedLocalInput('2026-09-27T02:30:00Z', 'UTC')).toBe('2026-09-27T02:30');
    expect(formatInTz('2026-11-01T05:30:00Z', NY, 'yyyy-MM-dd HH:mm xxx')).toBe('2026-11-01 01:30 -04:00');
    expect(formatInTz('2026-11-01T06:30:00Z', NY, 'yyyy-MM-dd HH:mm xxx')).toBe('2026-11-01 01:30 -05:00');
  });

  it('round-trips every 15 minutes across the New York DST weekends', () => {
    const windows: Array<[string, string]> = [
      ['2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'],
      ['2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'],
    ];
    for (const [from, to] of windows) {
      for (let t = Date.parse(from); t < Date.parse(to); t += 15 * 60_000) {
        const back = zonedLocalInputToUtc(utcToZonedLocalInput(t, NY), NY).getTime();
        const repeatedHour = t >= Date.parse('2026-11-01T06:00:00Z') && t < Date.parse('2026-11-01T07:00:00Z');
        expect(back).toBe(repeatedHour ? t - HOUR : t);
      }
    }
  });
});
