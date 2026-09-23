// CSV import model (SPEC section 9): upload limits, parsing, validation, preview accounting, duplicate
// decisions, even split, batching, and the result summary / skipped-rows CSV.
import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import {
  BATCH_FAILED_REASON,
  EXTRA_CELLS_KEY,
  MAX_IMPORT_FILE_BYTES,
  assigneeForPosition,
  buildImportBatches,
  buildImportPlan,
  buildImportPreview,
  buildSkippedRowsCsv,
  checkImportFile,
  checkImportRow,
  checkImportRows,
  chunkDuplicateKeys,
  decideAllDuplicates,
  describeDuplicate,
  duplicateKeysFor,
  formatPreviewSummary,
  parseImportCsv,
  requiredFieldLabels,
  rowNumber,
  splitPreview,
  summarizeImport,
  toBatchAssignment,
  type BatchRowResult,
  type ExistingDuplicateLead,
  type ImportPreview,
  type ParsedImportFile,
} from '@/components/import/import-model';
import { nameCityKey } from '@/lib/domain/dedupe';
import { guessMapping, missingRequiredImportFields, type ImportMapping } from '@/lib/domain/import-mapping';
import { normalizeWebsiteDomain } from '@/lib/domain/website';
import { CSV_HEADERS, EXPECTED_IMPORT_PREVIEW, SAMPLE_ROW_COUNT, SPECIAL_ROWS } from '../../../scripts/gen-sample-csv';
import { SEED_LEADS, leadE164 } from '../../../scripts/lib/seed-data';

const SAMPLE_TEXT = readFileSync(new URL('../../../samples/leads.csv', import.meta.url), 'utf8');

function parsed(text: string): ParsedImportFile {
  const result = parseImportCsv(text);
  if (!result.ok) throw new Error(result.error);
  return result.file;
}

/** Existing leads exactly as find_duplicate_leads would return them from the seeded database. */
const SEEDED_EXISTING: ExistingDuplicateLead[] = SEED_LEADS.map((lead) => ({
  leadId: lead.ref,
  businessName: lead.businessName,
  city: lead.city,
  phone: leadE164(lead),
  websiteDomain: normalizeWebsiteDomain(lead.website ?? null),
  nameCityKey: nameCityKey(lead.businessName, lead.city),
}));

function samplePreview(): { file: ParsedImportFile; mapping: ImportMapping; preview: ImportPreview } {
  const file = parsed(SAMPLE_TEXT);
  const mapping = guessMapping(file.headers);
  const preview = buildImportPreview(checkImportRows(file, mapping, true), SEEDED_EXISTING);
  return { file, mapping, preview };
}

function simpleCsv(rows: string[][], headers = ['Business', 'Phone', 'City', 'Website', 'Notes']): string {
  return Papa.unparse({ fields: headers, data: rows });
}

const SIMPLE_MAPPING: ImportMapping = { Business: 'business_name', Phone: 'phone', City: 'city', Website: 'website', Notes: 'notes' };

describe('upload checks', () => {
  it('accepts .csv files up to 10 MB and rejects other extensions, empty and larger files', () => {
    expect(checkImportFile({ name: 'leads.csv', size: 1234 })).toBeNull();
    expect(checkImportFile({ name: 'LEADS.CSV', size: MAX_IMPORT_FILE_BYTES })).toBeNull();
    expect(checkImportFile({ name: 'leads.xlsx', size: 10 })).toBe('Choose a .csv file.');
    expect(checkImportFile({ name: 'leads.csv.txt', size: 10 })).toBe('Choose a .csv file.');
    expect(checkImportFile({ name: 'leads.csv', size: 0 })).toBe('This file is empty.');
    expect(checkImportFile({ name: 'leads.csv', size: MAX_IMPORT_FILE_BYTES + 1 })).toMatch(/larger than 10 MB/);
  });

  it('parses with a header row, skips blank lines and keeps every data row', () => {
    const file = parsed('﻿Business,Phone\r\nAcme,(212) 555-0100\r\n\r\n , \r\nBeta,2125550101\r\n');
    expect(file.headers).toEqual(['Business', 'Phone']);
    expect(file.rows).toEqual([
      { Business: 'Acme', Phone: '(212) 555-0100' },
      { Business: 'Beta', Phone: '2125550101' },
    ]);
  });

  it('keeps cells beyond the header count and renames duplicate headers instead of dropping them', () => {
    const file = parsed('Name,Name,Phone\na,b,c,d,e\n');
    expect(file.headers).toEqual(['Name', 'Name_1', 'Phone']);
    expect(file.rows[0]).toEqual({ Name: 'a', Name_1: 'b', Phone: 'c', [EXTRA_CELLS_KEY]: 'd, e' });
  });

  it('rejects files with more than 50,000 rows, no header or no data rows', () => {
    const header = 'Business,Phone\n';
    expect(parseImportCsv(header + 'a,1\n'.repeat(50_000)).ok).toBe(true);
    const tooMany = parseImportCsv(header + 'a,1\n'.repeat(50_001));
    expect(tooMany).toEqual({ ok: false, error: expect.stringContaining('The limit is 50,000') });
    expect(parseImportCsv('')).toEqual({ ok: false, error: expect.stringContaining('no header row') });
    expect(parseImportCsv('Business,Phone\n\n')).toEqual({ ok: false, error: expect.stringContaining('no data rows') });
  });

  it('parses samples/leads.csv into 100 rows with the generator headers', () => {
    const file = parsed(SAMPLE_TEXT);
    expect(file.rows).toHaveLength(SAMPLE_ROW_COUNT);
    expect(file.headers).toEqual([...CSV_HEADERS]);
    expect(file.rows[SPECIAL_ROWS.notesWithCommaQuotesNewline].Notes).toContain('\n');
  });
});

describe('mapping validation', () => {
  it('requires business name and phone before the preview', () => {
    expect(missingRequiredImportFields({ Company: 'business_name', Tel: null })).toEqual(['phone']);
    expect(requiredFieldLabels(missingRequiredImportFields({}))).toEqual(['Business name', 'Phone']);
    const { mapping } = samplePreview();
    expect(missingRequiredImportFields(mapping)).toEqual([]);
    // "Industry" is now a recognized business type column (Task 11).
    expect(mapping).toMatchObject({ Company: 'business_name', 'Phone Number': 'phone', City: 'city', Industry: 'business_type' });
  });
});

describe('row validation', () => {
  it('reports the invalid reasons and appends unmapped columns to notes when enabled', () => {
    const mapping: ImportMapping = { ...SIMPLE_MAPPING, Industry: null };
    expect(checkImportRow({ Business: '', Phone: 'N/A' }, mapping, true)).toEqual({
      ok: false,
      reasons: ['Missing business name', 'Unusable phone'],
    });
    const ok = checkImportRow({ Business: ' Acme ', Phone: '(212) 555-0100', Notes: 'Hi', Industry: 'HVAC' }, mapping, true);
    expect(ok).toMatchObject({ ok: true, lead: { business_name: 'Acme', phone: '+12125550100', notes: 'Hi\nIndustry: HVAC' } });
    const off = checkImportRow({ Business: 'Acme', Phone: '(212) 555-0100', Industry: 'HVAC' }, mapping, false);
    expect(off).toMatchObject({ ok: true, lead: { notes: null } });
  });

  it('flags values longer than the database limits as invalid instead of failing the batch', () => {
    const result = checkImportRow({ Business: 'x'.repeat(201), Phone: '2125550100', Notes: 'n'.repeat(10_001) }, SIMPLE_MAPPING, true);
    expect(result).toEqual({
      ok: false,
      reasons: ['Business name is too long (max 200 characters)', 'Notes is too long (max 10,000 characters)'],
    });
  });
});

describe('preview accounting', () => {
  it('reports the sample file exactly as the generator documents it', () => {
    const { preview } = samplePreview();
    expect(preview.counts).toEqual({
      total: SAMPLE_ROW_COUNT,
      ready: EXPECTED_IMPORT_PREVIEW.ready,
      duplicates: EXPECTED_IMPORT_PREVIEW.possibleDuplicates,
      invalid: EXPECTED_IMPORT_PREVIEW.invalid,
    });
    expect(formatPreviewSummary(preview.counts)).toBe('92 ready · 5 possible duplicates · 3 invalid');

    const byStatus = (status: string) => preview.rows.filter((row) => row.status === status).map((row) => row.rowIndex);
    expect(byStatus('invalid')).toEqual([SPECIAL_ROWS.invalidMissingCompany, SPECIAL_ROWS.invalidPhoneNA, SPECIAL_ROWS.invalidPhoneTooShort]);
    expect(byStatus('duplicate')).toEqual(
      [
        SPECIAL_ROWS.seedDuplicateByPhone,
        SPECIAL_ROWS.seedDuplicateByWebsite,
        SPECIAL_ROWS.seedDuplicateByNameCity,
        SPECIAL_ROWS.inFilePhonePair[1],
        SPECIAL_ROWS.inFileWebsitePair[1],
      ].sort((a, b) => a - b),
    );

    const invalid = preview.rows.filter((row) => row.status === 'invalid');
    expect(invalid.map((row) => (row.status === 'invalid' ? row.reasons : []))).toEqual([
      ['Missing business name'],
      ['Unusable phone'],
      ['Unusable phone'],
    ]);

    const inFile = preview.rows[SPECIAL_ROWS.inFilePhonePair[1]];
    expect(inFile.status === 'duplicate' && inFile.duplicate).toMatchObject({
      reasons: ['phone'],
      existing: [],
      earlierRowIndexes: [SPECIAL_ROWS.inFilePhonePair[0]],
    });
    expect(inFile.status === 'duplicate' && describeDuplicate(inFile.duplicate)).toBe(`Same phone as row ${rowNumber(SPECIAL_ROWS.inFilePhonePair[0])}`);
    const seeded = preview.rows[SPECIAL_ROWS.seedDuplicateByPhone];
    expect(seeded.status === 'duplicate' && seeded.duplicate.existing).toEqual([
      { leadId: 'alex-01', businessName: SEED_LEADS.find((lead) => lead.ref === 'alex-01')?.businessName, city: SEED_LEADS.find((lead) => lead.ref === 'alex-01')?.city },
    ]);
  });

  it('puts every row in exactly one bucket; an invalid row counts only as invalid and is never the earlier row', () => {
    const file = parsed(
      simpleCsv([
        ['', '2125550100', 'Austin', '', ''], // invalid, shares its phone with row 1
        ['Acme', '2125550100', 'Austin', 'acme.test', ''], // ready: the invalid row does not count
        ['Acme LLC', '(212) 555-0100', 'Dallas', '', ''], // duplicate of row 1 by phone
        ['Beta', 'bad', 'Austin', 'www.acme.test', ''], // invalid, although its website matches
        ['ACME', '2125550199', 'austin', '', ''], // duplicate of row 1 by name + city
        ['Gamma', '2125550150', 'Austin', '', ''], // duplicate of an existing lead by phone
      ]),
    );
    const checks = checkImportRows(file, SIMPLE_MAPPING, true);
    const existing: ExistingDuplicateLead[] = [
      { leadId: 'L1', businessName: 'Gamma Old', city: null, phone: '+12125550150', websiteDomain: null, nameCityKey: 'gammaold|' },
    ];
    const preview = buildImportPreview(checks, existing);
    expect(preview.rows.map((row) => row.status)).toEqual(['invalid', 'ready', 'duplicate', 'invalid', 'duplicate', 'duplicate']);
    expect(preview.counts).toEqual({ total: 6, ready: 1, duplicates: 3, invalid: 2 });
    expect(preview.counts.ready + preview.counts.duplicates + preview.counts.invalid).toBe(preview.counts.total);
    const row2 = preview.rows[2];
    expect(row2.status === 'duplicate' && row2.duplicate.earlierRowIndexes).toEqual([1]);
    const row5 = preview.rows[5];
    expect(row5.status === 'duplicate' && describeDuplicate(row5.duplicate)).toBe('Same phone as Gamma Old');
  });

  it('only sends keys of valid rows to the database, in chunks of at most 1000 per list', () => {
    const file = parsed(simpleCsv([['Acme', '2125550100', 'Austin', 'https://www.Acme.test/x', ''], ['', '2125550101', '', '', ''], ['!!!', '2125550102', 'Austin', '', '']]));
    expect(duplicateKeysFor(checkImportRows(file, SIMPLE_MAPPING, true))).toEqual({
      phones: ['+12125550100', '+12125550102'],
      domains: ['acme.test'],
      nameKeys: ['acme|austin'],
    });

    const phones = Array.from({ length: 2500 }, (_, i) => `+1212555${String(i).padStart(4, '0')}`);
    const chunks = chunkDuplicateKeys({ phones, domains: ['a.test'], nameKeys: [] });
    expect(chunks.map((chunk) => [chunk.phones.length, chunk.domains.length, chunk.nameKeys.length])).toEqual([
      [1000, 1, 0],
      [1000, 0, 0],
      [500, 0, 0],
    ]);
    expect(chunks.flatMap((chunk) => chunk.phones)).toEqual(phones);
    expect(chunkDuplicateKeys({ phones: [], domains: [], nameKeys: [] })).toEqual([]);
  });

  it('formats the summary line with a singular duplicate', () => {
    expect(formatPreviewSummary({ total: 1103, ready: 1000, duplicates: 1, invalid: 102 })).toBe('1,000 ready · 1 possible duplicate · 102 invalid');
  });
});

describe('duplicate decisions and plan', () => {
  it('skips duplicates by default and imports them when chosen, per row or in bulk', () => {
    const { preview } = samplePreview();
    const byDefault = buildImportPlan(preview, {});
    expect(byDefault.insert).toHaveLength(92);
    expect(byDefault.skipped).toHaveLength(5);
    expect(byDefault.invalid).toHaveLength(3);

    const oneImported = buildImportPlan(preview, { [SPECIAL_ROWS.seedDuplicateByPhone]: 'import', [SPECIAL_ROWS.invalidPhoneNA]: 'import' });
    expect(oneImported.insert).toContain(SPECIAL_ROWS.seedDuplicateByPhone);
    expect(oneImported.invalid).toContain(SPECIAL_ROWS.invalidPhoneNA);
    expect(oneImported.skipped).toHaveLength(4);

    const all = buildImportPlan(preview, decideAllDuplicates(preview, 'import'));
    expect([all.insert.length, all.skipped.length, all.invalid.length]).toEqual([97, 0, 3]);
    expect(buildImportPlan(preview, decideAllDuplicates(preview, 'skip')).skipped).toHaveLength(5);
  });
});

describe('assignment', () => {
  it('splits evenly with the remainder going first (34/33/33) and assigns contiguous blocks', () => {
    expect(splitPreview(100, 3)).toEqual([34, 33, 33]);
    expect(splitPreview(5, 0)).toEqual([]);
    const assignment = toBatchAssignment({ mode: 'split', agentIds: ['a', 'b', 'c'] }, 100);
    expect(assignment).toEqual({ mode: 'split', agentIds: ['a', 'b', 'c'], total: 100 });
    const owners = Array.from({ length: 100 }, (_, position) => assigneeForPosition(assignment, position));
    expect(owners.filter((id) => id === 'a')).toHaveLength(34);
    expect(owners.filter((id) => id === 'b')).toHaveLength(33);
    expect(owners.filter((id) => id === 'c')).toHaveLength(33);
    expect([owners[33], owners[34], owners[66], owners[67]]).toEqual(['a', 'b', 'b', 'c']);
    expect(() => assigneeForPosition(assignment, 100)).toThrow(RangeError);
    expect(assigneeForPosition({ mode: 'agent', agentId: 'x' }, 7)).toBe('x');
    expect(assigneeForPosition({ mode: 'unassigned' }, 0)).toBeNull();
  });
});

describe('batches', () => {
  it('sends the planned rows in order in batches of 500 with continuous positions', () => {
    const rows = Array.from({ length: 1203 }, (_, i) => ({ Business: `B${i}`, Phone: '2125550100' }));
    const file: ParsedImportFile = { headers: ['Business', 'Phone'], rows };
    const plan = { insert: Array.from({ length: 1200 }, (_, i) => i + 3), skipped: [0, 1], invalid: [2] };
    const batches = buildImportBatches(file, plan);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 200]);
    const flat = batches.flat();
    expect(flat.map((row) => row.position)).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    expect(flat.map((row) => row.rowIndex)).toEqual(plan.insert);
    expect(flat[0].cells).toBe(rows[3]);
  });

  it('starts a new batch before the payload gets too large', () => {
    const rows = Array.from({ length: 10 }, () => ({ Business: 'x'.repeat(1000), Phone: '1' }));
    const batches = buildImportBatches({ headers: ['Business', 'Phone'], rows }, { insert: rows.map((_, i) => i), skipped: [], invalid: [] }, 500, 7000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(10);
    expect(batches.every((batch) => batch.length >= 1)).toBe(true);
  });
});

describe('result summary', () => {
  function sampleResults(failEvery: number, dropBatchAt: number | null): { preview: ImportPreview; plan: ReturnType<typeof buildImportPlan>; results: BatchRowResult[] } {
    const { preview } = samplePreview();
    const plan = buildImportPlan(preview, { [SPECIAL_ROWS.inFileWebsitePair[1]]: 'import' });
    const results: BatchRowResult[] = plan.insert
      .filter((_, i) => dropBatchAt === null || i < dropBatchAt)
      .map((rowIndex, i) => (i % failEvery === failEvery - 1 ? { rowIndex, ok: false, reason: 'The database rejected this row.' } : { rowIndex, ok: true, leadId: `id-${rowIndex}` }));
    return { preview, plan, results };
  }

  it('counts inserted, skipped, invalid and failed so they add up to the file row count', () => {
    const { preview, plan, results } = sampleResults(10, null);
    const summary = summarizeImport(preview, plan, results);
    expect(summary.counts).toEqual({ total: 100, inserted: 84, skipped: 4, invalid: 3, failed: 9 });
    expect(summary.counts.inserted + summary.counts.skipped + summary.counts.invalid + summary.counts.failed).toBe(100);
    expect(summary.rows.map((row) => row.rowIndex)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('counts planned rows without a result (a failed batch) as failed, never as dropped', () => {
    const { preview, plan, results } = sampleResults(1000, 50);
    const summary = summarizeImport(preview, plan, results);
    expect(summary.counts).toEqual({ total: 100, inserted: 50, skipped: 4, invalid: 3, failed: 43 });
    expect(summary.rows.filter((row) => row.bucket === 'failed').every((row) => row.reason === BATCH_FAILED_REASON)).toBe(true);
  });

  it('holds for any mix of decisions and failures', () => {
    const { preview } = samplePreview();
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 25; round += 1) {
      const decisions = Object.fromEntries(preview.rows.filter((row) => row.status === 'duplicate').map((row) => [row.rowIndex, random() < 0.5 ? 'import' : 'skip'] as const));
      const plan = buildImportPlan(preview, decisions);
      const results: BatchRowResult[] = plan.insert
        .filter(() => random() < 0.9)
        .map((rowIndex) => (random() < 0.2 ? { rowIndex, ok: false, reason: 'x' } : { rowIndex, ok: true, leadId: 'id' }));
      const { counts, rows } = summarizeImport(preview, plan, results);
      expect(counts.inserted + counts.skipped + counts.invalid + counts.failed).toBe(100);
      expect(new Set(rows.map((row) => row.rowIndex)).size).toBe(100);
      expect(counts.invalid).toBe(3);
    }
  });

  it('builds a CSV of skipped, invalid and failed rows with the original columns and a reason', () => {
    const { file, preview, plan, results } = { file: parsed(SAMPLE_TEXT), ...sampleResults(10, null) };
    const summary = summarizeImport(preview, plan, results);
    const csv = buildSkippedRowsCsv(file, summary);
    expect(csv.startsWith('﻿')).toBe(true);
    const back = Papa.parse<Record<string, string>>(csv.slice(1), { header: true, skipEmptyLines: 'greedy' });
    expect(back.meta.fields).toEqual([...CSV_HEADERS, 'reason']);
    expect(back.data).toHaveLength(summary.counts.skipped + summary.counts.invalid + summary.counts.failed);
    const missing = back.data.find((row) => row.reason === 'Missing business name');
    expect(missing).toMatchObject({ Company: '', City: file.rows[SPECIAL_ROWS.invalidMissingCompany].City });
    const skipped = back.data.find((row) => row.reason.startsWith('Skipped possible duplicate'));
    expect(skipped?.reason).toMatch(/^Skipped possible duplicate: Same /);
  });

  it('escapes formula cells in the result CSV', () => {
    const file = parsed(simpleCsv([['=HYPERLINK("x")', 'bad', '@city', '', '-2+3']]));
    const preview = buildImportPreview(checkImportRows(file, SIMPLE_MAPPING, true), []);
    const summary = summarizeImport(preview, buildImportPlan(preview, {}), []);
    const [, line] = buildSkippedRowsCsv(file, summary).slice(1).split('\r\n');
    expect(line).toBe(`"'=HYPERLINK(""x"")",bad,'@city,,'-2+3,Unusable phone`);
  });

  it('uses "import reason" when the file already has a reason column', () => {
    const file = parsed('Business,Phone,reason\n,1,old\n');
    const preview = buildImportPreview(checkImportRows(file, { Business: 'business_name', Phone: 'phone', reason: null }, true), []);
    const csv = buildSkippedRowsCsv(file, summarizeImport(preview, buildImportPlan(preview, {}), []));
    expect(csv.slice(1).split('\r\n')[0]).toBe('Business,Phone,reason,import reason');
  });
});
