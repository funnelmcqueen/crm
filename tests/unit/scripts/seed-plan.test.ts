// SPEC 14: the declarative seed plan and samples/leads.csv (100 rows with duplicates and invalid rows).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { CSV_HEADERS, SAMPLE_ROW_COUNT } from '../../../scripts/gen-sample-csv';
import { SEED_LEADS, SEED_PHONE_NUMBERS, SEED_USERS, validateSeedPlan } from '../../../scripts/lib/seed-data';

const CSV_PATH = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'samples', 'leads.csv');

describe('seed plan', () => {
  it('is internally consistent', () => {
    expect(validateSeedPlan()).toEqual([]);
  });

  it('plans 1 admin, 3 active agents, 1 disabled agent, 40 assigned + 5 unassigned leads and 3 numbers (2 assigned, 1 pool)', () => {
    expect(SEED_USERS.filter((u) => u.role === 'ADMIN' && !u.disabled)).toHaveLength(1);
    expect(SEED_USERS.filter((u) => u.role === 'AGENT' && !u.disabled)).toHaveLength(3);
    expect(SEED_USERS.filter((u) => u.role === 'AGENT' && u.disabled)).toHaveLength(1);
    expect(SEED_LEADS.filter((l) => l.owner !== null)).toHaveLength(40);
    expect(SEED_LEADS.filter((l) => l.owner === null)).toHaveLength(5);
    expect(SEED_PHONE_NUMBERS).toHaveLength(3);
    expect(SEED_PHONE_NUMBERS.filter((n) => n.assignedTo === null)).toHaveLength(1);
  });
});

describe('samples/leads.csv', () => {
  const parsed = Papa.parse<Record<string, string>>(fs.readFileSync(CSV_PATH, 'utf8'), { header: true, skipEmptyLines: true });

  it('has the documented header and exactly 100 data rows', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.meta.fields).toEqual([...CSV_HEADERS]);
    expect(parsed.data).toHaveLength(SAMPLE_ROW_COUNT);
    expect(SAMPLE_ROW_COUNT).toBe(100);
  });

  it('contains duplicate phones and invalid rows (missing business name, unusable phone)', () => {
    const digits = parsed.data.map((row) => (row['Phone Number'] ?? '').replace(/\D/g, '').slice(-10));
    const seen = new Set<string>();
    const duplicates = digits.filter((d) => d.length === 10 && (seen.has(d) || !seen.add(d)));
    expect(duplicates.length).toBeGreaterThan(0);
    expect(parsed.data.some((row) => (row.Company ?? '').trim() === '')).toBe(true);
    expect(parsed.data.filter((row) => (row['Phone Number'] ?? '').replace(/\D/g, '').length < 10).length).toBeGreaterThanOrEqual(2);
  });

  it('uses only fictional 555-01xx phone numbers where a phone is usable', () => {
    const usable = parsed.data.map((row) => (row['Phone Number'] ?? '').replace(/\D/g, '')).filter((d) => d.length >= 10);
    expect(usable.filter((d) => !/55501\d{2}$/.test(d))).toEqual([]);
  });
});
