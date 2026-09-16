"use server";

import { refresh } from "next/cache";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  addPhoneNumber,
  assignPhoneNumber,
  deactivatePhoneNumber,
  reactivatePhoneNumber,
  unassignPhoneNumber,
  type PhoneNumberRecord,
} from "@/server/services/phone-numbers";

// Thin wrappers: the services validate every argument with Zod and require an active admin.

export async function addPhoneNumberAction(input: {
  e164: string;
  label: string;
}): Promise<ActionResult<PhoneNumberRecord>> {
  const result = await runAction(async () => addPhoneNumber(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function assignPhoneNumberAction(id: string, userId: string): Promise<ActionResult<PhoneNumberRecord>> {
  const result = await runAction(async () => assignPhoneNumber(await getActionContext(), id, userId));
  if (result.ok) refresh();
  return result;
}

export async function unassignPhoneNumberAction(id: string): Promise<ActionResult<PhoneNumberRecord>> {
  const result = await runAction(async () => unassignPhoneNumber(await getActionContext(), id));
  if (result.ok) refresh();
  return result;
}

export async function deactivatePhoneNumberAction(id: string): Promise<ActionResult<PhoneNumberRecord>> {
  const result = await runAction(async () => deactivatePhoneNumber(await getActionContext(), id));
  if (result.ok) refresh();
  return result;
}

export async function reactivatePhoneNumberAction(id: string): Promise<ActionResult<PhoneNumberRecord>> {
  const result = await runAction(async () => reactivatePhoneNumber(await getActionContext(), id));
  if (result.ok) refresh();
  return result;
}
