import { expect, test } from '@playwright/test';
import { findLeadId, signIn } from './helpers';

// Read-only: Alex and the admin are not used by the specs that log calls.
const OTHER_AGENTS_LEAD = 'Uptown Law Partners'; // seeded lead owned by Blair
const RANDOM_LEAD_ID = '00000000-0000-4000-8000-000000000000';

test.describe('isolation in the UI', () => {
  test("an agent opening another agent's lead URL sees the same not-found page as a nonexistent id", async ({ page }) => {
    await signIn(page, 'admin');
    const blairLeadId = await findLeadId(page, OTHER_AGENTS_LEAD);
    await page.context().clearCookies();

    await signIn(page, 'alex');
    await page.goto(`/leads/${blairLeadId}`);
    const main = page.locator('main');
    await expect(main.getByText('Lead not found')).toBeVisible();
    await expect(main).not.toContainText(OTHER_AGENTS_LEAD);
    await expect(page.getByRole('button', { name: `Call ${OTHER_AGENTS_LEAD}` })).toHaveCount(0);
    const forbiddenText = (await main.innerText()).trim();

    await page.goto(`/leads/${RANDOM_LEAD_ID}`);
    await expect(main.getByText('Lead not found')).toBeVisible();
    expect((await main.innerText()).trim()).toBe(forbiddenText);
  });

  test('an agent visiting /admin/agents gets a 404', async ({ page }) => {
    await signIn(page, 'alex');
    const response = await page.goto('/admin/agents');
    expect(response?.status()).toBe(404);
  });

  test('the admin sees All Leads with a total of 45', async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/leads');
    await expect(page.getByRole('heading', { level: 1, name: 'All Leads' })).toBeVisible();
    await expect(page.locator('main')).toContainText('45 leads in total');
    await expect(page.locator('main')).toContainText(/of\s+45/);
  });
});
