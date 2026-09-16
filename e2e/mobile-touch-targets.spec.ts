import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * SPEC 11: every interactive control is at least a 48px touch target, and no screen scrolls sideways.
 *
 * tests/unit/ui/touch-targets.test.ts guards the same rule by grepping the source, which cannot see
 * what the browser actually lays out. It is the weaker half of the pair: the checkbox, radio and switch
 * are 14-18px boxes whose real target is an absolutely positioned `::after`, so their size is arithmetic
 * between a utility class and a pseudo-element rather than anything a `min-h-12` grep would find. These
 * measure the boxes Chrome computes.
 *
 * Read-only: it signs in, opens one popover and reads geometry, so it shares Alex with the specs that
 * write to his rows.
 */
const MIN_TOUCH_PX = 48;

interface HitBox {
  name: string;
  w: number;
  h: number;
}

/**
 * The tappable box for each match: its border box, widened by an absolutely positioned `::after` with
 * negative insets. That pseudo-element is how the small controls reach 48px, so measuring the border box
 * alone would report a false failure.
 */
async function hitBoxes(page: Page, selector: string): Promise<HitBox[]> {
  return page.$$eval(selector, (elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      let w = rect.width;
      let h = rect.height;
      const after = getComputedStyle(element, '::after');
      if (after && after.content !== 'none' && after.position === 'absolute') {
        const px = (value: string) => (value.endsWith('px') ? Number.parseFloat(value) : 0);
        const extraW = -(px(after.left) + px(after.right));
        const extraH = -(px(after.top) + px(after.bottom));
        if (extraW > 0) w = rect.width + extraW;
        if (extraH > 0) h = rect.height + extraH;
      }
      return {
        name: element.id || element.getAttribute('aria-label') || element.tagName.toLowerCase(),
        w: Math.round(w),
        h: Math.round(h),
      };
    }),
  );
}

async function expectAllBigEnough(page: Page, selector: string, label: string): Promise<void> {
  const boxes = await hitBoxes(page, selector);
  expect(boxes.length, `${label}: nothing matched ${selector}, so this assertion would pass vacuously`).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.h, `${label} "${box.name}" height`).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    expect(box.w, `${label} "${box.name}" width`).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
  }
}

test('checkboxes, radios and switches are all at least 48px on a phone', async ({ page }) => {
  await signIn(page, 'alex');

  // 12 status checkboxes, the densest cluster of small controls in the app.
  await page.goto('/leads');
  await page.getByRole('button', { name: /^Status/ }).click();
  await expect(page.locator('[data-slot="checkbox"]').first()).toBeVisible();
  await expectAllBigEnough(page, '[data-slot="checkbox"]', 'status filter checkbox');
  await page.keyboard.press('Escape');

  // The three call-mode radios.
  await page.goto('/settings');
  await expect(page.locator('[data-slot="radio-group-item"]').first()).toBeVisible();
  await expectAllBigEnough(page, '[data-slot="radio-group-item"]', 'call mode radio');

  // "Show closed".
  await page.goto('/pipeline');
  await expect(page.locator('[data-slot="switch"]').first()).toBeVisible();
  await expectAllBigEnough(page, '[data-slot="switch"]', 'pipeline switch');
});

test('no agent screen scrolls sideways on a phone', async ({ page }) => {
  await signIn(page, 'alex');

  for (const path of ['/dashboard', '/leads', '/pipeline', '/follow-ups?tab=overdue', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Sub-pixel layout rounding can leave a 1px difference that no finger can find.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
