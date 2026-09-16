import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { listedLeadTotal, signIn } from './helpers';

/**
 * Bulk lead management on All Leads (docs/DEVIATIONS.md D41), in the `workspace` project: it runs after the import
 * spec and only changes leads that import created (sources "Trade Show" and "LinkedIn" exist only in
 * samples/leads.csv), so no spec that asserts seeded data runs after it.
 */
test.describe.configure({ mode: 'serial' });

const bulkBar = (page: Page) => page.getByRole('region', { name: 'Bulk actions for selected leads' });
const pageCheckbox = (page: Page) => page.getByRole('checkbox', { name: /on this page$/ }).filter({ visible: true });
const rowCheckboxes = (page: Page) => page.getByRole('checkbox', { name: /^Select (?!the )/ }).filter({ visible: true });

async function selectedCount(page: Page): Promise<number> {
  const text = await bulkBar(page).getByText(/selected$/).first().innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

test('selection: header states, kept across pages and reloads, select all matching, cleared by a filter change', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/leads?source=Google%20Maps');
  const total = await listedLeadTotal(page);
  expect(total, 'Google Maps leads span more than one page after the import').toBeGreaterThan(25);

  await expect(pageCheckbox(page)).toHaveAttribute('aria-checked', 'false');
  await expect(bulkBar(page)).toHaveCount(0);

  await rowCheckboxes(page).first().click();
  await expect(pageCheckbox(page)).toHaveAttribute('aria-checked', 'mixed');
  await expect(bulkBar(page)).toContainText('1 selected');

  await pageCheckbox(page).click();
  await expect(pageCheckbox(page)).toHaveAttribute('aria-checked', 'true');
  expect(await selectedCount(page)).toBe(25);

  // Paging keeps the selection; the second page's rows are not selected.
  await page.getByRole('link', { name: /next/i }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/page=2/);
  expect(await selectedCount(page)).toBe(25);
  await expect(pageCheckbox(page)).toHaveAttribute('aria-checked', 'false');

  await bulkBar(page).getByRole('button', { name: `Select all ${total} matching` }).click();
  await expect(bulkBar(page)).toContainText(`${total} selected`);
  await expect(pageCheckbox(page)).toHaveAttribute('aria-checked', 'true');

  // A reload of the same tab and a different sort keep it.
  await page.reload();
  await expect(bulkBar(page)).toContainText(`${total} selected`);
  await page.goto('/leads?source=Google%20Maps&sort=business_name');
  await expect(bulkBar(page)).toContainText(`${total} selected`);

  // A different filter is a different result set: the selection is cleared, and the page says so.
  await page.goto('/leads?source=Referral');
  await expect(bulkBar(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'the selection was cleared' })).toBeVisible();

  // Keyboard: Space toggles a focused row checkbox; Clear selection empties it.
  await rowCheckboxes(page).first().focus();
  await page.keyboard.press('Space');
  await expect(bulkBar(page)).toContainText('1 selected');
  await bulkBar(page).getByRole('button', { name: 'Clear selection' }).click();
  await expect(bulkBar(page)).toHaveCount(0);
});

test('unassigned leads: the callout selects them all for one-step assignment', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/leads');
  const callout = page.getByRole('region', { name: 'Unassigned leads' });
  await expect(callout).toContainText('not in anyone’s call queue');
  await callout.getByRole('link', { name: 'Review unassigned' }).click();
  await expect(page).toHaveURL(/unassigned=1/);
  // The select button only exists on the unassigned view, so the total below is that view's, not the previous page's.
  const selectUnassigned = page
    .getByRole('region', { name: 'Unassigned leads' })
    .getByRole('button', { name: /^Select \d+ leads? to assign$/ });
  await expect(selectUnassigned).toBeVisible();
  const total = await listedLeadTotal(page);

  await selectUnassigned.click();
  await expect(bulkBar(page)).toContainText(`${total} selected`);
  await expect(bulkBar(page).getByRole('button', { name: 'Assign' })).toBeVisible();
  await bulkBar(page).getByRole('button', { name: 'Clear selection' }).click();
});

test('assign and set status in bulk, each with Undo', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/leads?source=Trade%20Show');
  const total = await listedLeadTotal(page);
  expect(total).toBeGreaterThan(3);
  expect(total).toBeLessThanOrEqual(25);

  await pageCheckbox(page).click();
  await expect(bulkBar(page)).toContainText(`${total} selected`);
  await bulkBar(page).getByRole('button', { name: 'Assign' }).click();
  await page.getByRole('menuitem', { name: 'Blair Chen' }).click();
  const assigned = page.locator('[data-sonner-toast]').filter({ hasText: 'to Blair Chen' });
  await expect(assigned).toBeVisible();
  await expect(bulkBar(page)).toHaveCount(0);
  const table = page.locator('main table').filter({ visible: true });
  await expect(table.getByRole('cell', { name: 'Blair Chen', exact: true })).toHaveCount(total);

  await assigned.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Undid the change on \d+ leads?\./ })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Blair Chen', exact: true })).not.toHaveCount(total);

  await pageCheckbox(page).click();
  await bulkBar(page).getByRole('button', { name: 'Set status' }).click();
  await page.getByRole('menuitem', { name: 'Proposal' }).click();
  const moved = page.locator('[data-sonner-toast]').filter({ hasText: /Moved \d+ leads? to Proposal\./ });
  await expect(moved).toBeVisible();
  await expect(table.getByText('Proposal', { exact: true })).toHaveCount(total);
  await moved.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Undid the change on \d+ leads?\./ }).last()).toBeVisible();
  await expect(table.getByText('Proposal', { exact: true })).toHaveCount(0);
});

test('follow-up, export and delete a selection', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/leads?source=LinkedIn&sort=business_name');
  const total = await listedLeadTotal(page);
  const names = await page.locator('main table tbody tr td:nth-child(2) a').filter({ visible: true }).allInnerTexts();
  expect(names.length).toBeGreaterThanOrEqual(3);

  await rowCheckboxes(page).nth(0).click();
  await rowCheckboxes(page).nth(1).click();
  await bulkBar(page).getByRole('button', { name: 'Follow-up' }).click();
  const followUp = page.getByRole('dialog', { name: 'Follow-up for 2 leads' });
  await expect(followUp.getByRole('radio', { name: 'Tomorrow 9am' })).toHaveAttribute('aria-checked', 'true');
  await followUp.getByRole('button', { name: 'Set follow-up on 2 leads' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Follow-up set on 2 leads/ })).toBeVisible();

  await rowCheckboxes(page).nth(0).click();
  await rowCheckboxes(page).nth(1).click();
  await bulkBar(page).getByRole('button', { name: 'More bulk actions' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^funnel-mcqueen-leads.*\.csv$/);
  const csv = await readFile((await download.path()) as string, 'utf8');
  expect(csv).toContain(names[0].replace(/"/g, '""'));
  expect(csv).toContain(names[1].replace(/"/g, '""'));
  expect(csv).not.toContain(names[2].replace(/"/g, '""'));
  // Export keeps the selection.
  await expect(bulkBar(page)).toContainText('2 selected');
  await bulkBar(page).getByRole('button', { name: 'Clear selection' }).click();

  await rowCheckboxes(page).nth(2).click();
  await bulkBar(page).getByRole('button', { name: 'More bulk actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete leads…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete 1 lead?' });
  await expect(confirm).toContainText('permanently deletes this lead');
  await expect(confirm).toContainText('cannot be undone');
  await confirm.getByRole('button', { name: 'Delete 1 lead' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Deleted 1 lead.' })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${total - 1} leads match`))).toBeVisible();
  await expect(page.getByRole('link', { name: names[2], exact: true })).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('cards have checkboxes and the bulk bar fits the screen', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/leads?source=Trade%20Show');
    await rowCheckboxes(page).nth(0).click();
    await rowCheckboxes(page).nth(1).click();
    await expect(bulkBar(page)).toContainText('2 selected');
    await expect(bulkBar(page).getByRole('button', { name: 'Assign' })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await bulkBar(page).getByRole('button', { name: 'Clear selection' }).click();
    await expect(bulkBar(page)).toHaveCount(0);
  });
});
