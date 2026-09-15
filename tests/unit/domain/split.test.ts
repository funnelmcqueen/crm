import { describe, expect, it } from 'vitest';
import { evenSplitAssignments, splitCounts } from '../../../src/lib/domain/split';

describe('splitCounts', () => {
  it.each([
    [100, 3, [34, 33, 33]],
    [10, 4, [3, 3, 2, 2]],
    [0, 3, [0, 0, 0]],
    [2, 5, [1, 1, 0, 0, 0]],
    [7, 1, [7]],
    [9, 3, [3, 3, 3]],
  ])('splits %i into %i parts as %j', (total, parts, expected) => {
    expect(splitCounts(total, parts)).toEqual(expected);
  });

  it('always sums to the total and differs by at most one', () => {
    for (let total = 0; total <= 60; total += 1) {
      for (let parts = 1; parts <= 9; parts += 1) {
        const counts = splitCounts(total, parts);
        expect(counts).toHaveLength(parts);
        expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total);
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        expect([...counts].sort((a, b) => b - a)).toEqual(counts);
      }
    }
  });

  it.each([
    [10, 0],
    [-1, 2],
    [10, -2],
    [1.5, 2],
    [10, 2.5],
    [Number.NaN, 2],
    [10, Number.POSITIVE_INFINITY],
  ])('rejects total=%s parts=%s', (total, parts) => {
    expect(() => splitCounts(total, parts)).toThrow(RangeError);
  });
});

describe('evenSplitAssignments', () => {
  it('assigns contiguous blocks in target order', () => {
    expect(evenSplitAssignments(5, ['a', 'b'])).toEqual(['a', 'a', 'a', 'b', 'b']);
    expect(evenSplitAssignments(4, ['a', 'b', 'c'])).toEqual(['a', 'a', 'b', 'c']);
    expect(evenSplitAssignments(3, ['solo'])).toEqual(['solo', 'solo', 'solo']);
  });

  it('matches the 34/33/33 example', () => {
    const assignments = evenSplitAssignments(100, ['alex', 'blair', 'casey']);
    expect(assignments).toHaveLength(100);
    expect(assignments.slice(0, 34).every((t) => t === 'alex')).toBe(true);
    expect(assignments.slice(34, 67).every((t) => t === 'blair')).toBe(true);
    expect(assignments.slice(67).every((t) => t === 'casey')).toBe(true);
  });

  it('keeps target identity and handles more targets than items', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const assignments = evenSplitAssignments(2, [a, b, c]);
    expect(assignments).toEqual([a, b]);
    expect(assignments[0]).toBe(a);
  });

  it('returns nothing for zero items and refuses items without targets', () => {
    expect(evenSplitAssignments(0, [])).toEqual([]);
    expect(evenSplitAssignments(0, ['a'])).toEqual([]);
    expect(() => evenSplitAssignments(3, [])).toThrow(RangeError);
    expect(() => evenSplitAssignments(-1, ['a'])).toThrow(RangeError);
  });
});
