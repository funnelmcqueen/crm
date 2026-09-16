import { expect, test, type Page } from '@playwright/test';
import { signIn, signInWith, submitLogin, uniqueEmail } from './helpers';

/**
 * Creates an agent through the admin UI, signs in as them with the one-time password, disables them
 * and reactivates them. The agent's email is unique per run, so a re-run never collides.
 *
 * The name starts with "Zz" so the new agent sorts after every seeded agent: the import spec picks
 * the first three agents in the split list by name.
 */
test('admin creates an agent, the agent signs in, is disabled, and is reactivated', async ({ page, browser }) => {
  const email = uniqueEmail('zz-e2e-agent');
  const name = `Zz E2E Agent ${email.split('@')[0].slice(-6)}`;

  await signIn(page, 'admin');
  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();

  // --- create -------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Create agent' }).click();
  // Not filtered by text: the same dialog swaps its contents to "Agent created" once the form is submitted.
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Name').fill(name);
  await createDialog.getByLabel('Email').fill(email);
  await createDialog.getByRole('button', { name: 'Create agent' }).click();

  await expect(createDialog.getByText('Agent created')).toBeVisible();
  await expect(createDialog).toContainText(email);
  const password = (await createDialog.getByLabel('One-time password').innerText()).trim();
  expect(password.length).toBeGreaterThanOrEqual(12);
  await expect(createDialog.getByRole('alert')).toHaveCount(0); // no "could not be saved" warning
  await createDialog.getByRole('button', { name: 'Done' }).click();

  const row = rowActions(page, name);
  await expect(row).toBeVisible();

  // --- the new agent signs in and has no leads ----------------------------------------------
  const agentContext = await browser.newContext();
  try {
    const agentPage = await agentContext.newPage();
    await signInWith(agentPage, email, password);
    // Kept so the reactivation step below can try to replay this exact session (D31).
    const sessionCookies = await agentContext.cookies();
    expect(sessionCookies.length).toBeGreaterThan(0);
    await agentPage.goto('/leads');
    await expect(agentPage.getByRole('heading', { level: 1, name: 'My Leads' })).toBeVisible();
    await expect(agentPage.locator('main')).toContainText('0 leads assigned to you');
    await expect(agentPage.getByText('No leads yet')).toBeVisible();
    await expect(agentPage.locator('main a[href^="/leads/"]')).toHaveCount(0);
    // A brand new agent is an agent, not an admin.
    expect((await agentPage.goto('/admin/agents'))?.status()).toBe(404);

    // --- the admin disables them ------------------------------------------------------------
    await row.click();
    await page.getByRole('menuitem', { name: 'Disable agent' }).click();
    const disableDialog = page.getByRole('alertdialog');
    await expect(disableDialog).toContainText(`Disable ${name}?`);
    await disableDialog.getByRole('button', { name: 'Disable agent' }).click();
    await expect(disableDialog).toBeHidden();
    await expect(page.getByText(`${name} was disabled`)).toBeVisible();

    // --- the agent's next navigation lands on the login page --------------------------------
    // Either layer can catch it first, and they word the URL differently: src/proxy.ts rejects the
    // banned JWT and redirects to /login?next=…, while a session it still accepts reaches the page,
    // which signs the user out and redirects to /login?disabled=1. Both must land on the login form
    // with none of the app rendered.
    await agentPage.goto('/follow-ups');
    await expect(agentPage).toHaveURL(/\/login(\?|$)/);
    await expect(agentPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(agentPage.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(agentPage.getByRole('heading', { level: 1, name: 'Follow-ups' })).toHaveCount(0);

    // ...and signing in again fails, even with the right password.
    await agentContext.clearCookies();
    await submitLogin(agentPage, email, password);
    await expect(agentPage.getByText('Invalid email or password')).toBeVisible();
    await expect(agentPage).toHaveURL(/\/login(\?|$)/);

    // --- the admin reactivates them ---------------------------------------------------------
    await row.click();
    await page.getByRole('menuitem', { name: 'Reactivate agent' }).click();
    const reactivateDialog = page.getByRole('alertdialog');
    await expect(reactivateDialog).toContainText(`Reactivate ${name}?`);
    await reactivateDialog.getByRole('button', { name: 'Reactivate' }).click();
    await expect(reactivateDialog).toBeHidden();
    await expect(page.getByText(`${name} was reactivated`)).toBeVisible();

    // Disabling ended the sessions the agent already held, so lifting the ban does not revive them
    // (D31). Replaying the exact cookies from before the disable lands on the login form: without
    // that, src/proxy.ts would accept the old session and send it straight on to /dashboard.
    await agentContext.clearCookies();
    await agentContext.addCookies(sessionCookies);
    await agentPage.goto('/dashboard');
    await expect(agentPage).toHaveURL(/\/login(\?|$)/);
    await expect(agentPage.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(agentPage.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

    // Signing in again does work, so the account itself is usable.
    await agentContext.clearCookies();
    await signInWith(agentPage, email, password);
    await agentPage.goto('/leads');
    await expect(agentPage.getByRole('heading', { level: 1, name: 'My Leads' })).toBeVisible();
  } finally {
    await agentContext.close();
  }
});

/** The row's "…" menu button. The agent list renders a table and cards; only one of them is visible. */
function rowActions(page: Page, agentName: string) {
  return page.getByRole('button', { name: `Actions for ${agentName}` }).filter({ visible: true });
}
