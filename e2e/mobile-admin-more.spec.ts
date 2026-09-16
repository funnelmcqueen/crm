import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The admin navigation has eight entries and the phone tab bar holds five, so Agents, Phone Numbers,
 * Reports and Settings exist only behind the "More" sheet (ARCHITECTURE 8). On a phone that sheet is
 * the only route to them, which makes it the one thing that must not break.
 *
 * Read-only: this spec navigates and asserts, so it shares the admin with the specs that write.
 */
const OVERFLOW: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'Agents', path: '/admin/agents' },
  { label: 'Phone Numbers', path: '/admin/phone-numbers' },
  { label: 'Reports', path: '/admin/reports' },
  { label: 'Settings', path: '/settings' },
];

/** The tabs that fit on the bar. */
const TABS = ['Dashboard', 'All Leads', 'Pipeline', 'Follow-ups'] as const;

function bottomNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

async function openMoreSheet(page: Page): Promise<Locator> {
  await bottomNav(page).getByRole('button', { name: 'More' }).click();
  const sheet = page.getByRole('dialog').filter({ visible: true });
  await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible();
  return sheet;
}

test('admin reaches Agents, Phone Numbers, Reports and Settings through the mobile More sheet', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/dashboard');

  const nav = bottomNav(page);
  await expect(nav).toBeVisible();
  // The desktop sidebar is not what is being tested: on a phone it must not be rendered at all.
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toHaveCount(0);

  // Matched by substring, not exactly: the Follow-ups tab renders the unheard-voicemail badge before
  // its label, so its accessible name reads "1 Follow-ups".
  for (const label of TABS) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
  // The overflow entries are genuinely absent from the bar, not just visually hidden behind it.
  for (const { label } of OVERFLOW) {
    await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
  }

  for (const { label, path } of OVERFLOW) {
    const sheet = await openMoreSheet(page);
    await sheet.getByRole('link', { name: label }).click();
    await page.waitForURL((url) => url.pathname === path);
    // The page really rendered (an admin route that 404s would show the not-found page instead).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('This page could not be found');
    // Choosing a destination closes the sheet.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }

  // Standing on Settings, the sheet marks it as the current section.
  const sheet = await openMoreSheet(page);
  await expect(sheet.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
});
