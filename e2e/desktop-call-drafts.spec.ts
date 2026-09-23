import { expect, test } from '@playwright/test';
import { findLeadId, signIn } from './helpers';

test('lead notes survive reload, navigation and a failed save', async ({ page }) => {
  await signIn(page, 'blair');
  const id = await findLeadId(page, 'Windy City Heating & Cooling');
  await page.goto(`/leads/${id}`);
  const notes = page.getByLabel('Notes', { exact: true });
  const original = await notes.inputValue();
  await notes.fill('Ask for the owner on Friday.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(notes).toHaveValue('Ask for the owner on Friday.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'My Leads', exact: true }).last().click();
  await expect(page).toHaveURL(new RegExp(`/leads/${id}$`));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('link', { name: 'My Leads', exact: true }).last().click();
  await expect(page).toHaveURL(/\/leads$/);
  await page.goto(`/leads/${id}`);
  await expect(notes).toHaveValue('Ask for the owner on Friday.');
  await page.route('**/*', async (route) => {
    if (route.request().headers()['next-action']) await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#lead-notes-error')).toContainText(/couldn't save/i);
  await expect(notes).toHaveValue('Ask for the owner on Friday.');
  await page.unroute('**/*');
  // Restore the seed's original notes; this spec never changes shared fixtures.
  await notes.fill(original);
});
