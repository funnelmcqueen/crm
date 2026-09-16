import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The agent Today workspace and the Skipped queue (docs/DEVIATIONS.md D42, D43), as Casey, in the `workspace`
 * project after the import. The skip is resumed at the end, so the lead is back in Casey's call queue.
 */
test('Today shows the next best action, and a skipped lead waits in Skipped until it is resumed', async ({ page }) => {
  await signIn(page, 'casey');
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  const nextAction = page.getByRole('region', { name: 'Next best action' });
  await expect(nextAction).toBeVisible();
  await expect(page.getByRole('region', { name: 'Today’s goal' })).toContainText(/calls/);
  await expect(page.getByRole('region', { name: 'Your numbers today' })).toContainText('Connect rate');
  // Personal only: no team numbers or other agents anywhere on the page.
  await expect(page.getByText(/Alex Rivera|Blair Chen|Team/)).toHaveCount(0);

  await expect(nextAction.getByRole('heading')).toHaveCount(1);
  await expect(nextAction).toContainText(/Start calling|Continue your call queue/);
  const businessName = (await nextAction.locator('p.text-xl').first().innerText()).trim();

  await nextAction.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('menuitem', { name: 'Needs research first' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Skipped ${businessName}` })).toBeVisible();
  // The dashboard refreshes to another lead (or an empty state), not the skipped one.
  await expect(nextAction.locator('p.text-xl').filter({ hasText: businessName })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Skipped leads/ })).toContainText('1');

  await page.goto('/follow-ups?tab=skipped');
  await expect(page.getByRole('link', { name: /Skipped/, exact: false }).filter({ has: page.getByText('1') }).first()).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: businessName });
  await expect(card).toContainText('Needs research first');

  // The lead page shows the open skip and its history.
  await card.getByRole('link', { name: businessName }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Skipped' })).toContainText('Needs research first');
  await expect(page.getByRole('region', { name: 'Skip history' })).toContainText('Waiting in Skipped');

  await page.goto('/follow-ups?tab=skipped');
  await page.getByRole('button', { name: `Resume calling ${businessName}` }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+\?flow=next/);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: `${businessName} is back in your call queue` })).toBeVisible();

  await page.goto('/follow-ups?tab=skipped');
  await expect(page.getByText('No skipped leads', { exact: true })).toBeVisible();
  await expect(page.getByText('waits here with your reason')).toBeVisible();
});
