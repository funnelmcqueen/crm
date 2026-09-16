import { expect, test, type Page } from '@playwright/test';
import { listedLeadTotal, readCsvDownload, signIn } from './helpers';

// Read-only: exporting writes nothing, so this spec shares Alex and the admin with the isolation spec.
const OTHER_AGENTS_LEAD = 'Uptown Law Partners'; // seeded lead owned by Blair
const FILENAME = /^funnel-mcqueen-leads-\d{4}-\d{2}-\d{2}\.csv$/;
// Spelled out rather than imported: src/server/services/export.ts reaches server-only code that
// cannot be loaded in a Playwright worker. This is EXPORT_ASSIGNED_AGENT_HEADER.
const ASSIGNED_AGENT_HEADER = 'Assigned agent';

/** The business names the leads list is showing on the current page. */
async function listedBusinessNames(page: Page): Promise<string[]> {
  const links = page.locator('main a[href^="/leads/"]').filter({ visible: true });
  await expect(links.first()).toBeVisible();
  return (await links.allInnerTexts()).map((text) => text.trim()).filter((text) => text !== '');
}

test.describe('leads CSV export', () => {
  test("an agent's export contains only their own leads and no Assigned agent column", async ({ page }) => {
    await signIn(page, 'alex');
    await page.goto('/leads');

    const total = await listedLeadTotal(page);
    // The list page size is 25, so Alex's whole list is on this page and the sets must match exactly.
    const names = new Set(await listedBusinessNames(page));
    expect(names.size).toBe(total);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).filter({ visible: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(FILENAME);

    const csv = await readCsvDownload(download);
    expect(csv.headers).not.toContain(ASSIGNED_AGENT_HEADER);
    expect(csv.headers[0]).toBe('Business');
    expect(csv.rows).toHaveLength(total);
    expect(new Set(csv.rows.map((row) => row.Business))).toEqual(names);
    // Nothing of another agent's leaks in, not even inside a cell.
    expect(csv.text).not.toContain(OTHER_AGENTS_LEAD);
  });

  test("the admin's export covers every lead and names the assigned agent", async ({ page }) => {
    await signIn(page, 'admin');
    await page.goto('/leads');
    const total = await listedLeadTotal(page);
    expect(total).toBeGreaterThan(25); // more than one page: the export is not just what is on screen

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).filter({ visible: true }).click(),
    ]);
    const csv = await readCsvDownload(download);

    expect(csv.headers.at(-1)).toBe(ASSIGNED_AGENT_HEADER);
    expect(csv.rows).toHaveLength(total);
    const agents = csv.rows.map((row) => row[ASSIGNED_AGENT_HEADER]);
    expect(new Set(agents)).toContain('Alex Rivera');
    expect(new Set(agents)).toContain('Blair Chen');
    // The admin also sees the leads no agent owns.
    expect(agents.filter((name) => name === '').length).toBeGreaterThan(0);
    expect(csv.rows.map((row) => row.Business)).toContain(OTHER_AGENTS_LEAD);
  });
});
