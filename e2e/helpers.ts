import { expect, type Page } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS, type UserKey } from '../scripts/lib/seed-data';

export const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const LEAD_PATH = new RegExp(`^/leads/(${UUID_PATTERN.source})$`);

export function seedEmail(key: Exclude<UserKey, 'dana'>): string {
  const user = SEED_USERS.find((candidate) => candidate.key === key);
  if (!user) throw new Error(`unknown seed user ${key}`);
  return user.email;
}

/** Signs in through the real login form and waits until the app has redirected away from /login. */
export async function signIn(page: Page, key: Exclude<UserKey, 'dana'>): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(seedEmail(key));
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** The lead id in a /leads/<id> URL, or null for any other URL. */
export function leadIdFromUrl(url: string | URL): string | null {
  const match = LEAD_PATH.exec(new URL(url).pathname);
  return match ? match[1] : null;
}

export function isNextFlowLeadUrl(url: URL, notLeadId?: string): boolean {
  const id = leadIdFromUrl(url);
  return id !== null && id !== notLeadId && url.searchParams.get('flow') === 'next';
}

/** Finds a lead in the signed-in user's list by business name and returns its id. */
export async function findLeadId(page: Page, businessName: string): Promise<string> {
  await page.goto(`/leads?q=${encodeURIComponent(businessName)}`);
  const link = page.locator('main a[href^="/leads/"]').filter({ hasText: businessName, visible: true }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const id = href ? leadIdFromUrl(new URL(href, page.url())) : null;
  if (!id) throw new Error(`no lead link for ${businessName} (href ${href})`);
  return id;
}

/** Resolves once the mock in-app driver has been created (DIALER_DRIVER=mock installs window.__fmqMockDialer). */
export async function waitForMockDialer(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__fmqMockDialer !== undefined);
}
