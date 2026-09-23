import { isSupportedCountry, type CountryCode } from 'libphonenumber-js';
import { businessTypeFromImportValue, type BusinessType } from './business-type';
import { nameCityKey } from './dedupe';
import { normalizePhone } from './phone';
import { normalizeWebsiteDomain } from './website';

export const IMPORT_FIELD_KEYS = [
  'business_name',
  'contact_name',
  'phone',
  'email',
  'website',
  'address',
  'city',
  'state',
  'country',
  'source',
  'business_type',
  'notes',
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

export interface ImportFieldDef {
  readonly key: ImportFieldKey;
  readonly label: string;
  readonly required: boolean;
  readonly synonyms: readonly string[];
}

export const CRM_IMPORT_FIELDS: readonly ImportFieldDef[] = [
  {
    key: 'business_name',
    label: 'Business name',
    required: true,
    synonyms: [
      'Business',
      'Company',
      'Company Name',
      'Account',
      'Account Name',
      'Organization',
      'Organisation',
      'Organization Name',
      'Org',
      'Firm',
      'Store',
      'Store Name',
      'Shop',
      'Practice',
      'Brand',
      'Legal Name',
      'DBA',
      'Merchant',
    ],
  },
  {
    key: 'contact_name',
    label: 'Contact name',
    required: false,
    synonyms: [
      'Contact',
      'Contact Person',
      'Name',
      'Full Name',
      'First Name',
      'Owner',
      'Owner Name',
      'Person',
      'Primary Contact',
      'Decision Maker',
      'Manager',
    ],
  },
  {
    key: 'phone',
    label: 'Phone',
    required: true,
    synonyms: [
      'Phone Number',
      'Phone No',
      'Tel',
      'Telephone',
      'Telephone Number',
      'Mobile',
      'Mobile Phone',
      'Mobile Number',
      'Cell',
      'Cell Phone',
      'Business Phone',
      'Work Phone',
      'Main Phone',
      'Office Phone',
      'Contact Number',
      'Ph',
      'Number',
    ],
  },
  {
    key: 'email',
    label: 'Email',
    required: false,
    synonyms: [
      'E-mail',
      'Email Address',
      'E-mail Address',
      'Mail',
      'Email ID',
      'Contact Email',
      'Work Email',
      'Business Email',
    ],
  },
  {
    key: 'website',
    label: 'Website',
    required: false,
    synonyms: [
      'Website URL',
      'Web Site',
      'URL',
      'Site',
      'Site URL',
      'Domain',
      'Web',
      'Homepage',
      'Home Page',
      'Web Address',
      'Company Website',
    ],
  },
  {
    key: 'address',
    label: 'Address',
    required: false,
    synonyms: [
      'Street',
      'Street Address',
      'Address Line',
      'Address Line 1',
      'Address 1',
      'Mailing Address',
      'Physical Address',
      'Full Address',
    ],
  },
  {
    key: 'city',
    label: 'City',
    required: false,
    synonyms: ['Town', 'Locality', 'City Name', 'Municipality', 'Suburb'],
  },
  {
    key: 'state',
    label: 'State',
    required: false,
    synonyms: ['Province', 'Region', 'State/Province', 'State Code', 'St'],
  },
  {
    key: 'country',
    label: 'Country',
    required: false,
    synonyms: ['Country Name', 'Nation'],
  },
  {
    key: 'source',
    label: 'Source',
    required: false,
    synonyms: ['Lead Source', 'Origin', 'Channel', 'List', 'List Name', 'Campaign'],
  },
  {
    key: 'business_type',
    label: 'Business type',
    required: false,
    synonyms: ['Business Type', 'Category', 'Business Category', 'Industry', 'Type', 'Vertical', 'Niche'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    synonyms: ['Note', 'Comments', 'Comment', 'Description', 'Remarks', 'Details', 'Memo'],
  },
];

export type ImportMapping = Record<string, ImportFieldKey | null>;

export const IMPORT_ROW_REASONS = {
  missingBusinessName: 'Missing business name',
  missingPhone: 'Missing phone',
  unusablePhone: 'Unusable phone',
} as const;

export type ImportRowReason = (typeof IMPORT_ROW_REASONS)[keyof typeof IMPORT_ROW_REASONS];

/** Insert-ready lead values. `dedupe_name_key` is for duplicate checks only (the DB column is generated). */
export interface NormalizedImportLead {
  business_name: string;
  contact_name: string | null;
  phone: string;
  phone_raw: string;
  email: string | null;
  website: string | null;
  website_domain: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  business_type: BusinessType | null;
  notes: string | null;
  dedupe_name_key: string | null;
}

export interface ValidateImportRowOptions {
  appendUnmappedToNotes: boolean;
  /** Region for national-format phones when the row's country column does not name one. Default US. */
  defaultCountry?: CountryCode;
}

export type ValidateImportRowResult =
  | { ok: true; lead: NormalizedImportLead }
  | { ok: false; reasons: ImportRowReason[] };

export function isImportFieldKey(value: unknown): value is ImportFieldKey {
  return typeof value === 'string' && (IMPORT_FIELD_KEYS as readonly string[]).includes(value);
}

/** Lowercase words separated by single spaces: `"E-mail_Address"` -> `"e mail address"`, `"businessName"` -> `"business name"`. */
export function normalizeHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Generic words that only count when they are the whole header ("Name" yes, "Last Name" no).
const EXACT_ONLY_TERMS = new Set([
  'name',
  'number',
  'account',
  'owner',
  'person',
  'manager',
  'org',
  'firm',
  'store',
  'shop',
  'practice',
  'brand',
  'mail',
  'site',
  'web',
  'domain',
  'st',
  'ph',
  'tel',
  'cell',
  'region',
  'origin',
  'channel',
  'list',
  'campaign',
  'details',
  'memo',
  'nation',
]);

interface FieldTerm {
  tokens: string[];
  squashed: string;
  primary: boolean;
  exactOnly: boolean;
}

function toTerm(text: string, primary: boolean): FieldTerm {
  const tokens = normalizeHeader(text).split(' ').filter(Boolean);
  const squashed = tokens.join('');
  return { tokens, squashed, primary, exactOnly: !primary && EXACT_ONLY_TERMS.has(squashed) };
}

const FIELD_TERMS: ReadonlyArray<{ key: ImportFieldKey; terms: FieldTerm[] }> = CRM_IMPORT_FIELDS.map((field) => ({
  key: field.key,
  terms: [
    toTerm(field.key.replace(/_/g, ' '), true),
    toTerm(field.label, true),
    ...field.synonyms.map((synonym) => toTerm(synonym, false)),
  ],
}));

const SCORE_PRIMARY_EXACT = 3000;
const SCORE_EXACT = 2000;
const SCORE_SUFFIX = 1000;
const SCORE_CONTAINS = 500;
const SCORE_SQUASHED_SUFFIX = 100;
const TRAILING_NUMBER_PENALTY = 100;

function indexOfSequence(haystack: readonly string[], needle: readonly string[], from = 0): number {
  for (let i = from; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((token, j) => haystack[i + j] === token)) return i;
  }
  return -1;
}

function scoreTokens(tokens: readonly string[], terms: readonly FieldTerm[]): number {
  const squashed = tokens.join('');
  let best = 0;
  for (const term of terms) {
    if (term.squashed === '') continue;
    if (squashed === term.squashed) {
      best = Math.max(best, (term.primary ? SCORE_PRIMARY_EXACT : SCORE_EXACT) + term.squashed.length);
      continue;
    }
    if (term.exactOnly) continue;
    if (tokens.length === 1) {
      if (term.squashed.length >= 4 && squashed.endsWith(term.squashed)) {
        best = Math.max(best, SCORE_SQUASHED_SUFFIX + term.squashed.length);
      }
      continue;
    }
    if (term.tokens.length >= tokens.length) continue;
    if (indexOfSequence(tokens, term.tokens, tokens.length - term.tokens.length) !== -1) {
      best = Math.max(best, SCORE_SUFFIX + term.squashed.length);
    } else if (indexOfSequence(tokens, term.tokens) !== -1) {
      best = Math.max(best, SCORE_CONTAINS + term.squashed.length);
    }
  }
  return best;
}

/** The field(s) a header matches best; a header never competes for its weaker matches. */
function bestFieldsForHeader(header: string): Array<{ field: ImportFieldKey; fieldIndex: number; score: number }> {
  const tokens = normalizeHeader(header).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  let end = tokens.length;
  while (end > 0 && /^\d+$/.test(tokens[end - 1])) end -= 1;
  const withoutTrailingNumbers = tokens.slice(0, end);

  const scored = FIELD_TERMS.map(({ key, terms }, fieldIndex) => {
    let score = scoreTokens(tokens, terms);
    if (withoutTrailingNumbers.length > 0 && withoutTrailingNumbers.length < tokens.length) {
      score = Math.max(score, scoreTokens(withoutTrailingNumbers, terms) - TRAILING_NUMBER_PENALTY);
    }
    return { field: key, fieldIndex, score };
  }).filter((entry) => entry.score > 0);

  const top = Math.max(0, ...scored.map((entry) => entry.score));
  return scored.filter((entry) => entry.score === top);
}

/**
 * Auto-guesses CSV header -> CRM field. Every header appears in the result (null when unmapped),
 * each field is used at most once, and the strongest match wins.
 */
export function guessMapping(headers: readonly string[]): ImportMapping {
  const entries = new Map<string, ImportFieldKey | null>();
  const candidates: Array<{ header: string; headerIndex: number; field: ImportFieldKey; fieldIndex: number; score: number }> =
    [];

  headers.forEach((header, headerIndex) => {
    if (entries.has(header)) return;
    entries.set(header, null);
    for (const match of bestFieldsForHeader(header)) candidates.push({ header, headerIndex, ...match });
  });

  candidates.sort((a, b) => b.score - a.score || a.headerIndex - b.headerIndex || a.fieldIndex - b.fieldIndex);
  const usedFields = new Set<ImportFieldKey>();
  for (const candidate of candidates) {
    if (usedFields.has(candidate.field) || entries.get(candidate.header) !== null) continue;
    entries.set(candidate.header, candidate.field);
    usedFields.add(candidate.field);
  }
  // Object.fromEntries defines own properties, so headers like "__proto__" stay plain keys.
  return Object.fromEntries(entries);
}

export function missingRequiredImportFields(mapping: Readonly<ImportMapping>): ImportFieldKey[] {
  const mapped = new Set(Object.values(mapping));
  return CRM_IMPORT_FIELDS.filter((field) => field.required && !mapped.has(field.key)).map((field) => field.key);
}

const COUNTRY_NAMES = new Map<string, CountryCode>([
  ['us', 'US'],
  ['u s', 'US'],
  ['usa', 'US'],
  ['u s a', 'US'],
  ['america', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['canada', 'CA'],
  ['uk', 'GB'],
  ['u k', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['ireland', 'IE'],
  ['australia', 'AU'],
  ['new zealand', 'NZ'],
  ['mexico', 'MX'],
  ['puerto rico', 'PR'],
  ['germany', 'DE'],
  ['france', 'FR'],
  ['spain', 'ES'],
  ['italy', 'IT'],
  ['netherlands', 'NL'],
  ['india', 'IN'],
]);

/** Phone region for a country cell: ISO 3166 alpha-2 codes and common English names. */
export function countryCodeFromName(country: string | null | undefined): CountryCode | undefined {
  if (!country) return undefined;
  const normalized = country
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (normalized === '') return undefined;
  const byName = COUNTRY_NAMES.get(normalized);
  if (byName) return byName;
  if (/^[a-z]{2}$/.test(normalized)) {
    const code = normalized.toUpperCase();
    if (isSupportedCountry(code)) return code;
  }
  return undefined;
}

/**
 * The apostrophe SPEC section 10 puts in front of a formula trigger when writing a CSV. The import
 * result file is meant to be fixed and uploaded again, so a value this app wrote has to survive the
 * round trip. Only an apostrophe directly followed by a trigger is removed, so an ordinary leading
 * apostrophe ("'Tis Pizza") is untouched.
 */
const FORMULA_ESCAPE_PREFIX = /^'(?=[=\-@+\t\r\n\uFF1D\uFF0D\uFF20\uFF0B])/;

function cleanCell(value: unknown): string | null {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  // papaparse puts cells beyond the header count in `__parsed_extra` as an array.
  else if (Array.isArray(value)) text = value.map((item) => (item === null || item === undefined ? '' : String(item))).join(', ');
  else text = String(value);
  // Postgres text cannot store NUL.
  const trimmed = text.split('\u0000').join('').trim().replace(FORMULA_ESCAPE_PREFIX, '');
  return trimmed === '' ? null : trimmed;
}

function noteLabel(header: string): string {
  if (header === '__parsed_extra') return 'Extra columns';
  return header.replace(/^\uFEFF/, '').trim() || 'Column';
}

/**
 * Validates and normalizes one parsed CSV row. Every string is trimmed and empty becomes null.
 * Unmapped non-empty cells (and extra cells mapped to an already-filled field) are appended to
 * notes as `Header: value` lines when `appendUnmappedToNotes` is on.
 */
export function validateImportRow(
  raw: Readonly<Record<string, unknown>>,
  mapping: Readonly<ImportMapping>,
  options: ValidateImportRowOptions,
): ValidateImportRowResult {
  const values: Partial<Record<ImportFieldKey, string>> = {};
  const noteParts: string[] = [];
  const extraLines: string[] = [];

  for (const [header, rawValue] of Object.entries(raw)) {
    const value = cleanCell(rawValue);
    if (value === null) continue;
    const mapped = Object.prototype.hasOwnProperty.call(mapping, header) ? mapping[header] : null;
    const field = isImportFieldKey(mapped) ? mapped : null;
    if (field === 'notes') {
      noteParts.push(value);
    } else if (field !== null && values[field] === undefined) {
      values[field] = value;
    } else if (options.appendUnmappedToNotes) {
      extraLines.push(`${noteLabel(header)}: ${value}`);
    }
  }

  const reasons: ImportRowReason[] = [];
  const businessName = values.business_name;
  if (businessName === undefined) reasons.push(IMPORT_ROW_REASONS.missingBusinessName);

  const phoneRaw = values.phone;
  let phone: string | undefined;
  if (phoneRaw === undefined) {
    reasons.push(IMPORT_ROW_REASONS.missingPhone);
  } else {
    const region = countryCodeFromName(values.country) ?? options.defaultCountry ?? 'US';
    const normalized = normalizePhone(phoneRaw, region);
    if (normalized.ok) phone = normalized.e164;
    else reasons.push(IMPORT_ROW_REASONS.unusablePhone);
  }

  if (businessName === undefined || phoneRaw === undefined || phone === undefined) {
    return { ok: false, reasons };
  }

  const businessTypeRaw = values.business_type;
  const businessType = businessTypeFromImportValue(businessTypeRaw);
  // An unrecognised category is kept, like any unmapped column, rather than silently dropped.
  if (businessTypeRaw !== undefined && businessType === null) extraLines.push(`Business type: ${businessTypeRaw}`);

  const notes = [...noteParts, ...extraLines].join('\n');
  const website = values.website ?? null;
  return {
    ok: true,
    lead: {
      business_name: businessName,
      contact_name: values.contact_name ?? null,
      phone,
      phone_raw: phoneRaw,
      email: values.email ?? null,
      website,
      website_domain: normalizeWebsiteDomain(website),
      address: values.address ?? null,
      city: values.city ?? null,
      state: values.state ?? null,
      country: values.country ?? null,
      source: values.source ?? null,
      business_type: businessType,
      notes: notes === '' ? null : notes,
      dedupe_name_key: nameCityKey(businessName, values.city),
    },
  };
}
