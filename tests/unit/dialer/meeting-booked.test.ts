import { describe, expect, it } from "vitest";
import { INITIAL_DIALER_STATE, dialerReducer, type DialerAction, type DialerState } from "@/lib/dialer/state";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OTHER = "44444444-4444-4444-8444-444444444444";
const CALL = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const subject = { leadId: LEAD, label: "Acme Plumbing" };

function run(actions: DialerAction[], from: DialerState = INITIAL_DIALER_STATE): DialerState {
  return actions.reduce(dialerReducer, from);
}

const inCall = run([
  { type: "OUTBOUND_START", subject },
  { type: "OUTBOUND_CREATED", callId: CALL },
  { type: "RINGING" },
  { type: "CONNECTED", at: 1_000 },
]);

describe("MEETING_BOOKED", () => {
  it("opens the wrap-up with Appointment when a meeting was booked during the call", () => {
    const after = run([{ type: "MEETING_BOOKED", leadId: LEAD }, { type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(after).toMatchObject({ kind: "wrap-up", preselectedOutcome: "APPOINTMENT" });
  });

  it("ignores a booking for a different lead", () => {
    const before = run([{ type: "DISCONNECTED", reason: "completed" }], inCall);
    const after = run([{ type: "MEETING_BOOKED", leadId: OTHER }, { type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(after).toEqual(before);
  });

  it("switches an open wrap-up for that lead to Appointment", () => {
    const wrapUp = run([{ type: "DISCONNECTED", reason: "completed" }], inCall);
    expect(dialerReducer(wrapUp, { type: "MEETING_BOOKED", leadId: LEAD })).toMatchObject({ kind: "wrap-up", preselectedOutcome: "APPOINTMENT" });
  });

  it("carries a booking made while dialling on the phone into the wrap-up", () => {
    const after = run([
      { type: "TEL_START", leadId: LEAD, label: "Acme Plumbing", clientRequestId: REQ, startedAt: 5 },
      { type: "MEETING_BOOKED", leadId: LEAD },
      { type: "TEL_RETURNED" },
    ]);
    expect(after).toMatchObject({ kind: "wrap-up", mode: "TEL", preselectedOutcome: "APPOINTMENT" });
  });

  it("returns the same state when there is nothing to remember", () => {
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "MEETING_BOOKED", leadId: LEAD })).toBe(INITIAL_DIALER_STATE);
    const booked = dialerReducer(inCall, { type: "MEETING_BOOKED", leadId: LEAD });
    expect(dialerReducer(booked, { type: "MEETING_BOOKED", leadId: LEAD })).toBe(booked);
  });
});
