"use server";

import { refresh } from "next/cache";
import type { BusinessType } from "@/lib/domain/business-type";
import { getActionContext } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  bookAppointment,
  cancelAppointment,
  getAgentAvailability,
  setLeadBusinessType,
  type AgentAvailability,
  type BookedAppointment,
} from "@/server/services/calendar-booking";

export interface BookAppointmentActionInput {
  leadId: string;
  start: string;
  note: string | null;
  clientRequestId: string;
  inCall: boolean;
}

export async function getAvailabilityAction(leadId: string): Promise<ActionResult<AgentAvailability>> {
  return runAction(async () => getAgentAvailability(await getActionContext(), leadId));
}

export async function bookAppointmentAction(input: BookAppointmentActionInput): Promise<ActionResult<BookedAppointment>> {
  const result = await runAction(async () => bookAppointment(await getActionContext(), input));
  if (result.ok) refresh();
  return result;
}

export async function cancelAppointmentAction(id: string): Promise<ActionResult<{ id: string }>> {
  const result = await runAction(async () => cancelAppointment(await getActionContext(), id));
  if (result.ok) refresh();
  return result;
}

export async function setLeadBusinessTypeAction(
  leadId: string,
  type: BusinessType | null,
): Promise<ActionResult<{ leadId: string; businessType: BusinessType | null }>> {
  const result = await runAction(async () => setLeadBusinessType(await getActionContext(), leadId, type));
  if (result.ok) refresh();
  return result;
}
