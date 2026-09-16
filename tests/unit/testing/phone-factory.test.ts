// The fixture phone allocator. phone_numbers.e164 is UNIQUE, so two test files drawing the same
// fictional number turn an insert into a conflict and make "nothing was stored" assertions fail.
// That happened intermittently (5 tests in tests/integration/phone-numbers, ~1 run in 7) because the
// old factory started each file at a random cursor inside its worker's partition. These tests pin the
// property that replaced it: disjoint blocks per factory, disjoint area codes per partition.
import { describe, expect, it } from 'vitest';
import { FIXTURE_AREA_CODES, createPhoneFactory } from '../../helpers/phones';

const FICTIONAL = /^\+1(\d{3})555(01\d{2})$/;

function draw(factory: { next(): string }, count: number): string[] {
  return Array.from({ length: count }, () => factory.next());
}

describe('fixture phone factory', () => {
  it('only issues numbers in the reserved fictional range', () => {
    for (const number of draw(createPhoneFactory({ partition: 0, partitions: 8 }), 120)) {
      const match = FICTIONAL.exec(number);
      expect(match, number).not.toBeNull();
      const line = Number.parseInt(match![2], 10);
      expect(line).toBeGreaterThanOrEqual(100);
      expect(line).toBeLessThanOrEqual(199);
      expect(FIXTURE_AREA_CODES).toContain(match![1]);
    }
  });

  it('never repeats a number across factories in one partition (each test file gets its own block)', () => {
    // 12 factories stands in for the test files a single worker runs.
    const numbers = Array.from({ length: 12 }, () => draw(createPhoneFactory({ partition: 3, partitions: 8 }), 40)).flat();
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('keeps issuing unique numbers when one factory outgrows a block', () => {
    const numbers = draw(createPhoneFactory({ partition: 5, partitions: 8 }), 250);
    expect(new Set(numbers).size).toBe(250);
  });

  it('gives concurrent workers disjoint area codes', () => {
    const partitions = 16;
    const areaCodes = Array.from({ length: partitions }, (_, partition) => {
      const numbers = draw(createPhoneFactory({ partition, partitions }), 30);
      return new Set(numbers.map((n) => FICTIONAL.exec(n)![1]));
    });
    for (let a = 0; a < partitions; a += 1) {
      for (let b = a + 1; b < partitions; b += 1) {
        const shared = [...areaCodes[a]].filter((code) => areaCodes[b].has(code));
        expect(shared, `partitions ${a} and ${b} share area codes`).toEqual([]);
      }
    }
  });

  it('never issues an area code the seed uses', () => {
    // A fixture colliding with a seeded lead's number would corrupt seed-scoped assertions.
    const seeded = new Set(['212', '415', '305']);
    const numbers = draw(createPhoneFactory({ partition: 1, partitions: 4 }), 200);
    for (const number of numbers) expect(seeded.has(FICTIONAL.exec(number)![1])).toBe(false);
  });
});
