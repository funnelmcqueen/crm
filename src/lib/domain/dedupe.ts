export type DuplicateReason = 'phone' | 'domain' | 'name_city';

export interface DedupeCandidate {
  rowIndex: number;
  phoneE164: string | null;
  websiteDomain: string | null;
  nameCityKey: string | null;
}

export interface ExistingLeadKeys {
  leadId: string;
  phone: string | null;
  websiteDomain: string | null;
  nameCityKey: string | null;
}

export interface DuplicateMatch {
  rowIndex: number;
  /** Always in the order phone, domain, name_city. */
  reasons: DuplicateReason[];
  existingLeadIds: string[];
  /** Earlier rows of the same file this row duplicates, ascending. */
  duplicateOfRowIndexes: number[];
}

const NON_ALPHANUMERIC = /[^A-Za-z0-9]+/g;
const REASON_ORDER: readonly DuplicateReason[] = ['phone', 'domain', 'name_city'];

function squash(value: string | null | undefined): string {
  return (value ?? '').replace(NON_ALPHANUMERIC, '').toLowerCase();
}

/**
 * Must equal the generated column `leads.dedupe_name_key`:
 * `lower(regexp_replace(business_name,'[^A-Za-z0-9]+','','g')) || '|' || lower(regexp_replace(coalesce(city,''),'[^A-Za-z0-9]+','','g'))`.
 * Returns null (never matches) when nothing alphanumeric is left of the business name.
 */
export function nameCityKey(
  businessName: string | null | undefined,
  city: string | null | undefined,
): string | null {
  const business = squash(businessName);
  if (business === '') return null;
  return `${business}|${squash(city)}`;
}

function keysOf(
  phone: string | null,
  domain: string | null,
  nameKey: string | null,
): Array<string> {
  const keys: string[] = [];
  const p = phone?.trim();
  if (p) keys.push(`phone:${p}`);
  const d = domain?.trim().toLowerCase();
  if (d) keys.push(`domain:${d}`);
  // A SQL key for a punctuation-only business name is '|city'; it identifies nothing.
  if (nameKey && !nameKey.startsWith('|')) keys.push(`name_city:${nameKey}`);
  return keys;
}

function reasonOf(key: string): DuplicateReason {
  return key.slice(0, key.indexOf(':')) as DuplicateReason;
}

function pushUnique<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/**
 * Flags rows that share a normalized phone, website domain or name+city key with an existing lead
 * or with an earlier row of the same file. The first occurrence within the file is not flagged
 * (unless it matches an existing lead). Warn-only: nothing is merged or removed.
 */
export function findDuplicates(
  rows: readonly DedupeCandidate[],
  existing: readonly ExistingLeadKeys[],
): DuplicateMatch[] {
  const existingByKey = new Map<string, string[]>();
  for (const lead of existing) {
    for (const key of keysOf(lead.phone, lead.websiteDomain, lead.nameCityKey)) {
      pushUnique(existingByKey, key, lead.leadId);
    }
  }

  const ordered = rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => a.row.rowIndex - b.row.rowIndex || a.position - b.position)
    .map(({ row }) => row);

  const seenByKey = new Map<string, number[]>();
  const matches: DuplicateMatch[] = [];

  for (const row of ordered) {
    const keys = keysOf(row.phoneE164, row.websiteDomain, row.nameCityKey);
    const reasons = new Set<DuplicateReason>();
    const leadIds = new Set<string>();
    const earlierRows = new Set<number>();

    for (const key of keys) {
      const ids = existingByKey.get(key);
      if (ids) {
        reasons.add(reasonOf(key));
        ids.forEach((id) => leadIds.add(id));
      }
      const seen = seenByKey.get(key)?.filter((index) => index !== row.rowIndex);
      if (seen && seen.length > 0) {
        reasons.add(reasonOf(key));
        seen.forEach((index) => earlierRows.add(index));
      }
    }
    for (const key of keys) pushUnique(seenByKey, key, row.rowIndex);

    if (reasons.size > 0) {
      matches.push({
        rowIndex: row.rowIndex,
        reasons: REASON_ORDER.filter((reason) => reasons.has(reason)),
        existingLeadIds: [...leadIds],
        duplicateOfRowIndexes: [...earlierRows].sort((a, b) => a - b),
      });
    }
  }
  return matches;
}
