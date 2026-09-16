import { expect, test, type Locator, type Page } from '@playwright/test';
import { UUID_PATTERN, signIn, waitForMockDialer } from './helpers';

/**
 * SPEC 17, the agent's callback half: listen to a voicemail, take the callback it came from, hang up
 * and log it.
 *
 * Alex owns the one unheard voicemail in the seed (an inbound call on Beacon Hill Law Group), and the
 * call row behind that voicemail is the one the incoming call is simulated with. Logging an outcome on
 * it also completes that lead's follow-ups (D22), which is why this spec runs in its own project after
 * every desktop spec: `pipeline-followups.spec.ts` asserts that same follow-up is still open.
 */
const VOICEMAIL_LEAD = 'Beacon Hill Law Group';
const UNKNOWN_CALLER = 'Unknown caller';
/** A call id that exists nowhere, so the incoming dialog cannot name a lead for it. */
const UNMATCHED_CALL_ID = '00000000-0000-4000-8000-0000000000ff';

function voicemailRow(page: Page): Locator {
  return page.locator('main li').filter({ hasText: VOICEMAIL_LEAD }).filter({ visible: true }).first();
}

async function simulateIncoming(page: Page, callId: string): Promise<void> {
  await page.evaluate((id) => window.__fmqMockDialer?.simulateIncoming(id), callId);
}

test('agent plays a voicemail, takes the callback, hangs up and logs it', async ({ page }) => {
  await signIn(page, 'alex');
  await page.goto('/follow-ups?tab=voicemails');
  await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();

  // --- the voicemail ----------------------------------------------------------------------------
  const row = voicemailRow(page);
  await expect(row).toBeVisible();
  await expect(row.getByText('Unheard')).toBeVisible();
  const leadHref = await row.getByRole('link', { name: VOICEMAIL_LEAD }).getAttribute('href');
  expect(leadHref).toMatch(new RegExp(`^/leads/${UUID_PATTERN.source}$`));

  // The audio never points at Twilio: it is streamed through the app's own route (SPEC 5, D13).
  const audio = row.locator('audio');
  await expect(audio).toHaveAttribute('src', new RegExp(`^/api/voicemail/${UUID_PATTERN.source}$`));
  const src = (await audio.getAttribute('src')) ?? '';
  const callId = src.slice('/api/voicemail/'.length);
  expect(callId).toMatch(UUID_PATTERN);

  // A user gesture first, so the browser's autoplay policy is not what is being tested here.
  await page.getByRole('heading', { level: 1 }).click();
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes(`/api/voicemail/${callId}`)),
    audio.evaluate((element: HTMLAudioElement) => element.play()),
  ]);
  // The route really served audio (in mock mode a generated WAV tone stands in for Twilio's recording).
  expect([200, 206]).toContain(response.status());
  expect(response.headers()['content-type'] ?? '').toMatch(/audio\//);

  await expect
    .poll(
      () =>
        audio.evaluate((element: HTMLAudioElement) => ({
          paused: element.paused,
          error: element.error?.code ?? null,
          playedSomething: element.currentTime > 0 || element.readyState >= 3,
        })),
      { message: 'the voicemail should be playing' },
    )
    .toEqual({ paused: false, error: null, playedSomething: true });

  // Playing it is what marks it heard, for its owner (D20).
  await expect(row.getByText('Unheard')).toHaveCount(0);

  // --- an incoming call the agent cannot place -----------------------------------------------------
  await waitForMockDialer(page);
  await simulateIncoming(page, UNMATCHED_CALL_ID);
  const unknownDialog = page.getByRole('dialog');
  await expect(unknownDialog).toContainText('Incoming call');
  await expect(unknownDialog.getByRole('heading', { name: UNKNOWN_CALLER })).toBeVisible();
  // Nothing about anyone's lead leaks into an unmatched call.
  await expect(unknownDialog).not.toContainText(VOICEMAIL_LEAD);
  await unknownDialog.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // --- the callback from the lead that left the voicemail -------------------------------------------
  await simulateIncoming(page, callId);
  const incoming = page.getByRole('dialog');
  await expect(incoming.getByRole('heading', { name: VOICEMAIL_LEAD })).toBeVisible();
  await incoming.getByRole('button', { name: 'Accept' }).click();

  const bar = page.getByRole('region', { name: 'Active call' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(VOICEMAIL_LEAD);
  expect(await page.evaluate(() => window.__fmqMockDialer?.snapshot().connected)).toBe(true);

  await bar.getByRole('button', { name: 'Hang up' }).click();
  await expect(bar).toBeHidden();

  // --- log the outcome ------------------------------------------------------------------------------
  const sheet = page.getByRole('dialog', { name: 'Log call' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(VOICEMAIL_LEAD);
  const connected = sheet.locator('button[data-outcome="CONNECTED"]');
  await connected.click();
  await expect(connected).toHaveAttribute('aria-checked', 'true');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => window.__fmqMockDialer?.snapshot().inCall)).toBe(false);

  // The outcome landed on the lead: an answered callback moves it to Connected (SPEC 6).
  await page.goto(`/leads?q=${encodeURIComponent(VOICEMAIL_LEAD)}`);
  const listRow = page
    .locator('main tr, main li')
    .filter({ has: page.getByRole('link', { name: VOICEMAIL_LEAD }) })
    .filter({ visible: true })
    .first();
  await expect(listRow).toContainText('Connected');
});
