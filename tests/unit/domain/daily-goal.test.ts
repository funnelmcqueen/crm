// Daily goal, pace copy, next best action and consistency (docs/DEVIATIONS.md D43). The goal is the one place every
// target display derives from, so these pin the contradictions it removes (a zero target reading "0 remaining" but
// never reached) and that the copy stays supportive.
import { describe, expect, it } from 'vitest';
import {
  PACE_DAY,
  consistency,
  dailyGoal,
  expectedByNow,
  goalCopy,
  goalFraction,
  isBehindPace,
  nextBestAction,
} from '@/lib/domain/daily-goal';

const at = (hour: number, minute = 0) => hour * 60 + minute;

describe('dailyGoal', () => {
  it('derives remaining, percent, reached and over from dials and target', () => {
    expect(dailyGoal(37, 50)).toEqual({ dials: 37, target: 50, hasTarget: true, remaining: 13, percent: 74, reached: false, over: 0 });
    expect(dailyGoal(50, 50)).toMatchObject({ remaining: 0, percent: 100, reached: true, over: 0 });
    expect(dailyGoal(57, 50)).toMatchObject({ remaining: 0, percent: 100, reached: true, over: 7 });
  });

  it('never shows 100% before the goal is reached', () => {
    expect(dailyGoal(199, 200).percent).toBe(99);
  });

  it('a zero target is "no target": nothing remaining, never reached, an empty bar', () => {
    expect(dailyGoal(3, 0)).toEqual({ dials: 3, target: 0, hasTarget: false, remaining: 0, percent: 0, reached: false, over: 0 });
    expect(goalFraction(dailyGoal(3, 0))).toBe('3 calls');
    expect(goalFraction(dailyGoal(1, 0))).toBe('1 call');
    expect(goalFraction(dailyGoal(3, 50))).toBe('3 / 50');
  });

  it('treats negative or non-finite inputs as zero', () => {
    expect(dailyGoal(-4, Number.NaN)).toMatchObject({ dials: 0, target: 0, hasTarget: false });
  });
});

describe('pace', () => {
  it('spreads the target evenly over the pace day', () => {
    expect(expectedByNow(80, PACE_DAY.startMinute - 60)).toBe(0);
    expect(expectedByNow(80, at(13))).toBe(40);
    expect(expectedByNow(80, PACE_DAY.endMinute + 60)).toBe(80);
  });

  it('is behind only in the afternoon, only when clearly short, and never after the day ends', () => {
    expect(isBehindPace(dailyGoal(0, 80), at(11))).toBe(false);
    expect(isBehindPace(dailyGoal(10, 80), at(14))).toBe(true); // expected 50, 60% is 30
    expect(isBehindPace(dailyGoal(31, 80), at(14))).toBe(false);
    expect(isBehindPace(dailyGoal(10, 80), at(18))).toBe(false);
    expect(isBehindPace(dailyGoal(10, 0), at(14))).toBe(false);
    expect(isBehindPace(dailyGoal(80, 80), at(14))).toBe(false);
  });
});

describe('goalCopy', () => {
  it('covers no calls yet, progress, behind pace late in the day, and goal reached', () => {
    expect(goalCopy(dailyGoal(0, 50), at(9, 30))).toMatchObject({ mood: 'not-started', title: 'Ready when you are' });
    expect(goalCopy(dailyGoal(12, 50), at(10))).toMatchObject({ mood: 'progress', body: '12 calls done, 38 to go.' });
    const behind = goalCopy(dailyGoal(5, 60), at(15));
    expect(behind.mood).toBe('behind');
    expect(behind.body).toBe('55 calls to go. About 28 an hour gets you there by 5pm.');
    expect(goalCopy(dailyGoal(50, 50), at(15))).toMatchObject({ mood: 'reached', body: '50 calls today. Anything more is a bonus.' });
    expect(goalCopy(dailyGoal(53, 50), at(15)).body).toContain('3 past your goal');
    expect(goalCopy(dailyGoal(0, 0), at(15))).toMatchObject({ mood: 'no-target' });
  });

  it('never ranks, compares or scolds', () => {
    const texts = [
      goalCopy(dailyGoal(0, 50), at(9)),
      goalCopy(dailyGoal(0, 50), at(16)),
      goalCopy(dailyGoal(20, 50), at(12)),
      goalCopy(dailyGoal(2, 50), at(16)),
      goalCopy(dailyGoal(60, 50), at(16)),
      goalCopy(dailyGoal(4, 0), at(16)),
    ].flatMap((copy) => [copy.title, copy.body]);
    for (const text of texts) {
      expect(text).not.toMatch(/\b(rank|leaderboard|team|other agents|behind everyone|failed|only|lazy|slow)\b/i);
    }
  });
});

describe('nextBestAction', () => {
  const base = { hasNextLead: false, dialsToday: 0, overdueFollowUps: 0, skipped: 0, leadsAssigned: 20 };

  it('starts or continues the call queue whenever a lead is ready', () => {
    expect(nextBestAction({ ...base, hasNextLead: true, overdueFollowUps: 3, skipped: 4 })).toMatchObject({ kind: 'start-calling', href: '/next' });
    expect(nextBestAction({ ...base, hasNextLead: true, dialsToday: 5 })).toMatchObject({ kind: 'continue-calling', cta: 'Next lead' });
  });

  it('then overdue follow-ups, then the Skipped queue, then the empty states', () => {
    expect(nextBestAction({ ...base, overdueFollowUps: 2, skipped: 4 })).toMatchObject({ kind: 'overdue-follow-ups', href: '/follow-ups?tab=overdue' });
    expect(nextBestAction({ ...base, skipped: 1 })).toMatchObject({ kind: 'review-skipped', href: '/follow-ups?tab=skipped' });
    expect(nextBestAction({ ...base, leadsAssigned: 0 })).toMatchObject({ kind: 'no-leads', href: null });
    expect(nextBestAction(base)).toMatchObject({ kind: 'caught-up', href: '/leads' });
  });
});

describe('consistency', () => {
  it('counts days with at least one call, so days off never reset anything', () => {
    const days = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16'].map((day, i) => ({
      day,
      dials: [3, 0, 0, 12, 1, 0, 4][i],
    }));
    expect(consistency(days)).toEqual({ activeDays: 4, totalDays: 7 });
    expect(consistency([])).toEqual({ activeDays: 0, totalDays: 0 });
  });
});
