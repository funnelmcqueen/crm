import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn, UUID_PATTERN } from './helpers';

/**
 * SPEC 8 "Tap an agent to drill into their leads, calls and stats" and SPEC 17's admin journey.
 * Read-only: Alex and the admin are shared with the other read-only specs.
 */
const AGENT = 'Alex Rivera';
const AGENT_EMAIL = 'alex@funnelmcqueen.test';
const AGENT_LEAD = 'Beacon Hill Law Group'; // seeded lead of Alex's with calls today
const OTHER_AGENTS_LEAD = 'Windy City Heating & Cooling'; // Blair's

const STAT_LABELS = ['Dials', 'Connect rate', 'Talk time', 'Avg call', 'Interested', 'Appointments', 'Clients'] as const;

function statsGrid(page: Page): Locator {
  return page.locator('dl').filter({ hasText: 'Connect rate' }).first();
}

/** The number under a stat label, as a plain integer ("1,204" -> 1204, "45%" -> 45). */
async function statValue(page: Page, label: string): Promise<number> {
  const cell = statsGrid(page)
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  const text = await cell.locator('dd').first().innerText();
  return Number(text.replace(/[^0-9]/g, ''));
}

test('the admin dashboard drills into one agent and shows their stats and recent calls', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/dashboard');

  const row = page.locator('tr[data-agent-row]').filter({ hasText: AGENT }).filter({ visible: true });
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: AGENT }).click();

  await page.waitForURL(new RegExp(`/admin/agents/${UUID_PATTERN.source}$`));
  await expect(page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible();
  await expect(page.locator('main')).toContainText(AGENT_EMAIL);
  await expect(page.locator('main')).toContainText('Active');
  // Alex owns 12 seeded leads and no spec reassigns them.
  await expect(page.locator('main')).toContainText('12 leads');

  // --- stats for today --------------------------------------------------------------------------
  for (const label of STAT_LABELS) {
    await expect(statsGrid(page).getByText(label, { exact: true })).toBeVisible();
  }
  const dialsToday = await statValue(page, 'Dials');
  // The seed gives Alex several calls earlier today, in Alex's own timezone (D30).
  expect(dialsToday).toBeGreaterThan(0);
  expect(await statValue(page, 'Connect rate')).toBeGreaterThan(0);
  expect(await statValue(page, 'Clients')).toBeGreaterThanOrEqual(0);

  // --- recent calls -----------------------------------------------------------------------------
  const recent = page.getByRole('region', { name: /^Recent calls/ });
  await expect(recent).toBeVisible();
  await expect(recent.getByRole('link', { name: AGENT_LEAD }).first()).toBeVisible();
  const callLinks = recent.locator('a[href^="/leads/"]').filter({ visible: true });
  expect(await callLinks.count()).toBeGreaterThan(0);

  // The drill-down is scoped to this agent: another agent's lead never shows up in it.
  await expect(page.locator('main')).not.toContainText(OTHER_AGENTS_LEAD);

  // --- a wider range can only contain more ------------------------------------------------------
  await page.getByRole('link', { name: '30 days' }).click();
  await page.waitForURL(/range=30d/);
  await expect(page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible();
  const dials30 = await statValue(page, 'Dials');
  expect(dials30).toBeGreaterThanOrEqual(dialsToday);
  await expect(page.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page');
});
