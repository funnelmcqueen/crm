"use server";

import { refresh } from "next/cache";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  bulkReassign,
  countReassignableLeads,
  createAgent,
  reassignSelected,
  setAgentActive,
  setInAppCalling,
  updateAgentProfile,
  type AgentProfileSummary,
  type BulkReassignInput,
  type CreateAgentInput,
  type CreateAgentResult,
  type SetAgentActiveResult,
  type UpdateAgentProfileInput,
} from "@/server/services/agents";

// Thin wrappers: the services validate every argument with Zod and require an active admin session.

export async function createAgentAction(input: CreateAgentInput): Promise<ActionResult<CreateAgentResult>> {
  const result = await runAction(async () => createAgent(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function setAgentActiveAction(userId: string, active: boolean): Promise<ActionResult<SetAgentActiveResult>> {
  const result = await runAction(async () => setAgentActive(await getActionContext(), userId, active));
  if (result.ok) refresh();
  return result;
}

export async function setInAppCallingAction(
  userId: string,
  enabled: boolean,
): Promise<ActionResult<{ userId: string; inAppCallingEnabled: boolean }>> {
  const result = await runAction(async () => setInAppCalling(await getActionContext(), userId, enabled));
  if (result.ok) refresh();
  return result;
}

export async function updateAgentProfileAction(
  userId: string,
  fields: UpdateAgentProfileInput,
): Promise<ActionResult<AgentProfileSummary>> {
  const result = await runAction(async () => updateAgentProfile(await getActionContext(), userId, fields));
  if (result.ok) refresh();
  return result;
}

export async function countReassignableLeadsAction(
  fromUserId: string,
  statuses?: string[],
): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => countReassignableLeads(await getActionContext(), fromUserId, statuses));
}

export async function bulkReassignAction(input: BulkReassignInput): Promise<ActionResult<{ count: number }>> {
  const result = await runAction(async () => bulkReassign(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function reassignSelectedAction(
  leadIds: string[],
  toUserId: string | null,
): Promise<ActionResult<{ count: number }>> {
  const result = await runAction(async () => reassignSelected(await getActionContext(), leadIds, toUserId));
  if (result.ok) refresh();
  return result;
}
