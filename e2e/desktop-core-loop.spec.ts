import { expect, test } from '@playwright/test';
import { findLeadId, isNextFlowLeadUrl, signIn, waitForMockDialer } from './helpers';

const START_LEAD = 'Windy City Heating & Cooling';
/** Mock driver ring time (src/lib/dialer/drivers/mock.ts) plus margin: long enough for an auto-started call to show. */
const NO_AUTO_CALL_WINDOW_MS = 2_500;

// Blair is used only by this spec, so logging calls on her leads cannot disturb the others.
test('desktop core loop: CALL -> in-call bar -> hang up -> outcome sheet -> Save & Next', async ({ page }) => {
  const outboundRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/calls/outbound') {
      outboundRequests.push(page.url());
    }
  });

  await signIn(page, 'blair');
  const firstLeadId = await findLeadId(page, START_LEAD);
  await page.goto(`/leads/${firstLeadId}`);
  await expect(page.getByRole('heading', { level: 1, name: START_LEAD })).toBeVisible();
  await waitForMockDialer(page);

  const callButton = page.getByRole('button', { name: `Call ${START_LEAD}` }).filter({ visible: true });
  await expect(callButton).toHaveAttribute('data-call-mode', 'in-app');
  await expect(callButton).toBeEnabled();
  await callButton.click();

  const bar = page.getByRole('region', { name: 'Active call' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(START_LEAD);
  const timer = bar.getByLabel('Call duration');
  await expect(timer).toHaveText(/^\d+:\d{2}$/);
  await expect(timer).not.toHaveText('0:00');
  expect(await page.evaluate(() => window.__fmqMockDialer?.snapshot().connected)).toBe(true);
  expect(outboundRequests).toHaveLength(1);

  await bar.getByRole('button', { name: 'Hang up' }).click();
  await expect(bar).toBeHidden();

  const sheet = page.getByRole('dialog', { name: 'Log call' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(START_LEAD);
  await sheet.getByLabel('Notes (optional)', { exact: true }).fill('Owner asked for a proposal.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Notes (optional)', { exact: true })).toHaveValue('Owner asked for a proposal.');
  await waitForMockDialer(page);
  await sheet.locator('button[data-outcome="CONNECTED"]').click();
  await page.route('**/*', async (route) => {
    if (route.request().headers()['next-action']) await route.abort('failed');
    else await route.continue();
  });
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText(/couldn't save/i);
  await expect(sheet.getByLabel('Notes (optional)', { exact: true })).toHaveValue('Owner asked for a proposal.');
  await page.unroute('**/*');
  await sheet.locator('button[data-outcome="NO_ANSWER"]').click();
  // Keyboard: Enter on a focused outcome chooses it (it must not save a different outcome), Enter again saves.
  const connected = sheet.locator('button[data-outcome="CONNECTED"]');
  await connected.focus();
  await page.keyboard.press('Enter');
  await expect(connected).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.locator('button[aria-checked="true"]')).toHaveCount(1);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('alert')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await page.waitForURL((url) => isNextFlowLeadUrl(url, firstLeadId));
  await expect(sheet).toBeHidden();

  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).not.toHaveText(START_LEAD);
  const nextName = (await heading.innerText()).trim();
  const nextCall = page.getByRole('button', { name: `Call ${nextName}` }).filter({ visible: true });
  await expect(nextCall).toHaveAttribute('data-call-mode', 'in-app');
  await expect(nextCall).toBeEnabled();
  await expect(nextCall).toHaveText(/CALL/);

  // Negative check: give an automatically started call time to appear before asserting that none did.
  await page.waitForTimeout(NO_AUTO_CALL_WINDOW_MS);
  await expect(page.getByRole('region', { name: 'Active call' })).toHaveCount(0);
  await expect(nextCall).toBeEnabled();
  expect(await page.evaluate(() => window.__fmqMockDialer?.snapshot().inCall)).toBe(false);
  expect(outboundRequests).toHaveLength(1);
});
