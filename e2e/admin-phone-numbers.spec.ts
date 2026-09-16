import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * SPEC 7d: add a number the admin already owns in Twilio, then assign / unassign / deactivate it.
 * DIALER_DRIVER=mock, so the lookup is the labelled mock one (D27) and only fictional 555-01xx
 * numbers are accepted.
 *
 * The number below is in the reserved range but outside the area codes the seed uses (+1 415 555-0150
 * to 0152), so it never collides with the seeded Twilio numbers. It ends the test deactivated, which
 * keeps it out of the caller-ID pool for every spec that runs afterwards.
 */
const NUMBER_E164 = '+16505550188';
const NUMBER_TAIL = '0188';
const NUMBER_LABEL = 'E2E Overflow Line';
const AGENT = 'Casey Morgan';

/** The new number's row, found by its label so no phone formatting is assumed. */
function numberRow(page: Page): Locator {
  return page.locator('tbody tr').filter({ hasText: NUMBER_LABEL }).filter({ visible: true });
}

async function chooseAction(page: Page, item: string | RegExp): Promise<void> {
  await numberRow(page).getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('admin adds a mock number, assigns it to an agent, unassigns it and deactivates it', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/phone-numbers');
  await expect(page.getByRole('heading', { level: 1, name: 'Phone Numbers' })).toBeVisible();
  // The page says out loud that nothing is being verified with Twilio here (D27).
  await expect(page.locator('main')).toContainText('Mock mode');
  await expect(numberRow(page)).toHaveCount(0);

  // --- add ------------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Add number' }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByLabel('Number (E.164)').fill(NUMBER_E164);
  await addDialog.getByLabel('Label (optional)').fill(NUMBER_LABEL);
  await expect(addDialog).toContainText(`Saves as ${NUMBER_E164}`);
  await addDialog.getByRole('button', { name: 'Add number' }).click();
  await expect(page.getByText(new RegExp(`Added .*${NUMBER_TAIL} to the pool`))).toBeVisible();

  const row = numberRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(NUMBER_TAIL);
  await expect(row).toContainText('Pool');
  await expect(row).toContainText('Active');

  // --- assign to an agent -----------------------------------------------------------------------
  await chooseAction(page, 'Assign to agent…');
  const assignDialog = page.getByRole('dialog');
  await assignDialog.getByRole('combobox', { name: 'Agent' }).click();
  await page.getByRole('option', { name: AGENT, exact: true }).click();
  await assignDialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText(new RegExp(`assigned to ${AGENT}`))).toBeVisible();
  await expect(row).toContainText(AGENT);
  await expect(row).not.toContainText('Pool');

  // --- unassign (back to the shared pool) --------------------------------------------------------
  await chooseAction(page, 'Unassign (back to pool)');
  await expect(page.getByText(new RegExp(`${NUMBER_TAIL} is back in the pool`))).toBeVisible();
  await expect(row).toContainText('Pool');
  await expect(row).not.toContainText(AGENT);

  // --- deactivate --------------------------------------------------------------------------------
  await chooseAction(page, 'Deactivate');
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(new RegExp(`Deactivate .*${NUMBER_TAIL}\\?`));
  await confirm.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(page.getByText(new RegExp(`${NUMBER_TAIL} deactivated`))).toBeVisible();
  await expect(row).toContainText('Inactive');

  // Every step came from the database, not from an optimistic update.
  await page.reload();
  const reloaded = numberRow(page);
  await expect(reloaded).toHaveCount(1);
  await expect(reloaded).toContainText('Inactive');
  await expect(reloaded).toContainText('Pool');
  // A deactivated number offers Reactivate instead of Deactivate.
  await reloaded.getByRole('button', { name: /^Actions for / }).click();
  await expect(page.getByRole('menuitem', { name: 'Reactivate' })).toBeVisible();
  await page.keyboard.press('Escape');
});
