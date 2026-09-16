import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Pipeline stage navigation (docs/DEVIATIONS.md D44). Read only: nothing on the board changes. */
test('every stage is reachable from the stage bar, and the arrows page the board sideways', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/pipeline');

  const stages = page.getByRole('navigation', { name: 'Pipeline stages' });
  for (const label of ['New', 'To Call', 'Connected', 'Interested', 'Appointment', 'Proposal', 'Client']) {
    await expect(stages.getByRole('button', { name: new RegExp(`^${label} \\d+ leads?$`) })).toBeVisible();
  }

  const later = stages.getByRole('button', { name: 'Scroll to later stages' });
  const earlier = stages.getByRole('button', { name: 'Scroll to earlier stages' });
  await expect(earlier).toBeDisabled();
  await expect(later).toBeEnabled();

  await stages.getByRole('button', { name: /^Client \d+ leads?$/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Client', exact: true })).toBeFocused();
  await expect(page.locator('[data-column="CLIENT"]')).toBeInViewport();
  await expect(earlier).toBeEnabled();

  // Page back until the start; how many pages that takes depends on the viewport.
  for (let pages = 0; pages < 6 && (await earlier.isEnabled()); pages += 1) {
    await earlier.click();
    await page.waitForTimeout(400);
  }
  await expect(earlier).toBeDisabled();
  await expect(page.locator('[data-column="NEW"]')).toBeInViewport();

  // Column headers stay put while a long column scrolls inside its own box.
  const newColumn = page.locator('[data-column="NEW"]');
  const box = await newColumn.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport ? box.y + box.height : 0).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
});
