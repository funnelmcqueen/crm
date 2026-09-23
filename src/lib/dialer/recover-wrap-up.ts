import type { ActionResult } from "@/server/errors";
import type { CallStatusResult, IncomingCallContext } from "@/server/services/calls";
import type { DialerState, WrapUp } from "./state";

export function wrapUpForRecovery(state: DialerState): WrapUp | null {
  if (state.kind === "wrap-up") return state;
  if ((state.kind === "preparing" || state.kind === "ringing" || state.kind === "in-call") && state.callId) {
    return { ...state.subject, callId: state.callId, clientRequestId: null,
      mode: "IN_APP", endReason: "failed", preselectedOutcome: null };
  }
  return null;
}

export type RecoveryDecision = { kind: "restore"; wrapUp: WrapUp } | { kind: "discard" } | { kind: "retry" };

/** No cached lead labels are displayed until the session can still read the call through RLS. */
export function recoverWrapUp(draft: WrapUp, status: ActionResult<CallStatusResult>, context: ActionResult<IncomingCallContext>): RecoveryDecision {
  if (!status.ok || !context.ok) {
    return [status, context].some((r) => !r.ok && ["not_found", "unauthorized", "forbidden"].includes(r.error.code))
      ? { kind: "discard" } : { kind: "retry" };
  }
  if (status.data.callId !== draft.callId || context.data.callId !== draft.callId || status.data.outcome !== null) return { kind: "discard" };
  // Incoming-context deliberately omits leads not assigned to the caller, even for an admin.
  // A successful status read still verifies admin access, so their own cached label is safe here.
  return { kind: "restore", wrapUp: { ...draft,
    leadId: context.data.lead?.leadId ?? draft.leadId,
    label: context.data.lead?.businessName ?? draft.label } };
}
