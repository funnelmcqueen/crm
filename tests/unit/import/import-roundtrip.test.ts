// Review round 2, SPEC section 9 "Never drop data silently".
//
// Two regressions the existing import tests could not see:
//   1. The wizard tells the admin to download the skipped-and-failed rows, fix them and import that
//      file again. That round trip has to work: a phone that imported the first time must import the
//      second time too.
//   2. papaparse reports malformed input in `parsed.errors`. Ignoring it lets one unescaped quote
//      swallow the rest of the file before any accounting runs, so the buckets "add up" over a row
//      count that is already wrong.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildImportPlan,
  buildImportPreview,
  buildSkippedRowsCsv,
  checkImportRow,
  checkImportRows,
  parseImportCsv,
  summarizeImport,
  type ParsedImportFile,
} from '@/components/import/import-model';
import type { ImportMapping } from '@/lib/domain/import-mapping';

const MAPPING: ImportMapping = { Company: 'business_name', Phone: 'phone', City: 'city' };
/** The same columns plus the reason column the result CSV appends. */
const REIMPORT_MAPPING: ImportMapping = { ...MAPPING, reason: null };

function parse(text: string): ParsedImportFile {
  const result = parseImportCsv(text);
  if (!result.ok) throw new Error(`fixture did not parse: ${result.error}`);
  return result.file;
}

/** Runs a file through the wizard with no server results, so every row lands in the result CSV. */
function resultCsv(file: ParsedImportFile, mapping: ImportMapping): string {
  const preview = buildImportPreview(checkImportRows(file, mapping, false), []);
  const plan = buildImportPlan(preview, {});
  return buildSkippedRowsCsv(file, summarizeImport(preview, plan, []), mapping);
}

describe('the skipped-and-failed CSV can be imported again', () => {
  // 25 of the 100 rows in samples/leads.csv carry a "+"-prefixed phone, so this is the common case.
  const PHONES = ['+18725550102', '+1 872 555 0102', '(872) 555-0103', '+44 20 7946 0958'];

  it('keeps every phone importable after a download -> re-upload round trip', () => {
    const rows = PHONES.map((phone, i) => `Acme ${i},${phone},Austin`).join('\n');
    const file = parse(`Company,Phone,City\n${rows}\n`);
    const first = file.rows.map((cells) => checkImportRow(cells, MAPPING, false));
    // Every fixture phone is usable on the first pass; otherwise this test proves nothing.
    expect(first.every((check) => check.ok)).toBe(true);

    const reparsed = parse(resultCsv(file, MAPPING).slice(1));
    expect(reparsed.rows).toHaveLength(file.rows.length);

    const second = reparsed.rows.map((cells) => checkImportRow(cells, REIMPORT_MAPPING, false));
    const failures = second.flatMap((check, i) => (check.ok ? [] : [`row ${i}: ${check.reasons.join(', ')}`]));
    expect(failures).toEqual([]);

    // The re-imported lead must be the same lead, not merely importable.
    second.forEach((check, i) => {
      const before = first[i];
      if (!check.ok || !before.ok) throw new Error('checked above');
      expect(check.lead.phone, `row ${i} phone`).toBe(before.lead.phone);
      expect(check.lead.business_name, `row ${i} business name`).toBe(before.lead.business_name);
    });
  });

  it('still neutralizes formula cells in columns that are not the mapped phone', () => {
    const file = parse('Company,Phone,City\n=HYPERLINK("x"),+18725550102,@Austin\n');
    const line = resultCsv(file, MAPPING).slice(1).split('\r\n')[1];
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain(`'@Austin`);
    // The phone column is the one exception: a validated E.164 value keeps its leading +.
    expect(line).toContain(',+18725550102,');
  });
});

describe('malformed CSV is refused instead of silently truncated', () => {
  it('refuses a file whose unescaped quote swallows the remaining rows', () => {
    const broken = 'Company,Phone\nAcme,"+15551230100\nBeta,+15551230101\nGamma,+15551230102\n';
    const result = parseImportCsv(broken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the malformed file to be refused');
    expect(result.error).toMatch(/quote/i);
  });

  it('still accepts quoted newlines, quoted commas and rows with extra columns', () => {
    const sample = readFileSync(new URL('../../../samples/leads.csv', import.meta.url), 'utf8');
    const parsed = parseImportCsv(sample);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    // 100 data rows across 103 physical lines: two rows carry quoted embedded newlines.
    expect(parsed.file.rows).toHaveLength(100);

    const quoted = parseImportCsv('Company,Phone\n"Acme, Inc.",+15551230100\n"Multi\nline",+15551230101\n');
    expect(quoted.ok).toBe(true);

    // D29 keeps cells beyond the header count, so a ragged row must not be refused.
    const extra = parseImportCsv('Company,Phone\nAcme,+15551230100,leftover\n');
    expect(extra.ok).toBe(true);
  });
});
