"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  deleteLead,
  markVoicemailHeard,
  reassignLead,
  setNextFollowUp,
  updateLeadDetails,
  updateLeadNotes,
  updateLeadStatus,
  type LeadRecord,
  type SetFollowUpResult,
} from "@/server/services/leads";
import type { LeadStatus } from "@/lib/domain/statuses";

// Thin wrappers: the services validate every argument with Zod and check the session and role.

export async function updateLeadStatusAction(
  leadId: string,
  status: string,
): Promise<ActionResult<{ id: string; status: LeadStatus }>> {
  const result = await runAction(async () => updateLeadStatus(await getActionContext(), leadId, status));
  if (result.ok) refresh();
  return result;
}

export async function updateLeadNotesAction(
  leadId: string,
  notes: string | null,
): Promise<ActionResult<{ id: string; notes: string | null }>> {
  const result = await runAction(async () => updateLeadNotes(await getActionContext(), leadId, notes));
  if (result.ok) refresh();
  return result;
}

export async function setNextFollowUpAction(
  leadId: string,
  dueAtIso: string,
  note?: string | null,
): Promise<ActionResult<SetFollowUpResult>> {
  const result = await runAction(async () => setNextFollowUp(await getActionContext(), leadId, dueAtIso, note));
  if (result.ok) refresh();
  return result;
}

export async function markVoicemailHeardAction(callId: string): Promise<ActionResult<{ callId: string }>> {
  const result = await runAction(async () => markVoicemailHeard(await getActionContext(), callId));
  if (result.ok) refresh();
  return result;
}

export interface LeadDetailsForm {
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  city: string;
  state: string;
  country: string;
  source: string;
}

export async function updateLeadDetailsAction(
  leadId: string,
  fields: Partial<LeadDetailsForm>,
): Promise<ActionResult<LeadRecord>> {
  const result = await runAction(async () => updateLeadDetails(await getActionContext(), leadId, fields));
  if (result.ok) refresh();
  return result;
}

export async function reassignLeadAction(
  leadId: string,
  toUserId: string | null,
): Promise<ActionResult<{ id: string; assignedTo: string | null }>> {
  const result = await runAction(async () => reassignLead(await getActionContext(), leadId, toUserId));
  if (result.ok) refresh();
  return result;
}

/** Redirects to /leads on success; returns the failure otherwise. */
export async function deleteLeadAction(leadId: string): Promise<ActionResult<{ id: string }>> {
  const result = await runAction(async () => deleteLead(await getActionContext(), leadId));
  if (result.ok) redirect("/leads");
  return result;
}
