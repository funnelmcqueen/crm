import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { readCsvDownload, readCsvFile, signIn } from './helpers';

/**
 * The admin imports samples/leads.csv end to end, choosing "Import all duplicates" so the rows the
 * wizard flagged are really inserted (SPEC 9: warn, never auto-merge or delete).
 *
 * This spec inserts 97 leads, so it runs in its own Playwright project, after every other project (see
 * playwright.config.ts): the specs that assert seeded totals must see the seeded database. For the same
 * reason the project does not retry — a second attempt would import into a database the first attempt
 * already changed. Per-agent counts are read before the import rather than assumed, because an earlier
 * spec reassigns the disabled agent's leads.
 */

const CSV_PATH = path.resolve(__dirname, '..', 'samples', 'leads.csv');
const SEEDED_LEADS = 45;

// EXPECTED_IMPORT_PREVIEW in scripts/gen-sample-csv.ts. Not imported from there: that module uses
// import.meta, which Playwright cannot load. The sample file is checked against these numbers below.
const READY = 92;
const DUPLICATES = 5;
const INVALID = 3;
const TOTAL_ROWS = READY + DUPLICATES + INVALID;
/** Importing the duplicates anyway means every valid row is inserted. */
const IMPORTED = READY + DUPLICATES;

/** SPECIAL_ROWS in scripts/gen-sample-csv.ts: 0-based data rows the sample plants on purpose. */
const SPECIAL_ROWS = {
  invalidMissingCompany: 7,
  invalidPhoneNA: 58,
  invalidPhoneTooShort: 76,
  seedDuplicateByPhone: 12,
  seedDuplicateByWebsite: 29,
  seedDuplicateByNameCity: 47,
  inFilePhoneOriginal: 20,
  inFilePhoneCopy: 64,
  inFileWebsiteOriginal: 35,
  inFileWebsiteCopy: 91,
} as const;

/** The business names of the five flagged rows, all of which must end up in the database. */
const DUPLICATE_COMPANIES = [
  'HP Plumbing Services',
  'Cambridge PT & Sports Rehab',
  'MAIN STREET DENTAL-CARE',
  'Keystone Roofing LLC',
  'Silver Oak Landscaping',
] as const;

/** The lead each seed duplicate collided with; both have to exist afterwards. */
const SEED_ORIGINALS = {
  phone: 'Harbor Point Plumbing',
  website: 'Cambridge Physical Therapy',
  nameCity: 'Main Street Dental Care',
} as const;

/** splitCounts(97, 3): the remainder goes to the first agents, in the agent list's name order. */
const SPLIT = [33, 32, 32] as const;
const SPLIT_AGENTS = ['Alex Rivera', 'Blair Chen', 'Casey Morgan'] as const;

/** The spreadsheet row number of a 0-based data row (the header is row 1). */
const csvRow = (index: number) => index + 2;

/** Header -> the CRM field the wizard should guess, as the select renders it. */
const EXPECTED_MAPPING: ReadonlyArray<readonly [string, string]> = [
  ['Company', 'Business name (required)'],
  ['Contact Person', 'Contact name'],
  ['Phone Number', 'Phone (required)'],
  ['E-mail', 'Email'],
  ['Website URL', 'Website'],
  ['Street Address', 'Address'],
  ['City', 'City'],
  ['State', 'State'],
  ['Country', 'Country'],
  ['Lead Source', 'Source'],
  ['Notes', 'Notes'],
  ['Industry', "Don't import"],
  ['Employees', "Don't import"],
];

/** The number a StatCell shows under `label`. */
function statValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::span[1]');
}

/** Filters the admin leads list by agent and returns the total it reports. */
async function agentLeadCount(page: Page, agentName: string): Promise<number> {
  await page.goto('/leads');
  await page.getByRole('combobox', { name: 'Filter by agent' }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(page.locator('main')).toContainText('leads match');
  const text = await page.locator('main').innerText();
  return Number(/([\d,]+)\s+leads?\s+match/.exec(text)?.[1]?.replace(/,/g, '') ?? 'NaN');
}

/** The business names the leads list shows for a search. */
async function searchLeads(page: Page, query: string): Promise<string[]> {
  await page.goto(`/leads?q=${encodeURIComponent(query)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'All Leads' })).toBeVisible();
  const links = page.locator('main a[href^="/leads/"]').filter({ visible: true });
  if ((await links.count()) === 0) return [];
  return (await links.allInnerTexts()).map((text) => text.trim()).filter((text) => text !== '');
}

test('admin imports samples/leads.csv, keeping the duplicates: mapping, review, even split and result', async ({ page }) => {
  // next dev compiles /admin/import on first hit, and the import itself inserts 97 rows.
  test.setTimeout(300_000);

  // The sample file really is the file these expectations describe.
  const sample = await readCsvFile(CSV_PATH);
  expect(sample.rows).toHaveLength(TOTAL_ROWS);
  expect(sample.headers).toEqual(EXPECTED_MAPPING.map(([header]) => header));
  expect(sample.rows[SPECIAL_ROWS.invalidMissingCompany].Company).toBe('');
  expect(sample.rows[SPECIAL_ROWS.invalidPhoneNA]['Phone Number']).toBe('N/A');
  expect(sample.rows[SPECIAL_ROWS.invalidPhoneTooShort]['Phone Number']).toBe('12345');
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByPhone].Company).toBe(DUPLICATE_COMPANIES[0]);
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByWebsite].Company).toBe(DUPLICATE_COMPANIES[1]);
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByNameCity].Company).toBe(DUPLICATE_COMPANIES[2]);
  expect(sample.rows[SPECIAL_ROWS.inFilePhoneCopy].Company).toBe(DUPLICATE_COMPANIES[3]);
  expect(sample.rows[SPECIAL_ROWS.inFileWebsiteCopy].Company).toBe(DUPLICATE_COMPANIES[4]);
  const duplicatedPhone = sample.rows[SPECIAL_ROWS.seedDuplicateByPhone]['Phone Number'];
  expect(duplicatedPhone).toMatch(/\d/);

  await signIn(page, 'admin');

  // Whatever the earlier specs left behind, the import adds its share on top of it.
  const before: number[] = [];
  for (const agent of SPLIT_AGENTS) before.push(await agentLeadCount(page, agent));

  await page.goto('/admin/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import leads' })).toBeVisible();

  // --- upload ---------------------------------------------------------------------------------
  await page.getByLabel('CSV file').setInputFiles(CSV_PATH);
  await expect(page.getByText('leads.csv', { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${TOTAL_ROWS} rows · ${sample.headers.length} columns`))).toBeVisible();
  await page.getByRole('button', { name: 'Map columns' }).click();

  // --- the mapping is guessed from the headers -------------------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Map columns' })).toBeVisible();
  for (const [header, field] of EXPECTED_MAPPING) {
    await expect(page.getByRole('combobox', { name: header, exact: true })).toHaveText(field);
  }
  await page.getByRole('button', { name: 'Preview import' }).click();

  // --- preview --------------------------------------------------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Review' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`${READY} ready · ${DUPLICATES} possible duplicates · ${INVALID} invalid`)).toBeVisible();
  await expect(statValue(page, 'Ready')).toHaveText(String(READY));
  await expect(statValue(page, 'Possible duplicates')).toHaveText(String(DUPLICATES));
  await expect(statValue(page, 'Invalid')).toHaveText(String(INVALID));

  // The flagged rows are exactly the ones the sample file plants.
  await expect(page.getByRole('group', { name: /: skip or import$/ })).toHaveCount(DUPLICATES);
  const duplicateRows = [
    SPECIAL_ROWS.seedDuplicateByPhone,
    SPECIAL_ROWS.seedDuplicateByWebsite,
    SPECIAL_ROWS.seedDuplicateByNameCity,
    SPECIAL_ROWS.inFilePhoneCopy,
    SPECIAL_ROWS.inFileWebsiteCopy,
  ];
  for (const index of duplicateRows) {
    await expect(page.getByRole('group', { name: `Row ${csvRow(index)}: skip or import` })).toBeVisible();
  }
  const invalidRows = [
    SPECIAL_ROWS.invalidMissingCompany,
    SPECIAL_ROWS.invalidPhoneNA,
    SPECIAL_ROWS.invalidPhoneTooShort,
  ];
  for (const index of invalidRows) {
    await expect(page.getByText(`Row ${csvRow(index)}`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Missing business name', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Unusable phone', { exact: true })).toHaveCount(2);

  // Skipping is the default; this run keeps every duplicate instead. Invalid rows are never imported.
  await page.getByRole('button', { name: 'Skip all duplicates' }).click();
  await expect(page.getByRole('button', { name: `Continue with ${READY} leads` })).toBeVisible();
  await page.getByRole('button', { name: 'Import all duplicates' }).click();
  await expect(page.getByText(`${DUPLICATES} of ${DUPLICATES} will be imported anyway`)).toBeVisible();
  // Each row's own toggle agrees with the bulk choice.
  const firstDuplicate = page.getByRole('group', { name: `Row ${csvRow(duplicateRows[0])}: skip or import` });
  await expect(firstDuplicate.getByRole('button', { name: 'Import anyway' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: `Continue with ${IMPORTED} leads` }).click();

  // --- assign: an even split across the three seeded agents -------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Assign' })).toBeVisible();
  await page.getByRole('radio', { name: /Split evenly across agents/ }).click();
  for (const agent of SPLIT_AGENTS) {
    await page.getByRole('checkbox', { name: new RegExp(agent) }).check();
  }
  await expect(page.locator('p').filter({ hasText: 'Split:' })).toContainText(SPLIT.join(' / '));
  await expect(page.locator('main')).toContainText(`0 duplicates skipped · ${INVALID} invalid rows not imported`);
  await page.getByRole('button', { name: `Import ${IMPORTED} leads` }).click();

  // --- result ---------------------------------------------------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible({ timeout: 180_000 });
  await expect(statValue(page, 'Inserted')).toHaveText(String(IMPORTED));
  await expect(statValue(page, 'Skipped (duplicates)')).toHaveText('0');
  await expect(statValue(page, 'Invalid')).toHaveText(String(INVALID));
  await expect(statValue(page, 'Failed')).toHaveText('0');
  await expect(page.getByText(`${TOTAL_ROWS} rows in leads.csv`)).toBeVisible();

  // --- only the invalid rows come back, with their reasons ---------------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download skipped and failed rows' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('leads-skipped-and-failed.csv');
  const csv = await readCsvDownload(download);
  expect(csv.headers).toEqual([...sample.headers, 'reason']);
  expect(csv.rows).toHaveLength(INVALID);
  const reasonFor = (label: string, predicate: (row: Record<string, string>) => boolean): string => {
    const row = csv.rows.find(predicate);
    if (!row) throw new Error(`the skipped CSV has no ${label} row`);
    return row.reason;
  };
  expect(reasonFor('missing company', (row) => row.Company === '')).toBe('Missing business name');
  expect(reasonFor('N/A phone', (row) => row['Phone Number'] === 'N/A')).toBe('Unusable phone');
  expect(reasonFor('short phone', (row) => row['Phone Number'] === '12345')).toBe('Unusable phone');
  // Nothing that was imported is in the file the admin gets back.
  for (const company of DUPLICATE_COMPANIES) {
    expect(csv.text).not.toContain(company);
  }

  // --- the leads really landed, split evenly ----------------------------------------------------
  await page.goto('/leads');
  await expect(page.locator('main')).toContainText(`${SEEDED_LEADS + IMPORTED} leads in total`);
  for (const [index, agent] of SPLIT_AGENTS.entries()) {
    expect(await agentLeadCount(page, agent)).toBe(before[index] + SPLIT[index]);
  }

  // --- the duplicate rows are in the database, next to what they collided with --------------------
  for (const company of DUPLICATE_COMPANIES) {
    expect(await searchLeads(page, company), `${company} should have been imported`).toContain(company);
  }
  // The seed duplicates did not replace or merge into the leads they matched: both are there.
  for (const original of Object.values(SEED_ORIGINALS)) {
    expect(await searchLeads(page, original)).toContain(original);
  }
  // Searching the shared phone finds the seeded lead and the imported copy (SPEC 9 never auto-merges).
  const sharingThePhone = await searchLeads(page, duplicatedPhone);
  expect(sharingThePhone).toContain(SEED_ORIGINALS.phone);
  expect(sharingThePhone).toContain(DUPLICATE_COMPANIES[0]);
});
