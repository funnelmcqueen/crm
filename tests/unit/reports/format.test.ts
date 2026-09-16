import { describe, expect, it } from 'vitest';
import {
  SPAM_MAX_ANSWER_RATE,
  SPAM_MIN_DIALS,
  formatAvgCall,
  formatCount,
  formatPercent,
  isPossibleSpamFlag,
  talkMinutes,
} from '@/components/admin/reports/format';

describe('report formatting', () => {
  it('flags a low answer rate only with enough dials', () => {
    expect(SPAM_MIN_DIALS).toBe(20);
    expect(SPAM_MAX_ANSWER_RATE).toBe(0.15);
    expect(isPossibleSpamFlag(20, 0.1499)).toBe(true);
    expect(isPossibleSpamFlag(250, 0)).toBe(true);
    expect(isPossibleSpamFlag(19, 0)).toBe(false);
    expect(isPossibleSpamFlag(20, 0.15)).toBe(false);
    expect(isPossibleSpamFlag(0, 0)).toBe(false);
    expect(isPossibleSpamFlag(Number.NaN, 0)).toBe(false);
  });

  it('formats rates as percentages', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.3749)).toBe('37%');
    expect(formatPercent(0.375)).toBe('38%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.005)).toBe('0.5%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });

  it('rounds talk minutes like every other screen', () => {
    expect(talkMinutes(0)).toBe(0);
    expect(talkMinutes(29)).toBe(0);
    expect(talkMinutes(30)).toBe(1);
    expect(talkMinutes(89)).toBe(1);
    expect(talkMinutes(90)).toBe(2);
    expect(talkMinutes(-5)).toBe(0);
  });

  it('formats the average call length as m:ss', () => {
    expect(formatAvgCall(0)).toBe('0:00');
    expect(formatAvgCall(75.5)).toBe('1:16');
    expect(formatAvgCall(59.4)).toBe('0:59');
    expect(formatAvgCall(3725)).toBe('1:02:05');
  });

  it('formats counts with separators', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(0)).toBe('0');
  });
});
