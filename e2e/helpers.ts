import { expect, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import { SEED_PASSWORD, SEED_USERS, type UserKey } from '../scripts/lib/seed-data';

export const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const LEAD_PATH = new RegExp(`^/leads/(${UUID_PATTERN.source})$`);

export function seedEmail(key: Exclude<UserKey, 'dana'>): string {
  const user = SEED_USERS.find((candidate) => candidate.key === key);
  if (!user) throw new Error(`unknown seed user ${key}`);
  return user.email;
}

/** Fills and submits the login form. Does not wait for the outcome, so failures can be asserted too. */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in through the real login form and waits until the app has redirected away from /login. */
export async function signIn(page: Page, key: Exclude<UserKey, 'dana'>): Promise<void> {
  await submitLogin(page, seedEmail(key), SEED_PASSWORD);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Signs in with credentials that are not part of the seed (an agent created during a test). */
export async function signInWith(page: Page, email: string, password: string): Promise<void> {
  await submitLogin(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Address in the seed's fictional domain that no previous run can have used. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@funnelmcqueen.test`;
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

/**
 * The lead total a list page prints in its header ("45 leads in total", "12 leads assigned to you",
 * "43 leads match"). Read from the page so a test compares the export against what the UI claims.
 */
export async function listedLeadTotal(page: Page): Promise<number> {
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
  // The header description is a text node, not an element of its own, so match on the region's text.
  let total = -1;
  await expect
    .poll(async () => {
      const match = /([\d,]+)\s+leads?\s+(?:in total|assigned to you|match)/.exec(await main.innerText());
      total = match ? Number(match[1].replace(/,/g, '')) : -1;
      return total;
    })
    .toBeGreaterThanOrEqual(0);
  return total;
}

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
  text: string;
}

/** Parses CSV text (BOM stripped; CRLF, quoted cells and embedded newlines handled by papaparse). */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, '');
  const parsed = Papa.parse<Record<string, string>>(clean, { header: true, skipEmptyLines: 'greedy' });
  if (parsed.errors.length > 0) {
    throw new Error(`CSV parse errors: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  return { headers: parsed.meta.fields ?? [], rows: parsed.data, text: clean };
}

export async function readCsvFile(filePath: string): Promise<ParsedCsv> {
  return parseCsv(await readFile(filePath, 'utf8'));
}

export async function readCsvDownload(download: Download): Promise<ParsedCsv> {
  return parseCsv(await readFile(await download.path(), 'utf8'));
}
