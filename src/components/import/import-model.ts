// Pure, isomorphic CSV import model (SPEC section 9): file checks, parsing, row validation, preview
// accounting, duplicate decisions, assignment, batching and the result summary. The browser wizard
// and the server batch service both use it, so a row is validated by exactly the same rules on
// both sides (the server never trusts the client's normalized values; it re-runs checkImportRow).
import Papa from "papaparse";
import { toCsv } from "@/lib/domain/csv";
import { findDuplicates, type DedupeCandidate, type DuplicateReason } from "@/lib/domain/dedupe";
import {
  CRM_IMPORT_FIELDS,
  validateImportRow,
  type ImportFieldKey,
  type ImportMapping,
  type NormalizedImportLead,
} from "@/lib/domain/import-mapping";
import { splitCounts } from "@/lib/domain/split";

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const IMPORT_BATCH_SIZE = 500;
/** Keeps a batch well under the 4 MB server action body limit, whatever the row width. */
export const IMPORT_BATCH_MAX_BYTES = 2_000_000;
export const DUPLICATE_KEY_CHUNK_SIZE = 1000;
export const MAX_IMPORT_COLUMNS = 200;
export const MAX_HEADER_LENGTH = 500;
export const MAX_CELL_LENGTH = 100_000;
export const MAX_SPLIT_AGENTS = 100;
/** papaparse puts cells beyond the header count under this key. */
export const EXTRA_CELLS_KEY = "__parsed_extra";

/** Longest value the import accepts per CRM field (the phone limit applies to the raw input). */
export const IMPORT_FIELD_MAX_LENGTH: Readonly<Record<ImportFieldKey, number>> = {
  business_name: 200,
  contact_name: 200,
  phone: 100,
  email: 320,
  website: 2048,
  address: 300,
  city: 200,
  state: 100,
  country: 100,
  source: 200,
  notes: 10_000,
};

/** One parsed CSV row: header -> cell text. Extra cells are joined under EXTRA_CELLS_KEY. */
export type CsvCells = Record<string, string>;

export interface ParsedImportFile {
  headers: string[];
  rows: CsvCells[];
}

// ---------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Checks before reading the file. Null when the file may be parsed. */
export function checkImportFile(file: { name: string; size: number }): string | null {
  if (!/\.csv$/i.test(file.name.trim())) return "Choose a .csv file.";
  if (file.size > MAX_IMPORT_FILE_BYTES) return "This file is larger than 10 MB. Split it into smaller files and import them one at a time.";
  if (file.size === 0) return "This file is empty.";
  return null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => (item === null || item === undefined ? "" : String(item))).join(", ");
  return typeof value === "string" ? value : String(value);
}

export type ParseImportResult = { ok: true; file: ParsedImportFile } | { ok: false; error: string };

/** papaparse with `header: true, skipEmptyLines: 'greedy'`, then the row and column limits. */
export function parseImportCsv(text: string): ParseImportResult {
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: "greedy" });
  const headers = (parsed.meta.fields ?? []).filter((header) => header !== EXTRA_CELLS_KEY);
  if (headers.length === 0 || headers.every((header) => header.trim() === "")) {
    return { ok: false, error: "This file has no header row. The first line must name the columns." };
  }
  if (headers.length > MAX_IMPORT_COLUMNS) {
    return { ok: false, error: `This file has ${formatCount(headers.length)} columns. The limit is ${MAX_IMPORT_COLUMNS}.` };
  }
  if (headers.some((header) => header.length > MAX_HEADER_LENGTH)) {
    return { ok: false, error: `A column name is longer than ${MAX_HEADER_LENGTH} characters.` };
  }
  // papaparse reports malformed input here. A quote error means it stopped seeing row boundaries, so
  // everything after the bad cell was folded into one value and would be dropped without a trace
  // (SPEC section 9: "Never drop data silently"). Ragged rows are a different error type and stay
  // allowed: D29 keeps cells beyond the header count.
  const quoteError = parsed.errors.find((error) => error.type === "Quotes");
  if (quoteError) {
    const where = typeof quoteError.row === "number" ? ` near row ${formatCount(rowNumber(quoteError.row))}` : "";
    return {
      ok: false,
      error: `This file has an unclosed quote${where}, so the rows after it cannot be read. Fix the quoting and upload it again.`,
    };
  }
  if (parsed.data.length === 0) return { ok: false, error: "This file has a header row but no data rows." };
  if (parsed.data.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `This file has ${formatCount(parsed.data.length)} rows. The limit is ${formatCount(MAX_IMPORT_ROWS)}; split it into smaller files.`,
    };
  }

  const rows = parsed.data.map((record) => {
    const cells: CsvCells = {};
    for (const header of headers) cells[header] = cellText(record[header]);
    const extra = record[EXTRA_CELLS_KEY];
    if (extra !== undefined) cells[EXTRA_CELLS_KEY] = cellText(extra);
    return cells;
  });
  return { ok: true, file: { headers, rows } };
}

// ---------------------------------------------------------------------------------------------
// Row validation (shared with the server)
// ---------------------------------------------------------------------------------------------

export type ImportRowCheck = { ok: true; lead: NormalizedImportLead } | { ok: false; reasons: string[] };

const FIELD_LABELS = Object.fromEntries(CRM_IMPORT_FIELDS.map((field) => [field.key, field.label])) as Record<ImportFieldKey, string>;

/** validateImportRow plus the length limits the database and the server enforce. */
export function checkImportRow(cells: Readonly<CsvCells>, mapping: Readonly<ImportMapping>, appendUnmappedToNotes: boolean): ImportRowCheck {
  const result = validateImportRow(cells, mapping, { appendUnmappedToNotes });
  const reasons: string[] = result.ok ? [] : [...result.reasons];
  if (Object.values(cells).some((value) => value.length > MAX_CELL_LENGTH)) {
    reasons.push(`A cell is longer than ${formatCount(MAX_CELL_LENGTH)} characters`);
  }
  if (result.ok) {
    for (const [field, max] of Object.entries(IMPORT_FIELD_MAX_LENGTH) as Array<[ImportFieldKey, number]>) {
      const value = field === "phone" ? result.lead.phone_raw : result.lead[field];
      if (value !== null && value.length > max) reasons.push(`${FIELD_LABELS[field]} is too long (max ${formatCount(max)} characters)`);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return result.ok ? result : { ok: false, reasons };
}

/** Business name and phone must be mapped before the preview. */
export function requiredFieldLabels(fields: readonly ImportFieldKey[]): string[] {
  return fields.map((field) => FIELD_LABELS[field]);
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

/** The spreadsheet row number of a data row (the header is row 1). */
export function rowNumber(rowIndex: number): number {
  return rowIndex + 2;
}

export interface DuplicateKeySet {
  phones: string[];
  domains: string[];
  nameKeys: string[];
}

export interface ExistingDuplicateLead {
  leadId: string;
  businessName: string;
  city: string | null;
  phone: string | null;
  websiteDomain: string | null;
  nameCityKey: string | null;
}

export interface DuplicateInfo {
  reasons: DuplicateReason[];
  existing: Array<{ leadId: string; businessName: string; city: string | null }>;
  /** Earlier data rows (0-based indexes) of this file with the same key. */
  earlierRowIndexes: number[];
}

export type PreviewRow =
  | { rowIndex: number; status: "invalid"; reasons: string[] }
  | { rowIndex: number; status: "ready"; lead: NormalizedImportLead }
  | { rowIndex: number; status: "duplicate"; lead: NormalizedImportLead; duplicate: DuplicateInfo };

export interface PreviewCounts {
  total: number;
  ready: number;
  duplicates: number;
  invalid: number;
}

export interface ImportPreview {
  rows: PreviewRow[];
  counts: PreviewCounts;
}

export function checkImportRows(file: ParsedImportFile, mapping: Readonly<ImportMapping>, appendUnmappedToNotes: boolean): ImportRowCheck[] {
  return file.rows.map((cells) => checkImportRow(cells, mapping, appendUnmappedToNotes));
}

/** Unique non-empty lookup keys of the valid rows, for find_duplicate_leads. */
export function duplicateKeysFor(checks: readonly ImportRowCheck[]): DuplicateKeySet {
  const phones = new Set<string>();
  const domains = new Set<string>();
  const nameKeys = new Set<string>();
  for (const check of checks) {
    if (!check.ok) continue;
    phones.add(check.lead.phone);
    if (check.lead.website_domain) domains.add(check.lead.website_domain);
    const key = check.lead.dedupe_name_key;
    if (key && !key.startsWith("|")) nameKeys.add(key);
  }
  return { phones: [...phones], domains: [...domains], nameKeys: [...nameKeys] };
}

/** Splits every key list into chunks of at most `size`; chunk i carries the i-th slice of each list. */
export function chunkDuplicateKeys(keys: DuplicateKeySet, size: number = DUPLICATE_KEY_CHUNK_SIZE): DuplicateKeySet[] {
  const count = Math.max(Math.ceil(keys.phones.length / size), Math.ceil(keys.domains.length / size), Math.ceil(keys.nameKeys.length / size));
  return Array.from({ length: count }, (_, i) => ({
    phones: keys.phones.slice(i * size, (i + 1) * size),
    domains: keys.domains.slice(i * size, (i + 1) * size),
    nameKeys: keys.nameKeys.slice(i * size, (i + 1) * size),
  }));
}

/**
 * Every row lands in exactly one bucket: invalid (whatever else), else duplicate (matches an existing
 * lead or an earlier valid row of the file), else ready. Invalid rows never count as the "earlier row".
 */
export function buildImportPreview(checks: readonly ImportRowCheck[], existing: readonly ExistingDuplicateLead[]): ImportPreview {
  const byId = new Map<string, ExistingDuplicateLead>();
  for (const lead of existing) byId.set(lead.leadId, lead);

  const candidates: DedupeCandidate[] = [];
  checks.forEach((check, rowIndex) => {
    if (check.ok) {
      candidates.push({
        rowIndex,
        phoneE164: check.lead.phone,
        websiteDomain: check.lead.website_domain,
        nameCityKey: check.lead.dedupe_name_key,
      });
    }
  });
  const matches = new Map(
    findDuplicates(
      candidates,
      [...byId.values()].map((lead) => ({ leadId: lead.leadId, phone: lead.phone, websiteDomain: lead.websiteDomain, nameCityKey: lead.nameCityKey })),
    ).map((match) => [match.rowIndex, match]),
  );

  const counts: PreviewCounts = { total: checks.length, ready: 0, duplicates: 0, invalid: 0 };
  const rows = checks.map((check, rowIndex): PreviewRow => {
    if (!check.ok) {
      counts.invalid += 1;
      return { rowIndex, status: "invalid", reasons: check.reasons };
    }
    const match = matches.get(rowIndex);
    if (!match) {
      counts.ready += 1;
      return { rowIndex, status: "ready", lead: check.lead };
    }
    counts.duplicates += 1;
    return {
      rowIndex,
      status: "duplicate",
      lead: check.lead,
      duplicate: {
        reasons: match.reasons,
        existing: match.existingLeadIds.map((leadId) => {
          const lead = byId.get(leadId);
          return { leadId, businessName: lead?.businessName ?? "Existing lead", city: lead?.city ?? null };
        }),
        earlierRowIndexes: match.duplicateOfRowIndexes,
      },
    };
  });
  return { rows, counts };
}

/** "100 ready · 3 possible duplicates · 2 invalid" */
export function formatPreviewSummary(counts: PreviewCounts): string {
  return `${formatCount(counts.ready)} ready · ${formatCount(counts.duplicates)} possible ${counts.duplicates === 1 ? "duplicate" : "duplicates"} · ${formatCount(counts.invalid)} invalid`;
}

const REASON_LABELS: Readonly<Record<DuplicateReason, string>> = {
  phone: "phone",
  domain: "website",
  name_city: "business name and city",
};

/** "Same phone as Acme Plumbing (Austin); same website as row 12" style description. */
export function describeDuplicate(info: DuplicateInfo): string {
  const what = info.reasons.map((reason) => REASON_LABELS[reason]).join(", ");
  const targets = [
    ...info.existing.map((lead) => (lead.city ? `${lead.businessName} (${lead.city})` : lead.businessName)),
    ...info.earlierRowIndexes.map((index) => `row ${rowNumber(index)}`),
  ];
  return `Same ${what} as ${targets.join(", ")}`;
}

// ---------------------------------------------------------------------------------------------
// Decisions, assignment, batches
// ---------------------------------------------------------------------------------------------

export type DuplicateDecision = "skip" | "import";
export type DuplicateDecisions = Readonly<Record<number, DuplicateDecision>>;

export interface ImportPlan {
  /** Rows to send to the server, ascending. */
  insert: number[];
  /** Duplicates the admin chose to skip (the default). */
  skipped: number[];
  invalid: number[];
}

export function buildImportPlan(preview: ImportPreview, decisions: DuplicateDecisions): ImportPlan {
  const plan: ImportPlan = { insert: [], skipped: [], invalid: [] };
  for (const row of preview.rows) {
    if (row.status === "invalid") plan.invalid.push(row.rowIndex);
    else if (row.status === "ready" || decisions[row.rowIndex] === "import") plan.insert.push(row.rowIndex);
    else plan.skipped.push(row.rowIndex);
  }
  return plan;
}

/** Sets every duplicate row to the same decision. */
export function decideAllDuplicates(preview: ImportPreview, decision: DuplicateDecision): Record<number, DuplicateDecision> {
  const decisions: Record<number, DuplicateDecision> = {};
  for (const row of preview.rows) if (row.status === "duplicate") decisions[row.rowIndex] = decision;
  return decisions;
}

export type ImportAssignment = { mode: "unassigned" } | { mode: "agent"; agentId: string } | { mode: "split"; agentIds: string[] };

/** What the server receives: a split also carries the total, so each row's block is fixed server-side. */
export type BatchAssignment =
  | { mode: "unassigned" }
  | { mode: "agent"; agentId: string }
  | { mode: "split"; agentIds: string[]; total: number };

export function toBatchAssignment(assignment: ImportAssignment, total: number): BatchAssignment {
  return assignment.mode === "split" ? { mode: "split", agentIds: [...assignment.agentIds], total } : assignment;
}

/** Leads per agent for an even split, e.g. 100 rows over 3 agents -> [34, 33, 33]. */
export function splitPreview(total: number, agentCount: number): number[] {
  return agentCount > 0 ? splitCounts(total, agentCount) : [];
}

/** The owner of the row at `position` (0-based among the rows being inserted). */
export function assigneeForPosition(assignment: BatchAssignment, position: number): string | null {
  if (assignment.mode === "unassigned") return null;
  if (assignment.mode === "agent") return assignment.agentId;
  const counts = splitCounts(assignment.total, assignment.agentIds.length);
  let end = 0;
  for (let i = 0; i < counts.length; i += 1) {
    end += counts[i];
    if (position < end) return assignment.agentIds[i];
  }
  throw new RangeError("position is outside the split");
}

export interface ImportBatchRow {
  rowIndex: number;
  /** 0-based position among all rows being inserted (drives the even split). */
  position: number;
  cells: CsvCells;
}

export interface ImportBatch {
  mapping: ImportMapping;
  appendUnmappedToNotes: boolean;
  rows: ImportBatchRow[];
}

function approxBytes(cells: CsvCells): number {
  let bytes = 32;
  for (const [key, value] of Object.entries(cells)) bytes += (key.length + value.length) * 3 + 8;
  return bytes;
}

/** Plan rows in order, in batches of at most `maxRows` rows and about `maxBytes` of payload. */
export function buildImportBatches(
  file: ParsedImportFile,
  plan: ImportPlan,
  maxRows: number = IMPORT_BATCH_SIZE,
  maxBytes: number = IMPORT_BATCH_MAX_BYTES,
): ImportBatchRow[][] {
  const batches: ImportBatchRow[][] = [];
  let current: ImportBatchRow[] = [];
  let bytes = 0;
  plan.insert.forEach((rowIndex, position) => {
    const cells = file.rows[rowIndex];
    const size = approxBytes(cells);
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push({ rowIndex, position, cells });
    bytes += size;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export type BatchRowResult = { rowIndex: number; ok: true; leadId: string } | { rowIndex: number; ok: false; reason: string };

export const BATCH_FAILED_REASON = "Not saved: this batch could not be imported. Try these rows again.";

export interface ImportRowOutcome {
  rowIndex: number;
  bucket: "inserted" | "skipped" | "invalid" | "failed";
  reason: string | null;
}

export interface ImportResultSummary {
  counts: { total: number; inserted: number; skipped: number; invalid: number; failed: number };
  /** One entry per input row, ascending. */
  rows: ImportRowOutcome[];
}

/**
 * Puts every input row in exactly one of inserted / skipped / invalid / failed. A planned row without a
 * result counts as failed. Throws if the buckets do not add up to the file's row count.
 */
export function summarizeImport(preview: ImportPreview, plan: ImportPlan, results: readonly BatchRowResult[]): ImportResultSummary {
  const total = preview.rows.length;
  const byRow = new Map<number, BatchRowResult>();
  for (const result of results) byRow.set(result.rowIndex, result);
  const planned = new Set(plan.insert);
  const skipped = new Set(plan.skipped);

  const rows: ImportRowOutcome[] = preview.rows.map((row) => {
    if (row.status === "invalid") return { rowIndex: row.rowIndex, bucket: "invalid", reason: row.reasons.join("; ") };
    if (skipped.has(row.rowIndex)) {
      return {
        rowIndex: row.rowIndex,
        bucket: "skipped",
        reason: row.status === "duplicate" ? `Skipped possible duplicate: ${describeDuplicate(row.duplicate)}` : "Skipped",
      };
    }
    if (!planned.has(row.rowIndex)) return { rowIndex: row.rowIndex, bucket: "failed", reason: BATCH_FAILED_REASON };
    const result = byRow.get(row.rowIndex);
    if (result?.ok) return { rowIndex: row.rowIndex, bucket: "inserted", reason: null };
    return { rowIndex: row.rowIndex, bucket: "failed", reason: result ? result.reason : BATCH_FAILED_REASON };
  });

  const counts = { total, inserted: 0, skipped: 0, invalid: 0, failed: 0 };
  for (const row of rows) counts[row.bucket] += 1;
  if (counts.inserted + counts.skipped + counts.invalid + counts.failed !== total || rows.length !== total) {
    throw new Error("Import accounting error: the result buckets do not add up to the file row count.");
  }
  return { counts, rows };
}

/**
 * Result CSV of skipped, invalid and failed rows: the original columns plus a reason column.
 *
 * `mapping` names the phone column(s), so a validated E.164 value keeps its leading `+` instead of
 * being apostrophe-prefixed by the SPEC-10 formula rule. The wizard tells the admin to fix these rows
 * and import the file again, and a prefixed phone comes back as "Unusable phone".
 */
export function buildSkippedRowsCsv(
  file: ParsedImportFile,
  summary: ImportResultSummary,
  mapping?: Readonly<ImportMapping>,
): string {
  const phoneColumns = Object.entries(mapping ?? {})
    .filter(([, field]) => field === "phone")
    .map(([header]) => header);
  const hasExtra = file.rows.some((cells) => cells[EXTRA_CELLS_KEY] !== undefined && cells[EXTRA_CELLS_KEY] !== "");
  const reasonHeader = file.headers.includes("reason") ? "import reason" : "reason";
  const headers = [...file.headers, ...(hasExtra ? ["extra columns"] : []), reasonHeader];
  const rows = summary.rows
    .filter((row) => row.bucket !== "inserted")
    .map((row) => {
      const cells = file.rows[row.rowIndex];
      return [...file.headers.map((header) => cells[header] ?? ""), ...(hasExtra ? [cells[EXTRA_CELLS_KEY] ?? ""] : []), row.reason ?? ""];
    });
  return toCsv(headers, rows, { bom: true, phoneColumns });
}
