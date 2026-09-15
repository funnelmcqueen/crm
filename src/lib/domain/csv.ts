import { isE164 } from './phone';
import { formatInTz } from './time';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

export interface CsvCellOptions {
  /** Header of the column this cell belongs to. */
  column?: string;
  /** Columns whose validated E.164 values may keep a leading `+`. */
  phoneColumns?: readonly string[];
}

export interface ToCsvOptions {
  phoneColumns?: readonly string[];
  /** Prepend a UTF-8 BOM so Excel detects the encoding. */
  bom?: boolean;
}

// SPEC section 10 lists = - @ tab CR. LF and the full-width forms (which some spreadsheet locales
// also evaluate) are added for defense in depth.
const FORMULA_TRIGGERS = new Set(['=', '-', '@', '\t', '\r', '\n', '\uFF1D', '\uFF0D', '\uFF20']);
const PLUS_SIGNS = new Set(['+', '\uFF0B']);

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function needsFormulaPrefix(text: string, options: CsvCellOptions): boolean {
  // Importers that trim cells would turn " =cmd" into a formula, so look past leading spaces too.
  for (const candidate of [text, text.replace(/^[ \u00A0]+/, '')]) {
    const first = candidate.charAt(0);
    if (FORMULA_TRIGGERS.has(first)) return true;
    if (PLUS_SIGNS.has(first)) {
      const isPhoneColumn =
        options.column !== undefined && (options.phoneColumns ?? []).includes(options.column);
      if (!(isPhoneColumn && candidate === text && isE164(text))) return true;
    }
  }
  return false;
}

/** Formula-injection-safe, RFC 4180 quoted CSV cell. */
export function escapeCsvCell(value: unknown, options: CsvCellOptions = {}): string {
  let text = cellToString(value);
  if (needsFormulaPrefix(text, options)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** CSV document with CRLF line endings (including after the last record). */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  options: ToCsvOptions = {},
): string {
  const lines = [headers.map((header) => escapeCsvCell(header)).join(',')];
  for (const row of rows) {
    const width = Math.max(headers.length, row.length);
    const cells: string[] = [];
    for (let i = 0; i < width; i += 1) {
      cells.push(escapeCsvCell(row[i], { column: headers[i], phoneColumns: options.phoneColumns }));
    }
    lines.push(cells.join(','));
  }
  return `${options.bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}

/** `csvFilename('leads', date)` -> `leads-2026-09-15.csv` (UTC date unless a time zone is given). */
export function csvFilename(prefix: string, date: Date = new Date(), timeZone?: string): string {
  const slug =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export';
  const day = timeZone ? formatInTz(date, timeZone, 'yyyy-MM-dd') : date.toISOString().slice(0, 10);
  return `${slug}-${day}.csv`;
}
