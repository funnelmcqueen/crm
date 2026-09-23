import { describe, expect, it, vi } from "vitest";
import { canStartManualDial, requestManualCallId } from "@/lib/dialer/manual-dial";
import { INITIAL_DIALER_STATE, dialerReducer } from "@/lib/dialer/state";
import { EMPTY_OUTCOME_FORM, buildLogCallPayload } from "@/lib/dialer/outcome-form";
import { wrapUpDraftSchema } from "@/lib/dialer/workspace-drafts";

const CALL = "22222222-2222-4222-8222-222222222222";
const target = { phone: "(212) 555-0123", label: "+1 (212) 555-0123" };

describe("manual dial request", () => {
  it.each(["IN_APP", "TEL"] as const)("creates a %s row using only the entered phone and mode", async (mode) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ callId: CALL }), { status: 200 }));
    expect(await requestManualCallId(target, mode, fetcher)).toEqual({ ok: true, callId: CALL });
    expect(fetcher).toHaveBeenCalledWith("/api/calls/manual-outbound", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: target.phone, mode }),
    });
  });

  it("refuses invalid IDs and endpoint failures before a call can start", async () => {
    const malformed = vi.fn(async () => new Response(JSON.stringify({ callId: "bad" }), { status: 200 }));
    expect(await requestManualCallId(target, "TEL", malformed)).toMatchObject({ ok: false });
    const failed = vi.fn(async () => new Response(JSON.stringify({ reason: "call_in_progress" }), { status: 409 }));
    expect(await requestManualCallId(target, "IN_APP", failed)).toEqual({
      ok: false, status: 409, message: "You already have a call in progress",
    });
    const offline = vi.fn(async () => { throw new Error("offline"); });
    expect(await requestManualCallId(target, "TEL", offline)).toMatchObject({ ok: false });
  });

  it("ignores starts during recovery or any active dialer phase", () => {
    const preparing = dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject: { leadId: null, label: target.label } });
    const pending = dialerReducer(INITIAL_DIALER_STATE, {
      type: "TEL_START", leadId: null, callId: CALL, label: target.label,
      clientRequestId: "33333333-3333-4333-8333-333333333333", startedAt: 50,
    });
    expect(canStartManualDial(INITIAL_DIALER_STATE, false)).toBe(true);
    expect(canStartManualDial(INITIAL_DIALER_STATE, true)).toBe(false);
    expect(canStartManualDial(preparing, false)).toBe(false);
    expect(canStartManualDial(pending, false)).toBe(false);
  });

  it("keeps the manual in-app lifecycle leadless through outcome logging", () => {
    const preparing = dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject: { leadId: null, label: target.label } });
    const created = dialerReducer(preparing, { type: "OUTBOUND_CREATED", callId: CALL });
    const ringing = dialerReducer(created, { type: "RINGING" });
    const connected = dialerReducer(ringing, { type: "CONNECTED", at: 100 });
    const wrapped = dialerReducer(connected, { type: "DISCONNECTED", reason: "completed" });
    expect(wrapped).toMatchObject({ kind: "wrap-up", leadId: null, callId: CALL, mode: "IN_APP" });
    if (wrapped.kind !== "wrap-up") throw new Error("expected wrap-up");
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED" }, { ...wrapped, timezone: "UTC", now: new Date() }))
      .toEqual({ ok: true, payload: { outcome: "CONNECTED", leadId: null, callId: CALL } });
  });

  it("accepts manual phone wrap-up recovery only with a server call ID", () => {
    const draft = { leadId: null, callId: CALL, clientRequestId: null, mode: "TEL", endReason: "completed",
      preselectedOutcome: null, label: target.label };
    expect(wrapUpDraftSchema.safeParse(draft).success).toBe(true);
    expect(wrapUpDraftSchema.safeParse({ ...draft, callId: null }).success).toBe(false);
  });
});
