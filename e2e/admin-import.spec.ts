import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { readCsvDownload, readCsvFile, signIn } from './helpers';

/**
 * The admin imports samples/leads.csv end to end. This spec inserts 92 leads, so it runs in its own
 * Playwright project, after every other project (see playwright.config.ts): the specs that assert
 * seeded totals must see the seeded database. For the same reason the project does not retry — a
 * second attempt would import into a database the first attempt already changed.
 */

const CSV_PATH = path.resolve(__dirname, '..', 'samples', 'leads.csv');
const SEEDED_LEADS = 45;
const LEADS_PER_SEEDED_AGENT = 12;

// EXPECTED_IMPORT_PREVIEW in scripts/gen-sample-csv.ts. Not imported from there: that module uses
// import.meta, which Playwright cannot load. The sample file is checked against these numbers below.
const READY = 92;
const DUPLICATES = 5;
const INVALID = 3;
const TOTAL_ROWS = READY + DUPLICATES + INVALID;

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

/** splitCounts(92, 3): the remainder goes to the first agents, in the agent list's name order. */
const SPLIT = [31, 31, 30] as const;
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
async function agentLeadCount(page: Page, agentName: string): Promise<string> {
  await page.goto('/leads');
  await page.getByRole('combobox', { name: 'Filter by agent' }).click();
  await page.getByRole('option', { name: agentName, exact: true }).click();
  await expect(page.locator('main')).toContainText('leads match');
  const text = await page.locator('main').innerText();
  return /([\d,]+)\s+leads?\s+match/.exec(text)?.[1]?.replace(/,/g, '') ?? '';
}

test('admin imports samples/leads.csv: mapping, duplicates, even split, result and skipped-row CSV', async ({ page }) => {
  // next dev compiles /admin/import on first hit, and the import itself inserts 92 rows.
  test.setTimeout(300_000);

  // The sample file really is the file these expectations describe.
  const sample = await readCsvFile(CSV_PATH);
  expect(sample.rows).toHaveLength(TOTAL_ROWS);
  expect(sample.headers).toEqual(EXPECTED_MAPPING.map(([header]) => header));
  expect(sample.rows[SPECIAL_ROWS.invalidMissingCompany].Company).toBe('');
  expect(sample.rows[SPECIAL_ROWS.invalidPhoneNA]['Phone Number']).toBe('N/A');
  expect(sample.rows[SPECIAL_ROWS.invalidPhoneTooShort]['Phone Number']).toBe('12345');
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByPhone].Company).toBe('HP Plumbing Services');
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByWebsite].Company).toBe('Cambridge PT & Sports Rehab');
  expect(sample.rows[SPECIAL_ROWS.seedDuplicateByNameCity].Company).toBe('MAIN STREET DENTAL-CARE');
  expect(sample.rows[SPECIAL_ROWS.inFilePhoneCopy].Company).toBe('Keystone Roofing LLC');
  expect(sample.rows[SPECIAL_ROWS.inFileWebsiteCopy].Company).toBe('Silver Oak Landscaping');

  await signIn(page, 'admin');
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

  // Importing the duplicates anyway would add all of them; skipping is the default and what we do here.
  await page.getByRole('button', { name: 'Import all duplicates' }).click();
  await expect(page.getByRole('button', { name: `Continue with ${READY + DUPLICATES} leads` })).toBeVisible();
  await page.getByRole('button', { name: 'Skip all duplicates' }).click();
  await page.getByRole('button', { name: `Continue with ${READY} leads` }).click();

  // --- assign: an even split across the three seeded agents -------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Assign' })).toBeVisible();
  await page.getByRole('radio', { name: /Split evenly across agents/ }).click();
  for (const agent of SPLIT_AGENTS) {
    await page.getByRole('checkbox', { name: new RegExp(agent) }).check();
  }
  await expect(page.locator('p').filter({ hasText: 'Split:' })).toContainText(SPLIT.join(' / '));
  await expect(page.locator('main')).toContainText(
    `${DUPLICATES} duplicates skipped · ${INVALID} invalid rows not imported`,
  );
  await page.getByRole('button', { name: `Import ${READY} leads` }).click();

  // --- result ---------------------------------------------------------------------------------
  await expect(page.getByRole('heading', { level: 2, name: 'Import finished' })).toBeVisible({ timeout: 180_000 });
  await expect(statValue(page, 'Inserted')).toHaveText(String(READY));
  await expect(statValue(page, 'Skipped (duplicates)')).toHaveText(String(DUPLICATES));
  await expect(statValue(page, 'Invalid')).toHaveText(String(INVALID));
  await expect(statValue(page, 'Failed')).toHaveText('0');
  await expect(page.getByText(`${TOTAL_ROWS} rows in leads.csv`)).toBeVisible();

  // --- the rows that were not imported download with their reasons ------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download skipped and failed rows' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('leads-skipped-and-failed.csv');
  const csv = await readCsvDownload(download);
  expect(csv.headers).toEqual([...sample.headers, 'reason']);
  expect(csv.rows).toHaveLength(DUPLICATES + INVALID);

  const reasonFor = (label: string, predicate: (row: Record<string, string>) => boolean): string => {
    const row = csv.rows.find(predicate);
    if (!row) throw new Error(`the skipped CSV has no ${label} row`);
    return row.reason;
  };
  // The invalid rows carry the reason the wizard showed.
  expect(reasonFor('missing company', (row) => row.Company === '')).toBe('Missing business name');
  expect(reasonFor('N/A phone', (row) => row['Phone Number'] === 'N/A')).toBe('Unusable phone');
  expect(reasonFor('short phone', (row) => row['Phone Number'] === '12345')).toBe('Unusable phone');
  // The duplicates name what they collided with: an existing lead, or an earlier row of this file.
  expect(reasonFor('phone duplicate', (row) => row.Company === 'HP Plumbing Services')).toMatch(
    /^Skipped possible duplicate: Same phone as Harbor Point Plumbing/,
  );
  expect(reasonFor('website duplicate', (row) => row.Company === 'Cambridge PT & Sports Rehab')).toMatch(
    /^Skipped possible duplicate: Same website as Cambridge Physical Therapy/,
  );
  expect(reasonFor('name/city duplicate', (row) => row.Company === 'MAIN STREET DENTAL-CARE')).toMatch(
    /^Skipped possible duplicate: Same business name and city as Main Street Dental Care/,
  );
  expect(reasonFor('in-file phone duplicate', (row) => row.Company === 'Keystone Roofing LLC')).toBe(
    `Skipped possible duplicate: Same phone as row ${csvRow(SPECIAL_ROWS.inFilePhoneOriginal)}`,
  );
  expect(reasonFor('in-file website duplicate', (row) => row.Company === 'Silver Oak Landscaping')).toBe(
    `Skipped possible duplicate: Same website as row ${csvRow(SPECIAL_ROWS.inFileWebsiteOriginal)}`,
  );

  // --- the leads really landed, split evenly ----------------------------------------------------
  await page.goto('/leads');
  await expect(page.locator('main')).toContainText(`${SEEDED_LEADS + READY} leads in total`);
  for (const [index, agent] of SPLIT_AGENTS.entries()) {
    expect(await agentLeadCount(page, agent)).toBe(String(LEADS_PER_SEEDED_AGENT + SPLIT[index]));
  }
});
