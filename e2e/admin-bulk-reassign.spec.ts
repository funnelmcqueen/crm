import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * SPEC 8 "Show a warning banner when leads are still assigned to disabled agents" plus the bulk
 * reassign that clears it.
 *
 * This spec moves Dana's four seeded leads to Casey, so Casey's lead count changes for everything that
 * runs after it: the import spec reads each agent's count before importing rather than assuming the
 * seeded 12. The mobile specs (Casey's core loop) run in an earlier project, so they see the seed.
 */
const DISABLED_AGENT = 'Dana Brooks';
const TARGET_AGENT = 'Casey Morgan';
const DANA_LEADS = 4;

const BANNER = 'section[aria-labelledby="disabled-agents-title"]';

/** The Leads number in an agent's row of the agents table. */
async function leadCount(page: Page, agentName: string): Promise<number> {
  const row = page.locator('tbody tr').filter({ hasText: agentName }).filter({ visible: true }).first();
  await expect(row).toBeVisible();
  const text = await row.locator('td').nth(2).innerText();
  return Number(text.replace(/[^0-9]/g, ''));
}

test("reassigning a disabled agent's leads clears the warning banner and grows the new owner", async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  // leadCount() reads the third column, so fail loudly here if the table ever gains one.
  await expect(page.locator('thead th').nth(2)).toHaveText('Leads');

  // --- the warning is there to begin with -------------------------------------------------------
  const banner = page.locator(BANNER);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`${DANA_LEADS} leads are still assigned to`);
  await expect(banner).toContainText(DISABLED_AGENT);

  expect(await leadCount(page, DISABLED_AGENT)).toBe(DANA_LEADS);
  const caseyBefore = await leadCount(page, TARGET_AGENT);

  // --- reassign from the banner -----------------------------------------------------------------
  await banner.getByRole('button', { name: 'Reassign' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Reassign ${DISABLED_AGENT}`);

  await dialog.getByRole('combobox', { name: 'Move to' }).click();
  await page.getByRole('option', { name: TARGET_AGENT, exact: true }).click();
  // The dialog counts the leads it is about to move before anything is written.
  await expect(dialog).toContainText(`${DANA_LEADS} leads will move to ${TARGET_AGENT}`);
  await dialog.getByRole('button', { name: 'Reassign leads' }).click();

  await expect(page.getByText(`Moved ${DANA_LEADS} leads to ${TARGET_AGENT}`)).toBeVisible();
  await expect(dialog).toBeHidden();

  // --- the warning is gone and the leads moved ---------------------------------------------------
  await expect(page.locator(BANNER)).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('still assigned to');
  await expect
    .poll(() => leadCount(page, TARGET_AGENT))
    .toBe(caseyBefore + DANA_LEADS);
  expect(await leadCount(page, DISABLED_AGENT)).toBe(0);

  // Fetched from the server again, not just an optimistic update.
  await page.reload();
  await expect(page.locator(BANNER)).toHaveCount(0);
  expect(await leadCount(page, TARGET_AGENT)).toBe(caseyBefore + DANA_LEADS);
  expect(await leadCount(page, DISABLED_AGENT)).toBe(0);

  // The admin dashboard's own version of the warning is gone too.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('still assigned to');
  await expect(page.getByRole('link', { name: 'Review agents' })).toHaveCount(0);
});
