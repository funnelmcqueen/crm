import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * SPEC 8 Reports: a date range picker, per-agent and per-number tables, team totals. Read-only.
 *
 * The assertions are about what the numbers have to agree with rather than exact values, because the
 * seed is relative to "now" and earlier specs in this project log calls: the totals must always be the
 * sum of the rows they sit above (D30), answered can never exceed dials, and a wider range can only
 * contain more.
 */
const ADMIN_TZ = 'America/New_York'; // the seeded admin's profile timezone
const SEEDED_AGENTS = ['Alex Rivera', 'Blair Chen', 'Casey Morgan', 'Dana Brooks'] as const;
/** Last four digits of the three seeded Twilio numbers (+1 415 555-0150/0151/0152). */
const SEEDED_NUMBERS = ['0150', '0151', '0152'] as const;

/** Today in `tz` as yyyy-MM-dd, computed from Intl so this is an independent check of the app's maths. */
function todayInTz(tz: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Calendar arithmetic on a yyyy-MM-dd value, immune to DST (a UTC anchor, no timezone involved). */
function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const region = (page: Page, name: string): Locator => page.getByRole('region', { name });

function digits(text: string): number {
  return Number(text.replace(/[^0-9]/g, ''));
}

/** A team-totals tile value. */
async function totalValue(page: Page, label: string): Promise<number> {
  const cell = region(page, 'Team totals')
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  return digits(await cell.locator('dd').first().innerText());
}

/** Every visible data row of a section's desktop table. */
function tableRows(section: Locator): Locator {
  return section.locator('tbody tr').filter({ visible: true });
}

async function columnValues(section: Locator, column: number): Promise<number[]> {
  const rows = tableRows(section);
  const count = await rows.count();
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(digits(await rows.nth(index).locator('td').nth(column).innerText()));
  }
  return values;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/** Asserts the page's tables are internally consistent, and returns the team dial total. */
async function checkTables(page: Page): Promise<number> {
  const agents = region(page, 'Per agent');
  const numbers = region(page, 'Per number');
  await expect(agents).toBeVisible();
  await expect(numbers).toBeVisible();

  // Every seeded agent has a row, including the disabled one (their history has to stay visible, D27).
  for (const name of SEEDED_AGENTS) {
    await expect(tableRows(agents).filter({ hasText: name })).toHaveCount(1);
  }
  await expect(tableRows(agents).filter({ hasText: 'Dana Brooks' })).toContainText('Disabled');

  // Per agent: Agent | Dials | Connect rate | Talk min | Avg call | Interested | Appointments | Clients
  const agentDials = await columnValues(agents, 1);
  expect(agentDials.length).toBeGreaterThanOrEqual(SEEDED_AGENTS.length);
  // The team tiles are the sum of the rows printed underneath them.
  expect(await totalValue(page, 'Dials')).toBe(sum(agentDials));
  expect(await totalValue(page, 'Interested')).toBe(sum(await columnValues(agents, 5)));
  expect(await totalValue(page, 'Appointments')).toBe(sum(await columnValues(agents, 6)));
  expect(await totalValue(page, 'Clients')).toBe(sum(await columnValues(agents, 7)));

  // Per number: Number | Label | Dials | Answered | Answer rate
  for (const tail of SEEDED_NUMBERS) {
    await expect(tableRows(numbers).filter({ hasText: tail })).toHaveCount(1);
  }
  const numberDials = await columnValues(numbers, 2);
  const answered = await columnValues(numbers, 3);
  for (const [index, dials] of numberDials.entries()) {
    expect(answered[index]).toBeLessThanOrEqual(dials);
  }
  // Calls that used a number are a subset of all dials (a TEL call has no caller ID row).
  expect(sum(numberDials)).toBeLessThanOrEqual(sum(agentDials));

  return sum(agentDials);
}

test('admin reports: a preset range and a custom range both render consistent tables', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();

  // --- the default preset -----------------------------------------------------------------------
  await expect(page.getByRole('link', { name: 'Last 7 days' })).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('main')).toContainText('7 days');
  const sevenDayDials = await checkTables(page);

  // --- another preset ---------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Last 30 days' }).click();
  await page.waitForURL(/[?&]from=/);
  await expect(page.getByRole('link', { name: 'Last 30 days' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('link', { name: 'Last 7 days' })).not.toHaveAttribute('aria-current', 'true');
  await expect(page.locator('main')).toContainText('30 days');
  const thirtyDayDials = await checkTables(page);
  // The seed spreads calls over the last ten days, so the wider window really is wider.
  expect(thirtyDayDials).toBeGreaterThan(0);
  expect(thirtyDayDials).toBeGreaterThanOrEqual(sevenDayDials);

  // --- a custom range ---------------------------------------------------------------------------
  const today = todayInTz(ADMIN_TZ);
  const from = addLocalDays(today, -89);
  // By id: "To" as an accessible name also matches the "Team totals" region and a dev-tools button.
  await page.locator('#report-from').fill(from);
  await page.locator('#report-to').fill(today);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL((url) => url.searchParams.get('from') === from && url.searchParams.get('to') === today);
  await expect(page.locator('main')).toContainText('90 days');
  // A custom range matches no preset, so none of them is marked current.
  for (const preset of ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'This month']) {
    await expect(page.getByRole('link', { name: preset })).not.toHaveAttribute('aria-current', 'true');
  }
  const ninetyDayDials = await checkTables(page);
  expect(ninetyDayDials).toBeGreaterThanOrEqual(thirtyDayDials);

  // --- a range that cannot be right is refused, and the tables stay on the last good one ----------
  await page.locator('#report-from').fill(today);
  await page.locator('#report-to').fill(from);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('The start date is after the end date.')).toBeVisible();
  await expect(page).toHaveURL((url) => url.searchParams.get('from') === from);
});
