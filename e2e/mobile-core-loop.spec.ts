import { expect, test } from '@playwright/test';
import { isNextFlowLeadUrl, leadIdFromUrl, signIn } from './helpers';

declare global {
  interface Window {
    __e2eTelTaps?: string[];
  }
}

// Casey is used only by this spec, so logging calls on her leads cannot disturb the others.
test.describe('mobile core loop (tel:)', () => {
  test.beforeEach(async ({ page }) => {
    // A real tel: navigation would leave the page (or open an OS handler). Record the tap and cancel only the
    // navigation; the capture listener runs before React's handler, which still sees the click.
    await page.addInitScript(() => {
      window.__e2eTelTaps = [];
      window.addEventListener(
        'click',
        (event) => {
          const anchor = event.target instanceof Element ? event.target.closest('a[href^="tel:"]') : null;
          if (!anchor) return;
          window.__e2eTelTaps?.push(anchor.getAttribute('href') ?? '');
          event.preventDefault();
        },
        true,
      );
    });
  });

  test('login -> Next Lead -> CALL via tel: -> log outcome -> Save & Next lands on another lead', async ({ page }) => {
    await signIn(page, 'casey');

    await page.getByRole('link', { name: 'Next lead' }).filter({ visible: true }).first().click();
    await page.waitForURL((url) => isNextFlowLeadUrl(url));
    const firstLeadId = leadIdFromUrl(page.url());
    expect(firstLeadId).not.toBeNull();
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
    const businessName = (await heading.innerText()).trim();

    const callLink = page.getByRole('link', { name: `Call ${businessName}` }).filter({ visible: true });
    await expect(callLink).toHaveCount(1);
    await expect(callLink).toHaveAttribute('data-call-mode', 'tel');
    await expect(callLink).toHaveAttribute('href', /^tel:\+1\d{10}$/);
    const href = await callLink.getAttribute('href');

    await callLink.click();
    expect(await page.evaluate(() => window.__e2eTelTaps)).toEqual([href]);
    await expect(page.getByRole('region', { name: 'Phone call in progress' })).toBeVisible();

    // Emulate leaving for the phone app and coming back. The dialer ignores returns within 1s of the tap,
    // so keep returning until the outcome sheet opens.
    const sheet = page.getByRole('dialog', { name: 'Log call' });
    await expect(async () => {
      await page.evaluate(() => {
        const setVisibility = (state: DocumentVisibilityState) => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        setVisibility('hidden');
        setVisibility('visible');
      });
      await expect(sheet).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(sheet).toContainText(businessName);

    // SPEC 11 touch targets: the sheet's close control is at least 48px.
    const close = sheet.getByRole('button', { name: 'Close' });
    const closeBox = await close.boundingBox();
    expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(48);
    expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(48);

    const noAnswer = sheet.locator('button[data-outcome="NO_ANSWER"]');
    await noAnswer.click();
    await expect(noAnswer).toHaveAttribute('aria-checked', 'true');
    await sheet.getByRole('button', { name: '+ Add note' }).click();
    await sheet.getByLabel('Notes (optional)', { exact: true }).fill('Try the owner tomorrow.');
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Notes (optional)', { exact: true })).toHaveValue('Try the owner tomorrow.');
    await expect(noAnswer).toHaveAttribute('aria-checked', 'true');

    await sheet.getByRole('button', { name: 'Save & Next' }).click();
    await page.waitForURL((url) => isNextFlowLeadUrl(url, firstLeadId ?? undefined));
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(businessName);

    // Back to idle: the new lead's CALL is a tel: link again and nothing is pending.
    const nextName = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
    const nextCall = page.getByRole('link', { name: `Call ${nextName}` }).filter({ visible: true });
    await expect(nextCall).toHaveAttribute('href', /^tel:\+1\d{10}$/);
    await expect(page.getByRole('region', { name: 'Phone call in progress' })).toHaveCount(0);
  });
});
