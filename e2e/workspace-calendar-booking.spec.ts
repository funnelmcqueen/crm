import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Calendar booking on the mock calendar (docs/DEVIATIONS.md D46, D48), in the `workspace` project. Casey books a
 * suggested slot; Blair then finds that same time still open in their own panel, because each agent books into a
 * calendar of their own — and nothing of Casey's lead appears anywhere in it either way.
 */
test.describe.configure({ mode: 'serial' });

let bookedStart = '';
let bookedLead = '';

async function openFirstCallableLead(page: Page): Promise<string> {
  await page.goto('/leads');
  const row = page.locator('main table tbody tr').filter({ visible: true }).filter({ hasNot: page.getByText('Do Not Contact', { exact: true }) }).first();
  const link = row.locator('td:nth-child(2) a');
  const name = (await link.innerText()).trim();
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return name;
}

test('an agent books a suggested slot and the lead shows the next meeting', async ({ page }) => {
  await signIn(page, 'casey');
  bookedLead = await openFirstCallableLead(page);

  await page.getByRole('button', { name: 'Book meeting' }).first().click();
  const panel = page.getByRole('dialog', { name: `Book a meeting with ${bookedLead}` });
  const suggestion = panel.locator('[data-suggestion]').first();
  await expect(suggestion).toBeVisible();
  bookedStart = (await suggestion.getAttribute('data-slot-start')) ?? '';
  expect(bookedStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  await suggestion.click();
  await panel.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /^Booked: / })).toBeVisible();
  await expect(page.getByText('Next meeting:', { exact: true })).toBeVisible();
});

test("another agent still has that time, with nothing of the first agent's lead", async ({ page }) => {
  test.skip(bookedStart === '', 'depends on the booking above');
  await signIn(page, 'blair');
  const name = await openFirstCallableLead(page);

  await page.getByRole('button', { name: 'Book meeting' }).first().click();
  const panel = page.getByRole('dialog', { name: `Book a meeting with ${name}` });
  await expect(panel.getByRole('heading', { name: /^Best for / })).toBeVisible();

  const timeZone = (await panel.locator('[data-time-zone]').getAttribute('data-time-zone')) ?? 'America/New_York';
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(bookedStart));
  // Selected explicitly, awaited at each step: a slot only renders once its day is the chosen tab, so a
  // conditional click would let a still-rendering panel pass the assertion below for the wrong reason.
  const day = panel.locator(`[data-day="${dayKey}"]`);
  await expect(day).toBeEnabled();
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed', 'true');

  // Casey's meeting is on Casey's calendar, so it neither blocks Blair's picker (D48) nor reveals anything
  // about Casey's lead — the privacy rule from D46 is unchanged.
  await expect(panel.locator(`[data-slot-start="${bookedStart}"]`)).toHaveCount(1);
  await expect(panel).not.toContainText(bookedLead);
  // Blair taking it as well is covered in tests/integration/calendar/booking.test.ts and the unique index in
  // tests/db/calendar-booking.test.ts; booking here would move this lead to Appointment and disturb the specs
  // that run after this one against the same seeded workspace.
});
