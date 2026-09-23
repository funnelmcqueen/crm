import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The Google Calendar Settings card (design §9, docs/DEVIATIONS.md D47) as an admin sees it before ever
 * connecting: the e2e server runs with `CALENDAR_DRIVER=mock`, so this is the "Not connected" state. Also
 * covers the bookable-hours editor, which works the same with or without a connection. Signed in as the
 * seeded admin, in the `workspace` project.
 *
 * The seeded Monday hours (10:00–12:00, 14:00–17:00) are what other specs assume. The last test already puts
 * them back on its own successful path, but `afterAll` below restores them unconditionally too: Playwright
 * stops a serial file at its first failing `expect()`, so any flake anywhere in this file — not just in the
 * last test — could otherwise leave Monday mid-edit for every spec that runs after it.
 */
test.describe.configure({ mode: 'serial' });

test('shows Not connected and a Connect link to Google, without following it', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings');

  const calendar = page.locator('#calendar');
  await expect(calendar.getByText('Not connected', { exact: true })).toBeVisible();

  const connectLink = calendar.getByRole('link', { name: 'Connect Google Calendar' });
  await expect(connectLink).toBeVisible();
  const href = await connectLink.getAttribute('href');
  expect(href).toMatch(/\/api\/google\/start$/);
});

test('lists who can book, and offers no way to create a calendar while nothing is connected', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings');

  const calendar = page.locator('#calendar');
  await expect(calendar.getByRole('heading', { level: 3, name: 'Who can book' })).toBeVisible();

  // The e2e server runs CALENDAR_DRIVER=mock and never connects, so nobody has a calendar and every
  // Create calendar button is disabled with the reason spelled out (docs/DEVIATIONS.md D48).
  await expect(calendar.getByText('Connect Google Calendar first, then give each person a calendar.')).toBeVisible();
  const create = calendar.getByRole('button', { name: 'Create calendar' }).first();
  await expect(create).toBeVisible();
  await expect(create).toBeDisabled();
});

test("the hours editor shows Monday's seeded ranges", async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings');

  const monday = page.locator('#calendar').getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');
  await expect(monday.locator('li').nth(0)).toContainText('10:00 – 12:00');
  await expect(monday.locator('li').nth(1)).toContainText('14:00 – 17:00');
});

test("changing Monday's first range and saving shows the success toast, and it survives a reload", async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings');

  const calendar = page.locator('#calendar');
  const monday = calendar.getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');

  await monday.getByLabel('Monday range 1 start').selectOption({ label: '11:00' });
  await calendar.getByRole('button', { name: 'Save hours' }).click();

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Bookable hours saved.' })).toBeVisible();
  await expect(monday.locator('li').nth(0)).toContainText('11:00 – 12:00');

  await page.reload();
  const mondayAfterReload = page.locator('#calendar').getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');
  await expect(mondayAfterReload.locator('li').nth(0)).toContainText('11:00 – 12:00');
  await expect(mondayAfterReload.locator('li').nth(1)).toContainText('14:00 – 17:00');
});

test('setting a start later than its end shows the inline message and saves nothing', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings');

  const calendar = page.locator('#calendar');
  let monday = calendar.getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');

  // Carries over from the previous test: Monday's first range now starts at 11:00.
  await expect(monday.locator('li').nth(0)).toContainText('11:00 – 12:00');

  await monday.getByLabel('Monday range 1 start').selectOption({ label: '13:00' });
  await calendar.getByRole('button', { name: 'Save hours' }).click();

  await expect(page.getByRole('alert').filter({ hasText: 'A start time must come before its end time.' })).toBeVisible();

  // Nothing was saved: a reload still shows the value from the previous test, not 13:00.
  await page.reload();
  monday = page.locator('#calendar').getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');
  await expect(monday.locator('li').nth(0)).toContainText('11:00 – 12:00');

  // Restore the seeded value so other specs' expectations (Monday 10:00–12:00) hold.
  await monday.getByLabel('Monday range 1 start').selectOption({ label: '10:00' });
  await page.locator('#calendar').getByRole('button', { name: 'Save hours' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Bookable hours saved.' })).toBeVisible();
  await expect(monday.locator('li').nth(0)).toContainText('10:00 – 12:00');
});

test.afterAll(async ({ browser }) => {
  // Unconditional cleanup: runs whether every test above passed, one of them failed partway through, or a
  // failure earlier in the file left the rest not run at all (serial mode stops the file at the first
  // failing `expect()`). A fresh context/page, independent of any test's own `page`, so a broken locator in
  // one of the tests can't also break the restore. Sets every value explicitly rather than reading current
  // state first, so it does not matter which range or field the last-run test left mid-edit.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signIn(page, 'admin');
    await page.goto('/settings');

    const calendar = page.locator('#calendar');
    const monday = calendar.getByRole('heading', { level: 4, name: 'Monday' }).locator('xpath=..');
    await monday.getByLabel('Monday range 1 start').selectOption({ label: '10:00' });
    await monday.getByLabel('Monday range 1 end').selectOption({ label: '12:00' });
    await monday.getByLabel('Monday range 2 start').selectOption({ label: '14:00' });
    await monday.getByLabel('Monday range 2 end').selectOption({ label: '17:00' });
    await calendar.getByRole('button', { name: 'Save hours' }).click();

    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Bookable hours saved.' })).toBeVisible();
    await expect(monday.locator('li').nth(0)).toContainText('10:00 – 12:00');
    await expect(monday.locator('li').nth(1)).toContainText('14:00 – 17:00');
  } finally {
    await context.close();
  }
});
