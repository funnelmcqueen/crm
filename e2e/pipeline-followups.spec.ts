import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

// Alex owns this spec's writes. Moving a lead and completing a follow-up change no lead counts, so
// the read-only specs that share Alex (isolation, export) are unaffected.
const ALEX_TZ = 'America/New_York';

const DRAGGED_LEAD = 'Harbor Point Plumbing'; // seeded NEW
const MENU_MOVED_LEAD = 'Empire Roofing & Gutters'; // seeded TO_CALL
const KEYBOARD_MOVED_LEAD = 'Steinway Auto Care'; // seeded NO_ANSWER, so its card sits in To Call
const COMPLETED_FOLLOW_UP = 'Beacon Hill Law Group'; // seeded follow-up, due at seed time
const RESCHEDULED_FOLLOW_UP = 'Liberty Pest Control'; // seeded follow-up, one day overdue

function column(page: Page, key: string) {
  return page.locator(`section[data-column="${key}"]`);
}

function cardIn(page: Page, columnKey: string, businessName: string) {
  return column(page, columnKey).locator('li').filter({ hasText: businessName });
}

/**
 * Mouse drag for dnd-kit's MousePointerSensor: press the card's drag handle, move past the 8px
 * activation distance, then travel to the target column in small steps so the pointer events the
 * sensor listens for actually fire.
 */
async function dragCardToColumn(page: Page, businessName: string, toColumnKey: string): Promise<void> {
  const handle = page.getByRole('button', { name: `Drag ${businessName}` });
  await handle.scrollIntoViewIfNeeded();
  const target = column(page, toColumnKey);
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error(`no box for the drag handle or the ${toColumnKey} column`);

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 24, startY, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 120), { steps: 24 });
  await page.mouse.up();
}

/** Calendar parts of an instant in `tz`, via the ISO-ordered en-CA format. */
function zonedYmd(tz: string, at: number): { year: number; month: number; day: number } {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .split('-')
    .map(Number);
  return { year, month, day };
}

/**
 * What the app should print for a quick pick that is `daysAhead` local days from today at `hour`
 * o'clock in `tz` — e.g. "Wed, Sep 16, 9:00 AM". Computed here from Intl (not from the app's own
 * date helpers) so the assertion is an independent check of the time-zone maths.
 */
function expectedQuickPickLabel(tz: string, daysAhead: number, hour: number, now = Date.now()): string {
  const today = zonedYmd(tz, now);
  // Calendar arithmetic on a UTC noon anchor: immune to the DST shifts that break "+24h".
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + daysAhead, 12));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(target);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' }).format(target);
  const day = target.getUTCDate();
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
  // The app drops the year for dates in the current year.
  return target.getUTCFullYear() === today.year
    ? `${weekday}, ${month} ${day}, ${clock}`
    : `${month} ${day}, ${target.getUTCFullYear()}, ${clock}`;
}

test.describe('pipeline', () => {
  test('desktop: dragging a card to another column moves the lead, and the move survives a reload', async ({ page }) => {
    await signIn(page, 'alex');
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();

    await expect(cardIn(page, 'NEW', DRAGGED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'TO_CALL', DRAGGED_LEAD)).toHaveCount(0);

    await dragCardToColumn(page, DRAGGED_LEAD, 'TO_CALL');

    await expect(cardIn(page, 'TO_CALL', DRAGGED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'NEW', DRAGGED_LEAD)).toHaveCount(0);

    // Reload: the card is where the server says it is, not just where the optimistic update put it.
    await page.reload();
    await expect(cardIn(page, 'TO_CALL', DRAGGED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'NEW', DRAGGED_LEAD)).toHaveCount(0);
  });

  test('desktop: a keyboard drag moves a card to the next column', async ({ page }) => {
    await signIn(page, 'alex');
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();

    await expect(cardIn(page, 'TO_CALL', KEYBOARD_MOVED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'CONNECTED', KEYBOARD_MOVED_LEAD)).toHaveCount(0);

    // dnd-kit's KeyboardSensor, which is the only way to move a card without a pointer: focus the drag
    // handle, Space to pick the card up, the arrow keys to walk it across columns, Space to drop it.
    //
    // Each step waits for the announcement dnd-kit makes for screen readers rather than for a timeout.
    // That is also the only honest way to drive it: an arrow key sent before the pick-up has been
    // committed is swallowed, and the card is then dropped back on the column it started in.
    const overColumn = (label: string) => page.getByText(`${KEYBOARD_MOVED_LEAD} is over ${label}.`);
    const handle = page.getByRole('button', { name: `Drag ${KEYBOARD_MOVED_LEAD}` });
    await handle.scrollIntoViewIfNeeded();
    await handle.focus();
    await expect(handle).toBeFocused();

    await page.keyboard.press('Space');
    await expect(overColumn('To Call')).toBeAttached();
    await page.keyboard.press('ArrowRight');
    await expect(overColumn('Connected')).toBeAttached();
    await page.keyboard.press('Space');

    await expect(cardIn(page, 'CONNECTED', KEYBOARD_MOVED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'TO_CALL', KEYBOARD_MOVED_LEAD)).toHaveCount(0);
    // The board tells a screen reader what happened, which is the whole point of a keyboard drag.
    await expect(page.getByText(`${KEYBOARD_MOVED_LEAD} moved to Connected.`)).toBeAttached();

    // The status really changed, rather than the card only moving on screen.
    await page.reload();
    await expect(cardIn(page, 'CONNECTED', KEYBOARD_MOVED_LEAD)).toBeVisible();
    await expect(cardIn(page, 'TO_CALL', KEYBOARD_MOVED_LEAD)).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test('mobile: "Move to…" moves the lead, and the move survives a reload', async ({ page }) => {
      await signIn(page, 'alex');
      await page.goto('/pipeline');
      await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();

      const card = cardIn(page, 'TO_CALL', MENU_MOVED_LEAD);
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();

      await page.getByRole('button', { name: `Move ${MENU_MOVED_LEAD} to…` }).click();
      await page.getByRole('menuitem', { name: 'Proposal' }).click();

      await expect(cardIn(page, 'PROPOSAL', MENU_MOVED_LEAD)).toHaveCount(1);
      await expect(cardIn(page, 'TO_CALL', MENU_MOVED_LEAD)).toHaveCount(0);

      await page.reload();
      await expect(cardIn(page, 'PROPOSAL', MENU_MOVED_LEAD)).toHaveCount(1);
      await expect(cardIn(page, 'TO_CALL', MENU_MOVED_LEAD)).toHaveCount(0);
    });
  });
});

test.describe('follow-ups', () => {
  test('completing a follow-up removes it from Overdue and files it under Completed', async ({ page }) => {
    await signIn(page, 'alex');
    await page.goto('/follow-ups?tab=overdue');
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();

    const link = page.locator('main').getByRole('link', { name: COMPLETED_FOLLOW_UP }).filter({ visible: true });
    await expect(link.first()).toBeVisible();

    await page
      .getByRole('button', { name: `Complete follow-up for ${COMPLETED_FOLLOW_UP}` })
      .filter({ visible: true })
      .click();
    await expect(page.getByText(`Follow-up completed: ${COMPLETED_FOLLOW_UP}`)).toBeVisible();
    await expect(link).toHaveCount(0);

    // Fetched again from the server, not just hidden optimistically.
    await page.goto('/follow-ups?tab=overdue');
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();
    await expect(link).toHaveCount(0);

    await page.goto('/follow-ups?tab=completed');
    await expect(link.first()).toBeVisible();
  });

  test('rescheduling to Tomorrow 9am moves the follow-up to Upcoming at 9am in the agent time zone', async ({ page }) => {
    await signIn(page, 'alex');
    await page.goto('/follow-ups?tab=overdue');
    await expect(page.getByRole('heading', { level: 1, name: 'Follow-ups' })).toBeVisible();

    const expected = expectedQuickPickLabel(ALEX_TZ, 1, 9);

    await page
      .getByRole('button', { name: `Reschedule follow-up for ${RESCHEDULED_FOLLOW_UP}` })
      .filter({ visible: true })
      .click();
    const quickPick = page.getByRole('menuitem', { name: /^Tomorrow 9am/ });
    // The menu previews the time it will save, in Alex's time zone.
    await expect(quickPick).toContainText(expected);
    await quickPick.click();
    await expect(page.getByText(`Rescheduled to ${expected}`)).toBeVisible();

    await page.goto('/follow-ups?tab=upcoming');
    const row = page
      .locator('main tr, main li')
      .filter({ has: page.getByRole('link', { name: RESCHEDULED_FOLLOW_UP }) })
      .filter({ visible: true })
      .first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(expected);
    await expect(row).toContainText('Tomorrow');

    await page.goto('/follow-ups?tab=overdue');
    await expect(page.locator('main').getByRole('link', { name: RESCHEDULED_FOLLOW_UP })).toHaveCount(0);
  });
});
