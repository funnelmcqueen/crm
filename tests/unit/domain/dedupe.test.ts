import { describe, expect, it } from 'vitest';
import {
  findDuplicates,
  nameCityKey,
  type DedupeCandidate,
  type ExistingLeadKeys,
} from '../../../src/lib/domain/dedupe';

const P1 = '+12125550100';
const P2 = '+12125550101';

function row(rowIndex: number, overrides: Partial<DedupeCandidate> = {}): DedupeCandidate {
  return { rowIndex, phoneE164: null, websiteDomain: null, nameCityKey: null, ...overrides };
}

function lead(leadId: string, overrides: Partial<ExistingLeadKeys> = {}): ExistingLeadKeys {
  return { leadId, phone: null, websiteDomain: null, nameCityKey: null, ...overrides };
}

describe('nameCityKey', () => {
  it.each([
    ["Joe's Pizza & Grill", 'New York', 'joespizzagrill|newyork'],
    ['ACME, Inc.', null, 'acmeinc|'],
    ['ACME, Inc.', undefined, 'acmeinc|'],
    ['ACME, Inc.', '', 'acmeinc|'],
    ['acme inc', 'NEW-YORK', 'acmeinc|newyork'],
    ['Café Olé', 'São Paulo', 'cafol|sopaulo'],
    ['123 Plumbing', 'St. Louis', '123plumbing|stlouis'],
    ['  Tab\tName\n ', 'city_name', 'tabname|cityname'],
    ['Pizza 🍕 Place', 'Austin', 'pizzaplace|austin'],
  ])('keys %j + %j as %j', (business, city, expected) => {
    expect(nameCityKey(business, city)).toBe(expected);
  });

  it.each([
    [null, 'Austin'],
    [undefined, undefined],
    ['', 'Austin'],
    ['   ', 'Austin'],
    ['!!!', 'Austin'],
    ['\uFF21\uFF23\uFF2D\uFF25', 'Austin'],
  ])('returns null when the business part is empty (%j)', (business, city) => {
    expect(nameCityKey(business, city)).toBeNull();
  });

  it('ignores case and punctuation differences', () => {
    expect(nameCityKey('Smith & Sons Roofing', 'Los Angeles')).toBe(nameCityKey('SMITH AND SONS ROOFING', 'los angeles')?.replace('and', ''));
    expect(nameCityKey('Smith-Sons Roofing', 'Los Angeles')).toBe(nameCityKey('smith sons roofing!', 'LOS-ANGELES'));
  });
});

describe('findDuplicates', () => {
  it('returns nothing when no keys are shared', () => {
    expect(
      findDuplicates(
        [row(0, { phoneE164: P1, websiteDomain: 'a.com', nameCityKey: 'a|x' }), row(1, { phoneE164: P2, websiteDomain: 'b.com', nameCityKey: 'b|x' })],
        [lead('L1', { phone: '+12125550102', websiteDomain: 'c.com', nameCityKey: 'c|x' })],
      ),
    ).toEqual([]);
  });

  it('does not flag the first in-file occurrence; later ones reference all earlier rows', () => {
    expect(findDuplicates([row(0, { phoneE164: P1 }), row(1, { phoneE164: P1 }), row(2, { phoneE164: P1 })], [])).toEqual([
      { rowIndex: 1, reasons: ['phone'], existingLeadIds: [], duplicateOfRowIndexes: [0] },
      { rowIndex: 2, reasons: ['phone'], existingLeadIds: [], duplicateOfRowIndexes: [0, 1] },
    ]);
  });

  it('flags the first occurrence when it matches an existing lead', () => {
    expect(
      findDuplicates(
        [row(0, { websiteDomain: 'example.com' }), row(1, { websiteDomain: 'example.com' })],
        [lead('L1', { websiteDomain: 'example.com' })],
      ),
    ).toEqual([
      { rowIndex: 0, reasons: ['domain'], existingLeadIds: ['L1'], duplicateOfRowIndexes: [] },
      { rowIndex: 1, reasons: ['domain'], existingLeadIds: ['L1'], duplicateOfRowIndexes: [0] },
    ]);
  });

  it('orders reasons phone, domain, name_city and lists each lead once', () => {
    const matches = findDuplicates(
      [row(5, { phoneE164: P1, websiteDomain: 'acme.com', nameCityKey: 'acme|austin' })],
      [
        lead('L1', { phone: P1, nameCityKey: 'acme|austin' }),
        lead('L2', { phone: P1 }),
        lead('L3', { nameCityKey: 'acme|austin' }),
        lead('L4', { websiteDomain: 'other.com' }),
      ],
    );
    expect(matches).toEqual([
      { rowIndex: 5, reasons: ['phone', 'name_city'], existingLeadIds: ['L1', 'L2', 'L3'], duplicateOfRowIndexes: [] },
    ]);
  });

  it('matches different earlier rows by different keys', () => {
    expect(
      findDuplicates(
        [
          row(0, { phoneE164: P1 }),
          row(1, { websiteDomain: 'a.com' }),
          row(2, { phoneE164: P1, websiteDomain: 'a.com', nameCityKey: 'x|y' }),
        ],
        [],
      ),
    ).toEqual([{ rowIndex: 2, reasons: ['phone', 'domain'], existingLeadIds: [], duplicateOfRowIndexes: [0, 1] }]);
  });

  it('ignores null and empty keys on both sides', () => {
    expect(
      findDuplicates(
        [row(0), row(1), row(2, { phoneE164: '', websiteDomain: '  ', nameCityKey: '' })],
        [lead('L1'), lead('L2', { phone: '', websiteDomain: '', nameCityKey: '' })],
      ),
    ).toEqual([]);
  });

  it('ignores SQL name keys with an empty business part', () => {
    expect(findDuplicates([row(0, { nameCityKey: '|austin' })], [lead('L1', { nameCityKey: '|austin' })])).toEqual([]);
  });

  it('compares domains case-insensitively', () => {
    expect(findDuplicates([row(0, { websiteDomain: 'Example.com' })], [lead('L1', { websiteDomain: 'example.COM' })])).toEqual([
      { rowIndex: 0, reasons: ['domain'], existingLeadIds: ['L1'], duplicateOfRowIndexes: [] },
    ]);
  });

  it('uses rowIndex order (not array order) and supports gaps in row indexes', () => {
    expect(findDuplicates([row(7, { phoneE164: P1 }), row(3, { phoneE164: P1 })], [])).toEqual([
      { rowIndex: 7, reasons: ['phone'], existingLeadIds: [], duplicateOfRowIndexes: [3] },
    ]);
  });

  it('never reports a row as a duplicate of itself', () => {
    expect(findDuplicates([row(0, { phoneE164: P1 }), row(0, { phoneE164: P1 })], [])).toEqual([]);
  });

  it('handles large files', () => {
    const rows: DedupeCandidate[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      rows.push(row(i, { phoneE164: `+1212555${String(Math.floor(i / 2)).padStart(4, '0')}` }));
    }
    const existing = Array.from({ length: 10_000 }, (_, i) => lead(`L${i}`, { websiteDomain: `site${i}.com` }));
    const matches = findDuplicates(rows, existing);
    expect(matches).toHaveLength(5_000);
    expect(matches[0]).toEqual({ rowIndex: 1, reasons: ['phone'], existingLeadIds: [], duplicateOfRowIndexes: [0] });
  });
});
