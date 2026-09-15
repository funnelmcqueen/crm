import type { CountryCode } from 'libphonenumber-js';
import { describe, expect, it } from 'vitest';
import {
  E164_PATTERN,
  formatPhoneDisplay,
  isE164,
  maskPhone,
  normalizePhone,
  phoneDigits,
} from '../../../src/lib/domain/phone';

// The `leads.phone` CHECK constraint from the migration.
const DB_PHONE_CHECK = /^\+[1-9][0-9]{6,14}$/;

describe('normalizePhone', () => {
  it.each([
    ['(212) 555-0100', '+12125550100'],
    ['212.555.0199', '+12125550199'],
    ['415-555-0150', '+14155550150'],
    ['+1 312 555 0123', '+13125550123'],
    ['1 (646) 555-0142', '+16465550142'],
    ['702 555 0177', '+17025550177'],
    ['(305)555-0101', '+13055550101'],
    ['+1.213.555.0188', '+12135550188'],
    ['12125550100', '+12125550100'],
    ['2125550100', '+12125550100'],
    ['+12125550100', '+12125550100'],
    ['604-555-0100', '+16045550100'],
    ['  (718) 555-0111  ', '+17185550111'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164: expected });
  });

  it('normalizes every reserved fictional 555-0100..0199 number in several area codes', () => {
    for (const areaCode of ['212', '213', '312', '415', '512', '617', '702', '917']) {
      for (let line = 100; line <= 199; line += 1) {
        expect(normalizePhone(`(${areaCode}) 555-0${line}`)).toEqual({
          ok: true,
          e164: `+1${areaCode}5550${line}`,
        });
        expect(normalizePhone(`+1${areaCode}5550${line}`)).toEqual({
          ok: true,
          e164: `+1${areaCode}5550${line}`,
        });
      }
    }
  });

  it.each([
    ['212-555-0100 ext. 12', '+12125550100'],
    ['415.555.0150 x99', '+14155550150'],
    ['+1 212 555 0100 extension 44', '+12125550100'],
    ['2125550100;ext=5', '+12125550100'],
    ['+1 212 555 0100 #123', '+12125550100'],
    ['tel:+1-212-555-0100;ext=5', '+12125550100'],
    ['TEL:+12125550100', '+12125550100'],
  ])('strips extensions and tel: prefix from %j', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164: expected });
  });

  it('handles international numbers and the default country', () => {
    expect(normalizePhone('+44 20 7946 0958')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalizePhone('011 44 20 7946 0958')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalizePhone('020 7946 0958', 'GB')).toEqual({ ok: true, e164: '+442079460958' });
    expect(normalizePhone('+49 1511 2345678')).toEqual({ ok: true, e164: '+4915112345678' });
    // An explicit + always wins over the default country.
    expect(normalizePhone('+1 212 555 0100', 'GB')).toEqual({ ok: true, e164: '+12125550100' });
  });

  it('accepts full-width digits', () => {
    expect(normalizePhone('\uFF0B\uFF11 \uFF12\uFF11\uFF12 \uFF15\uFF15\uFF15 \uFF10\uFF11\uFF10\uFF10')).toEqual({ ok: true, e164: '+12125550100' });
  });

  it.each([null, undefined, '', '   ', '\t\n'])('reports empty for %j', (input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'empty' });
  });

  it.each([
    'abc',
    'N/A',
    '-',
    '+',
    '555-0100',
    '+1 212 555 010',
    '+1 212 555 01000',
    '1-800-FLOWERS',
    '+1 012 555 0100',
    '112 555 0100',
    '+1 212 155 0100',
    '+99912345',
    '212-555-0100 (office)',
    '020 7946 0958',
    '001 212 555 0100',
    '=HYPERLINK("x")',
    '1'.repeat(101),
  ])('reports invalid for %j', (input) => {
    expect(normalizePhone(input)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not throw for an unsupported default country', () => {
    expect(normalizePhone('2125550100', 'ZZ' as string as CountryCode)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('only ever returns values that satisfy the database CHECK constraint', () => {
    const inputs = [
      '(212) 555-0100',
      '+44 20 7946 0958',
      '+49 1511 2345678',
      '+52 55 5555 0100',
      '+1 604 555 0100',
      '+86 138 0013 8000',
      '+61 2 5550 1234',
    ];
    for (const input of inputs) {
      const result = normalizePhone(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.e164).toMatch(DB_PHONE_CHECK);
        expect(isE164(result.e164)).toBe(true);
      }
    }
  });
});

describe('isE164', () => {
  it.each(['+12125550100', '+442079460958', '+1234567', '+123456789012345'])('accepts %j', (value) => {
    expect(isE164(value)).toBe(true);
  });

  it.each([
    '12125550100',
    '+0123456789',
    '+123456',
    '+1234567890123456',
    '+1 212 555 0100',
    ' +12125550100',
    '+12125550100\n',
    '',
    null,
    undefined,
    12125550100,
  ])('rejects %j', (value) => {
    expect(isE164(value)).toBe(false);
  });

  it('exports the same pattern as the database', () => {
    expect(E164_PATTERN.source).toBe('^\\+[1-9]\\d{6,14}$');
  });
});

describe('phoneDigits', () => {
  it('keeps only ASCII digits', () => {
    expect(phoneDigits('(212) 555-0100')).toBe('2125550100');
    expect(phoneDigits('+1 212')).toBe('1212');
    expect(phoneDigits('no digits')).toBe('');
    expect(phoneDigits(null)).toBe('');
    expect(phoneDigits(undefined)).toBe('');
  });
});

describe('maskPhone', () => {
  it.each([
    ['+12125550123', '+1******0123'],
    ['+442079460958', '+44******0958'],
    ['+525555550100', '+52******0100'],
    ['(212) 555-0123', '******0123'],
    ['+99912345', '+****2345'],
    ['123', '***'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('masks %j as %j', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });

  it('never reveals the middle digits', () => {
    const masked = maskPhone('+12125550123');
    expect(masked).not.toContain('212');
    expect(masked).not.toContain('555');
  });
});

describe('formatPhoneDisplay', () => {
  it.each([
    ['+12125550100', '(212) 555-0100'],
    [' +12125550100 ', '(212) 555-0100'],
    ['+16045550100', '(604) 555-0100'],
    ['+442079460958', '+44 20 7946 0958'],
    ['+4915112345678', '+49 1511 2345678'],
    ['not a phone', 'not a phone'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('formats %j as %j', (input, expected) => {
    expect(formatPhoneDisplay(input)).toBe(expected);
  });
});
