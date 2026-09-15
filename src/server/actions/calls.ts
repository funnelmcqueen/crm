"use server";

import { getActionContext, requireActive } from "@/server/context";
import { runAction, type ActionResult } from "@/server/errors";
import {
  getCallStatus,
  getIncomingCallContext,
  logCall,
  type CallStatusResult,
  type IncomingCallContext,
  type LogCallResult,
} from "@/server/services/calls";
import { unheardVoicemailCount } from "@/server/services/voicemails";

// Inputs are typed `unknown` on purpose: the services validate them with Zod.

export async function logCallAction(input: unknown): Promise<ActionResult<LogCallResult>> {
  return runAction(async () => logCall(requireActive(await getActionContext()), input));
}

export async function getCallStatusAction(callId: unknown): Promise<ActionResult<CallStatusResult>> {
  return runAction(async () => getCallStatus(requireActive(await getActionContext()), callId));
}

export async function getIncomingCallContextAction(callId: unknown): Promise<ActionResult<IncomingCallContext>> {
  return runAction(async () => getIncomingCallContext(requireActive(await getActionContext()), callId));
}

export async function unheardVoicemailCountAction(): Promise<ActionResult<number>> {
  return runAction(async () => unheardVoicemailCount(requireActive(await getActionContext())));
}
