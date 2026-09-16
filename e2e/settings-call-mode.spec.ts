import { expect, test } from '@playwright/test';
import { findLeadId, signIn, waitForMockDialer } from './helpers';

/** CALL_MODE_STORAGE_KEY in src/lib/dialer/preference.ts; spelled out to keep e2e free of app imports. */
const CALL_MODE_STORAGE_KEY = 'fmq.callMode';

// Read-only for the database: the call mode is a per-device preference in localStorage.
// This lead is not touched by any other spec, so its CALL button is never in a "Do Not Contact" state.
const LEAD = 'Brightside Family Dentistry';

test('Call mode: Always phone turns CALL into a tel: link, Auto restores in-app calling', async ({ page }) => {
  await signIn(page, 'alex');
  const leadId = await findLeadId(page, LEAD);

  const openLead = async () => {
    await page.goto(`/leads/${leadId}`);
    await expect(page.getByRole('heading', { level: 1, name: LEAD })).toBeVisible();
  };
  const callButton = page.getByRole('button', { name: `Call ${LEAD}` }).filter({ visible: true });
  const callLink = page.getByRole('link', { name: `Call ${LEAD}` }).filter({ visible: true });

  // Default (Auto) on a desktop browser with the mock driver ready: the call runs in the CRM.
  await openLead();
  await waitForMockDialer(page);
  await expect(callButton).toHaveAttribute('data-call-mode', 'in-app');
  await expect(callLink).toHaveCount(0);

  const openSettings = async () => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'Call mode' })).toBeVisible();
  };
  const alwaysPhone = page.getByRole('radio', { name: /^Always phone/ });
  const auto = page.getByRole('radio', { name: /^Auto/ });

  await openSettings();
  await alwaysPhone.click();
  await expect(alwaysPhone).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), CALL_MODE_STORAGE_KEY)).toBe('phone');

  await openLead();
  await expect(callLink).toHaveAttribute('data-call-mode', 'tel');
  await expect(callLink).toHaveAttribute('href', /^tel:\+1\d{10}$/);
  await expect(callButton).toHaveCount(0);

  await openSettings();
  await expect(alwaysPhone).toBeChecked();
  await auto.click();
  await expect(auto).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), CALL_MODE_STORAGE_KEY)).toBe('auto');

  await openLead();
  await waitForMockDialer(page);
  await expect(callButton).toHaveAttribute('data-call-mode', 'in-app');
  await expect(callLink).toHaveCount(0);
});
