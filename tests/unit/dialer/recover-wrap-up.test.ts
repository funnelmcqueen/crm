import { describe, expect, it } from "vitest";
import { recoverWrapUp, wrapUpForRecovery } from "@/lib/dialer/recover-wrap-up";
import type { WrapUp } from "@/lib/dialer/state";
import type { ActionResult } from "@/server/errors";
import type { CallStatusResult, IncomingCallContext } from "@/server/services/calls";
const draft: WrapUp = { callId: "call", leadId: "lead", label: "Old label", mode: "IN_APP", clientRequestId: null, endReason: "completed", preselectedOutcome: null };
const status: ActionResult<CallStatusResult> = { ok: true, data: { callId: "call", callStatus: "completed", outcome: null, durationSeconds: 32 } };
const context: ActionResult<IncomingCallContext> = { ok: true, data: { callId: "call", lead: { leadId: "lead", businessName: "Current label", contactName: null, status: "NEW" } } };
describe("unfinished call recovery", () => {
  it("keeps a created call ID even before the driver finishes connecting", () => {
    expect(wrapUpForRecovery({ kind: "preparing", subject: { leadId: "lead", label: "Business" }, callId: "call" }))
      .toMatchObject({ callId: "call", leadId: "lead", label: "Business", mode: "IN_APP", preselectedOutcome: null });
    expect(wrapUpForRecovery({ kind: "preparing", subject: { leadId: "lead", label: "Business" }, callId: null })).toBeNull();
  });
  it("retains the original call identity and refreshes its label after access validation", () => {
    expect(recoverWrapUp(draft, status, context)).toEqual({ kind: "restore", wrapUp: { ...draft, label: "Current label" } });
  });
  it("does not restore a reassigned, inaccessible or already logged call", () => {
    expect(recoverWrapUp(draft, { ok: false, error: { code: "not_found", message: "Not found" } }, context)).toEqual({ kind: "discard" });
    expect(recoverWrapUp(draft, { ok: true, data: { ...status.data, outcome: "CONNECTED" } }, context)).toEqual({ kind: "discard" });
  });
  it("preserves an unverified draft on transient failure for a later retry", () => {
    expect(recoverWrapUp(draft, { ok: false, error: { code: "unavailable", message: "Offline" } }, context)).toEqual({ kind: "retry" });
  });
  it("allows an admin's accessible call whose lead is not assigned to them", () => {
    expect(recoverWrapUp(draft, status, { ok: true, data: { callId: "call", lead: null } })).toEqual({ kind: "restore", wrapUp: draft });
  });
  it("rejects a response for a different call", () => {
    expect(recoverWrapUp(draft, { ok: true, data: { ...status.data, callId: "other" } }, context)).toEqual({ kind: "discard" });
  });
});
