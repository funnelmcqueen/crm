// SPEC 8 (Leads list): "Desktop table, mobile cards. Show business, contact, phone, location, status,
// last contacted, next follow-up, call count."
//
// Location used to be the one field the desktop table dropped below 1440px (`hidden
// min-[1440px]:table-cell`), so it was missing at 1280px — the width this repo's own Playwright
// `desktop` project uses, and a perfectly ordinary laptop. The spec lists it with no width condition,
// so the column is unconditional and truncates like the other text cells.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../src/components/leads/${relative}`, import.meta.url)), 'utf8');

const table = read('leads-table.tsx');
const cards = read('lead-cards.tsx');

/** Lines of the desktop table that render the Location header or its cell. */
function locationLines(): string[] {
  return table
    .split('\n')
    .filter((line) => line.includes('>Location<') || line.includes('locationLabel(row.city, row.state)'));
}

describe('leads desktop table (SPEC 8)', () => {
  it('shows every field the spec lists', () => {
    for (const heading of ['Business', 'Phone', 'Location', 'Status', 'Last contacted', 'Next follow-up', 'Calls']) {
      expect(table, `the desktop table is missing the ${heading} column`).toContain(`>${heading}<`);
    }
    // Contact name rides under the business name rather than in a column of its own.
    expect(table).toContain('row.contactName');
  });

  it('never hides Location behind a viewport width', () => {
    const gated = locationLines().filter((line) => /\bhidden\b|\bmin-\[/.test(line));
    expect(gated.map((line) => line.trim()), 'Location must render at every desktop width, not only on a wide monitor').toEqual([]);
  });

  it('keeps location in the mobile card subtitle', () => {
    expect(cards).toContain('locationLabel(row.city, row.state)');
  });
});
