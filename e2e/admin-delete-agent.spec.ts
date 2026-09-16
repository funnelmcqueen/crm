import { expect, test, type Page } from '@playwright/test';
import { signIn, submitLogin, uniqueEmail } from './helpers';

/**
 * Deleting agents (DEVIATIONS D40). An agent without leads or open follow-ups is deleted from the Agents page,
 * disappears, can no longer sign in, and their email can be reused. An agent who still holds leads cannot be
 * deleted; the dialog hands off to Reassign leads instead.
 *
 * New agents are named "Zz…" so they sort after every seeded agent: the import spec picks the first three agents
 * in the split list by name. The blocked case only opens and closes dialogs on a seeded agent, so it changes no
 * shared data.
 */
test('admin deletes an agent without work, who can no longer sign in, and reuses their email', async ({ page, browser }) => {
  const email = uniqueEmail('zz-e2e-delete');
  const suffix = email.split('@')[0].slice(-6);
  const name = `Zz E2E Delete ${suffix}`;

  await signIn(page, 'admin');
  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();

  const password = await createAgentThroughUi(page, name, email);

  // --- delete -------------------------------------------------------------------------------
  await rowActions(page, name).click();
  await page.getByRole('menuitem', { name: 'Delete agent' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Delete ${name}?`);
  await expect(dialog).toContainText(/can.t sign in again/);
  await dialog.getByRole('button', { name: 'Delete agent' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`${name} was deleted`)).toBeVisible();
  await expect(rowActions(page, name)).toHaveCount(0);

  // --- the deleted agent's credentials no longer work ----------------------------------------
  const agentContext = await browser.newContext();
  try {
    const agentPage = await agentContext.newPage();
    await submitLogin(agentPage, email, password);
    await expect(agentPage.getByText('Invalid email or password')).toBeVisible();
    await expect(agentPage).toHaveURL(/\/login(\?|$)/);
  } finally {
    await agentContext.close();
  }

  // --- the address is free for a new agent ---------------------------------------------------
  const reusedName = `Zz E2E Reused ${suffix}`;
  await createAgentThroughUi(page, reusedName, email);
  await expect(rowActions(page, reusedName)).toBeVisible();
});

test('an agent who still has leads cannot be deleted, and the dialog offers to reassign them', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();

  await rowActions(page, 'Alex Rivera').click();
  await page.getByRole('menuitem', { name: 'Delete agent' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Alex Rivera still has work');
  await expect(dialog.getByRole('button', { name: 'Delete agent' })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Reassign leads' }).click();
  const reassign = page.getByRole('dialog');
  await expect(reassign).toContainText(/Reassign Alex Rivera.s leads/);
  await reassign.getByRole('button', { name: 'Cancel' }).click();
  await expect(reassign).toBeHidden();
  await expect(rowActions(page, 'Alex Rivera')).toBeVisible();
});

/** Creates an agent through the Create agent dialog and returns the one-time password. */
async function createAgentThroughUi(page: Page, name: string, email: string): Promise<string> {
  await page.getByRole('button', { name: 'Create agent' }).click();
  // Not filtered by text: the same dialog swaps its contents to "Agent created" once the form is submitted.
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('Name').fill(name);
  await createDialog.getByLabel('Email').fill(email);
  await createDialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(createDialog.getByText('Agent created')).toBeVisible();
  const password = (await createDialog.getByLabel('One-time password').innerText()).trim();
  expect(password.length).toBeGreaterThanOrEqual(12);
  await createDialog.getByRole('button', { name: 'Done' }).click();
  await expect(rowActions(page, name)).toBeVisible();
  return password;
}

/** The row's "…" menu button. The agent list renders a table and cards; only one of them is visible. */
function rowActions(page: Page, agentName: string) {
  return page.getByRole('button', { name: `Actions for ${agentName}` }).filter({ visible: true });
}
