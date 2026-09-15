import { expect, test } from '@playwright/test';
import { isNextFlowLeadUrl, signIn } from './helpers';

declare global {
  interface Window {
    __e2eSignOutMarker?: string;
  }
}

// Read-only for the database: a tapped tel: call writes nothing until it is logged.
test('sign-out leaves no call data or in-memory state of the previous user in the tab', async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener(
      'click',
      (event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href^="tel:"]') : null;
        if (anchor) event.preventDefault();
      },
      true,
    );
  });

  await signIn(page, 'casey');
  await page.getByRole('link', { name: 'Next lead' }).filter({ visible: true }).first().click();
  await page.waitForURL((url) => isNextFlowLeadUrl(url));
  const businessName = (await page.getByRole('heading', { level: 1 }).innerText()).trim();

  await page.getByRole('link', { name: `Call ${businessName}` }).filter({ visible: true }).click();
  await expect(page.getByRole('region', { name: 'Phone call in progress' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('fmq.pendingTel'))).toContain(businessName);

  await page.evaluate(() => {
    window.__e2eSignOutMarker = 'casey-session';
  });
  await page.getByRole('button', { name: /^Account menu for / }).filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // The business name of the unlogged call is gone, and a full page load dropped every in-memory store.
  expect(await page.evaluate(() => sessionStorage.getItem('fmq.pendingTel'))).toBeNull();
  expect(await page.evaluate(() => window.__e2eSignOutMarker)).toBeUndefined();
});
