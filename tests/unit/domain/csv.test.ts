import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { CSV_CONTENT_TYPE, csvFilename, escapeCsvCell, toCsv } from '../../../src/lib/domain/csv';

const PHONE = { column: 'phone', phoneColumns: ['phone'] };

describe('escapeCsvCell', () => {
  it.each([
    ['Acme', 'Acme'],
    ['', ''],
    ['a=b', 'a=b'],
    ['foo-bar', 'foo-bar'],
    ['user@example.com', 'user@example.com'],
    ['1+1', '1+1'],
    ["O'Brien", "O'Brien"],
  ])('leaves safe text %j alone', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['+1+1', "'+1+1"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
    ['\ncmd', `"'\ncmd"`],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ['=HYPERLINK("http://evil.example","click")', `"'=HYPERLINK(""http://evil.example"",""click"")"`],
    ['=1,2', `"'=1,2"`],
    [' =1+1', "' =1+1"],
    ['\u00A0@foo', "'\u00A0@foo"],
    ['\uFF1D1+1', "'\uFF1D1+1"],
    ['\uFF0B1', "'\uFF0B1"],
    ['\uFF0D1', "'\uFF0D1"],
    ['\uFF20x', "'\uFF20x"],
    ['+12125550100', "'+12125550100"],
  ])('neutralizes formula trigger %j', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it('exempts only validated E.164 values in phone columns', () => {
    expect(escapeCsvCell('+12125550100', PHONE)).toBe('+12125550100');
    expect(escapeCsvCell('+442079460958', PHONE)).toBe('+442079460958');
    expect(escapeCsvCell('+1 212 555 0100', PHONE)).toBe("'+1 212 555 0100");
    expect(escapeCsvCell('+1=cmd', PHONE)).toBe("'+1=cmd");
    expect(escapeCsvCell('+12125550100+1', PHONE)).toBe("'+12125550100+1");
    expect(escapeCsvCell(' +12125550100', PHONE)).toBe("' +12125550100");
    expect(escapeCsvCell('\uFF0B12125550100', PHONE)).toBe("'\uFF0B12125550100");
    expect(escapeCsvCell('=1', PHONE)).toBe("'=1");
    expect(escapeCsvCell('-12125550100', PHONE)).toBe("'-12125550100");
    expect(escapeCsvCell('+12125550100', { column: 'notes', phoneColumns: ['phone'] })).toBe("'+12125550100");
    expect(escapeCsvCell('+12125550100', { column: 'phone' })).toBe("'+12125550100");
    expect(escapeCsvCell('+12125550100', { phoneColumns: ['phone'] })).toBe("'+12125550100");
  });

  it('quotes per RFC 4180', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(escapeCsvCell(' padded ')).toBe(' padded ');
  });

  it('stringifies non-string values', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(42)).toBe('42');
    expect(escapeCsvCell(-5)).toBe("'-5");
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(BigInt(10))).toBe('10');
    expect(escapeCsvCell(new Date('2026-09-15T12:34:56Z'))).toBe('2026-09-15T12:34:56.000Z');
    expect(escapeCsvCell(new Date(Number.NaN))).toBe('');
    expect(escapeCsvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(escapeCsvCell(['x', 'y'])).toBe('"[""x"",""y""]"');
  });
});

describe('toCsv', () => {
  it('uses CRLF line endings, including after the last record', () => {
    expect(toCsv(['a', 'b'], [['1', '2'], ['3', '4']])).toBe('a,b\r\n1,2\r\n3,4\r\n');
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });

  it('pads short rows and keeps extra cells', () => {
    expect(toCsv(['a', 'b'], [['only']])).toBe('a,b\r\nonly,\r\n');
    expect(toCsv(['a'], [['x', 'extra']])).toBe('a\r\nx,extra\r\n');
  });

  it('escapes headers and applies the phone exemption by header name', () => {
    expect(toCsv(['=bad header'], [])).toBe("'=bad header\r\n");
    expect(toCsv(['business', 'phone', 'notes'], [['=x', '+12125550100', '+12125550100']], { phoneColumns: ['phone'] })).toBe(
      "business,phone,notes\r\n'=x,+12125550100,'+12125550100\r\n",
    );
  });

  it('can prepend a UTF-8 BOM', () => {
    expect(toCsv(['name'], [['Café']], { bom: true })).toBe('\uFEFFname\r\nCafé\r\n');
  });

  it('round-trips through a CSV parser', () => {
    const headers = ['business', 'notes', 'multi', 'formula', 'phone', 'empty', 'count'];
    const csv = toCsv(
      headers,
      [
        ['Acme, Inc.', 'Say "hi"', 'line1\nline2', '=1+1', '+12125550100', null, 42],
        ['B', '', 'x\r\ny', '@x', '+1 212', undefined, 0],
      ],
      { phoneColumns: ['phone'] },
    );
    const parsed = Papa.parse<string[]>(csv, { newline: '\r\n', skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toEqual([
      headers,
      ['Acme, Inc.', 'Say "hi"', 'line1\nline2', "'=1+1", '+12125550100', '', '42'],
      ['B', '', 'x\r\ny', "'@x", "'+1 212", '', '0'],
    ]);
  });
});

describe('csvFilename', () => {
  const date = new Date('2026-09-15T12:00:00Z');

  it('builds a dated, filesystem-safe name', () => {
    expect(csvFilename('leads', date)).toBe('leads-2026-09-15.csv');
    expect(csvFilename('My Leads!', date)).toBe('my-leads-2026-09-15.csv');
    expect(csvFilename('../../etc/passwd', date)).toBe('etc-passwd-2026-09-15.csv');
    expect(csvFilename('', date)).toBe('export-2026-09-15.csv');
    expect(csvFilename('import-skipped-rows', date)).toBe('import-skipped-rows-2026-09-15.csv');
  });

  it('uses the UTC date unless a time zone is given', () => {
    const lateEvening = new Date('2026-09-16T02:00:00Z');
    expect(csvFilename('leads', lateEvening)).toBe('leads-2026-09-16.csv');
    expect(csvFilename('leads', lateEvening, 'America/Los_Angeles')).toBe('leads-2026-09-15.csv');
  });

  it('exposes the content type', () => {
    expect(CSV_CONTENT_TYPE).toBe('text/csv; charset=utf-8');
  });
});
