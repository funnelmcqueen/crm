"use server";

import { refresh } from "next/cache";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  changePassword,
  requestEmailChange,
  updateAgentTarget,
  updateCompanySettings,
  updateOwnName,
  type ChangePasswordInput,
  type CompanySettings,
  type CompanySettingsInput,
  type EmailChangeResult,
} from "@/server/services/settings";

// Thin wrappers: the services validate every argument with Zod and check the session and role.

export async function updateOwnNameAction(name: string): Promise<ActionResult<{ name: string }>> {
  const result = await runAction(async () => updateOwnName(await getActionContext(), name));
  if (result.ok) refresh();
  return result;
}

export async function changePasswordAction(input: ChangePasswordInput): Promise<ActionResult<{ changed: true }>> {
  return runAction(async () => changePassword(await getActionContext(), input));
}

export async function requestEmailChangeAction(newEmail: string): Promise<ActionResult<EmailChangeResult>> {
  const result = await runAction(async () => requestEmailChange(await getActionContext(), newEmail));
  if (result.ok) refresh();
  return result;
}

export async function updateCompanySettingsAction(input: CompanySettingsInput): Promise<ActionResult<CompanySettings>> {
  const result = await runAction(async () => updateCompanySettings(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function updateAgentTargetAction(
  userId: string,
  target: number,
): Promise<ActionResult<{ userId: string; dailyCallTarget: number }>> {
  const result = await runAction(async () => updateAgentTarget(await getActionContext(), userId, target));
  if (result.ok) refresh();
  return result;
}
