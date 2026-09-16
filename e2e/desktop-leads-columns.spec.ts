import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

// SPEC 8 (Leads list): "Desktop table, mobile cards. Show business, contact, phone, location, status,
// last contacted, next follow-up, call count."
//
// Location was gated behind `min-[1440px]`, so on a 1280px laptop — the width this suite's own desktop
// project uses — the column was simply absent, and an agent qualifying a list by city had to open every
// lead to see where it is. The gap was invisible on a large monitor, which is how it survived.
//
// Read-only: this spec only looks at Alex's list.

const SPEC_COLUMNS = ['Business', 'Phone', 'Location', 'Status', 'Last contacted', 'Next follow-up', 'Calls'];

async function openLeads(page: Page): Promise<void> {
  await signIn(page, 'alex');
  await page.goto('/leads');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test.describe('leads list desktop columns', () => {
  for (const width of [1024, 1280]) {
    test(`shows every spec column at ${width}px, Location included`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openLeads(page);

      const table = page.locator('table');
      await expect(table).toBeVisible();
      for (const column of SPEC_COLUMNS) {
        await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
      }
    });
  }

  test('fills the Location cell from the lead city and state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openLeads(page);

    const headers = page.locator('table thead th');
    const locationIndex = (await headers.allInnerTexts()).findIndex((text) => text.trim() === 'Location');
    expect(locationIndex).toBeGreaterThan(-1);

    // Every seeded lead carries a city and a state, so no row should fall back to the em dash.
    const firstRowLocation = page.locator('table tbody tr').first().locator('td').nth(locationIndex);
    await expect(firstRowLocation).toBeVisible();
    await expect(firstRowLocation).toHaveText(/^[A-Za-z .'-]+, [A-Z]{2}$/);
  });
});
