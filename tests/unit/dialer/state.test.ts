import { describe, expect, it } from "vitest";
import {
  INITIAL_DIALER_STATE,
  activeLeadId,
  dialerReducer,
  formatCallTimer,
  type DialerAction,
  type DialerState,
} from "@/lib/dialer/state";

const LEAD = "11111111-1111-4111-8111-111111111111";
const CALL = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const subject = { leadId: LEAD, label: "Acme Plumbing" };

function run(actions: DialerAction[], from: DialerState = INITIAL_DIALER_STATE): DialerState {
  return actions.reduce(dialerReducer, from);
}

const ringing = run([{ type: "OUTBOUND_START", subject }, { type: "OUTBOUND_CREATED", callId: CALL }, { type: "RINGING" }]);
const inCall = dialerReducer(ringing, { type: "CONNECTED", at: 1_000 });

describe("dialerReducer: outbound in-app", () => {
  it("walks idle -> preparing -> ringing -> in-call -> wrap-up -> idle", () => {
    const preparing = dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject });
    expect(preparing).toEqual({ kind: "preparing", subject, callId: null });
    expect(ringing).toMatchObject({ kind: "ringing", callId: CALL, warning: null });
    expect(inCall).toMatchObject({ kind: "in-call", callId: CALL, connectedAt: 1_000, muted: false, direction: "OUTBOUND" });

    const wrapUp = dialerReducer(inCall, { type: "DISCONNECTED", reason: "completed" });
    expect(wrapUp).toEqual({
      kind: "wrap-up",
      leadId: LEAD,
      callId: CALL,
      clientRequestId: null,
      mode: "IN_APP",
      endReason: "completed",
      preselectedOutcome: null,
      label: "Acme Plumbing",
    });
    expect(dialerReducer(wrapUp, { type: "WRAP_UP_DONE" })).toEqual(INITIAL_DIALER_STATE);
  });

  it.each(["busy", "no-answer", "failed"] as const)("preselects No Answer when a connected call ends as %s", (reason) => {
    expect(dialerReducer(inCall, { type: "DISCONNECTED", reason })).toMatchObject({ preselectedOutcome: "NO_ANSWER" });
  });

  it.each(["completed", "canceled"] as const)("preselects No Answer when a never-connected call ends as %s", (reason) => {
    expect(dialerReducer(ringing, { type: "DISCONNECTED", reason })).toMatchObject({
      kind: "wrap-up",
      preselectedOutcome: "NO_ANSWER",
    });
  });

  it("wraps up a call that disconnects before ringing once it has a call id", () => {
    const created = run([{ type: "OUTBOUND_START", subject }, { type: "OUTBOUND_CREATED", callId: CALL }]);
    expect(dialerReducer(created, { type: "DISCONNECTED", reason: "failed" })).toMatchObject({
      kind: "wrap-up",
      callId: CALL,
      preselectedOutcome: "NO_ANSWER",
    });
    expect(dialerReducer(created, { type: "CONNECTED", at: 5 })).toMatchObject({ kind: "in-call", connectedAt: 5 });
  });

  it("ignores events that do not belong to the current phase", () => {
    const preparing = dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject });
    expect(dialerReducer(preparing, { type: "RINGING" })).toBe(preparing);
    expect(dialerReducer(preparing, { type: "DISCONNECTED", reason: "completed" })).toBe(preparing);
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "CONNECTED", at: 1 })).toBe(INITIAL_DIALER_STATE);
    expect(dialerReducer(inCall, { type: "OUTBOUND_CREATED", callId: REQ })).toBe(inCall);
    expect(dialerReducer(inCall, { type: "CONNECTED", at: 99 })).toBe(inCall);
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "WRAP_UP_DONE" })).toBe(INITIAL_DIALER_STATE);
  });

  it("aborts back to idle only while preparing", () => {
    const preparing = dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject });
    expect(dialerReducer(preparing, { type: "OUTBOUND_ABORTED" })).toEqual(INITIAL_DIALER_STATE);
    expect(dialerReducer(inCall, { type: "OUTBOUND_ABORTED" })).toBe(inCall);
  });

  it("sets and clears warnings, and toggles mute", () => {
    const warned = dialerReducer(inCall, { type: "WARNING", message: "Poor connection" });
    expect(warned).toMatchObject({ warning: "Poor connection" });
    expect(dialerReducer(warned, { type: "WARNING", message: "" })).toMatchObject({ warning: null });
    expect(dialerReducer(ringing, { type: "WARNING", message: "Microphone not found" })).toMatchObject({
      warning: "Microphone not found",
    });
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "WARNING", message: "x" })).toBe(INITIAL_DIALER_STATE);

    const muted = dialerReducer(inCall, { type: "MUTED", muted: true });
    expect(muted).toMatchObject({ muted: true });
    expect(dialerReducer(muted, { type: "MUTED", muted: true })).toBe(muted);
    expect(dialerReducer(ringing, { type: "MUTED", muted: true })).toBe(ringing);
  });

  it("carries a ringing warning into the connected call", () => {
    const warned = dialerReducer(ringing, { type: "WARNING", message: "Poor connection" });
    expect(dialerReducer(warned, { type: "CONNECTED", at: 1 })).toMatchObject({ kind: "in-call", warning: "Poor connection" });
  });

  it("lets the server status override the preselected outcome during wrap-up only", () => {
    const wrapUp = dialerReducer(inCall, { type: "DISCONNECTED", reason: "completed" });
    expect(dialerReducer(wrapUp, { type: "PRESELECT_OUTCOME", outcome: "NO_ANSWER" })).toMatchObject({
      preselectedOutcome: "NO_ANSWER",
    });
    expect(dialerReducer(inCall, { type: "PRESELECT_OUTCOME", outcome: "NO_ANSWER" })).toBe(inCall);
  });
});

describe("dialerReducer: one active call", () => {
  const telPending = dialerReducer(INITIAL_DIALER_STATE, {
    type: "TEL_START",
    leadId: LEAD,
    label: "Acme Plumbing",
    clientRequestId: REQ,
    startedAt: 50,
  });
  const incoming = dialerReducer(INITIAL_DIALER_STATE, { type: "INCOMING", callId: CALL });
  const wrapUp = dialerReducer(inCall, { type: "DISCONNECTED", reason: "completed" });
  const busyStates: Array<[string, DialerState]> = [
    ["preparing", dialerReducer(INITIAL_DIALER_STATE, { type: "OUTBOUND_START", subject })],
    ["ringing", ringing],
    ["in-call", inCall],
    ["wrap-up", wrapUp],
    ["incoming", incoming],
    ["tel-pending", telPending],
  ];
  const starts: DialerAction[] = [
    { type: "OUTBOUND_START", subject: { leadId: "44444444-4444-4444-8444-444444444444", label: "Other" } },
    { type: "TEL_START", leadId: LEAD, label: "x", clientRequestId: REQ, startedAt: 1 },
    { type: "INCOMING", callId: null },
    {
      type: "RESTORE_WRAP_UP",
      wrapUp: { leadId: LEAD, callId: null, clientRequestId: REQ, mode: "TEL", endReason: "completed", preselectedOutcome: null, label: "x" },
    },
  ];

  for (const [name, state] of busyStates) {
    it(`refuses to start another call while ${name}`, () => {
      for (const action of starts) expect(dialerReducer(state, action)).toBe(state);
    });
  }

  it("ignores an incoming call while busy (the provider rejects it)", () => {
    expect(dialerReducer(inCall, { type: "INCOMING", callId: "55555555-5555-4555-8555-555555555555" })).toBe(inCall);
  });
});

describe("dialerReducer: tel", () => {
  const pending = dialerReducer(INITIAL_DIALER_STATE, {
    type: "TEL_START",
    leadId: LEAD,
    label: "Acme Plumbing",
    clientRequestId: REQ,
    startedAt: 50,
  });

  it("opens a TEL wrap-up with the client request id when the agent returns", () => {
    expect(pending).toMatchObject({ kind: "tel-pending", clientRequestId: REQ, startedAt: 50 });
    expect(dialerReducer(pending, { type: "TEL_RETURNED" })).toEqual({
      kind: "wrap-up",
      leadId: LEAD,
      callId: null,
      clientRequestId: REQ,
      mode: "TEL",
      endReason: "completed",
      preselectedOutcome: null,
      label: "Acme Plumbing",
    });
  });

  it("cancels back to idle", () => {
    expect(dialerReducer(pending, { type: "TEL_CANCELED" })).toEqual(INITIAL_DIALER_STATE);
    expect(dialerReducer(INITIAL_DIALER_STATE, { type: "TEL_RETURNED" })).toBe(INITIAL_DIALER_STATE);
  });

  it("restores a wrap-up after a reload from idle", () => {
    const restored = dialerReducer(INITIAL_DIALER_STATE, {
      type: "RESTORE_WRAP_UP",
      wrapUp: { leadId: LEAD, callId: null, clientRequestId: REQ, mode: "TEL", endReason: "completed", preselectedOutcome: null, label: "A" },
    });
    expect(restored).toMatchObject({ kind: "wrap-up", mode: "TEL", clientRequestId: REQ });
  });
});

describe("dialerReducer: incoming", () => {
  const incoming = dialerReducer(INITIAL_DIALER_STATE, { type: "INCOMING", callId: CALL });
  const lead = { leadId: LEAD, businessName: "Acme Plumbing", contactName: "Ann", status: "INTERESTED" as const };

  it("loads context for the ringing call only", () => {
    expect(incoming).toEqual({ kind: "incoming", callId: CALL, context: { status: "loading" } });
    const withLead = dialerReducer(incoming, { type: "INCOMING_CONTEXT", callId: CALL, context: { status: "lead", lead } });
    expect(withLead).toMatchObject({ context: { status: "lead", lead } });
    expect(dialerReducer(incoming, { type: "INCOMING_CONTEXT", callId: REQ, context: { status: "unknown" } })).toBe(incoming);
  });

  it("accepting own-lead call goes in-call with the lead; the wrap-up keeps the call and lead ids", () => {
    const withLead = dialerReducer(incoming, { type: "INCOMING_CONTEXT", callId: CALL, context: { status: "lead", lead } });
    const accepted = dialerReducer(withLead, { type: "INCOMING_ACCEPTED", at: 7 });
    expect(accepted).toMatchObject({
      kind: "in-call",
      direction: "INBOUND",
      callId: CALL,
      connectedAt: 7,
      subject: { leadId: LEAD, label: "Acme Plumbing" },
    });
    expect(dialerReducer(accepted, { type: "DISCONNECTED", reason: "completed" })).toMatchObject({
      kind: "wrap-up",
      leadId: LEAD,
      callId: CALL,
      mode: "IN_APP",
      preselectedOutcome: null,
    });
  });

  it("an unknown caller has no lead", () => {
    const unknown = dialerReducer(incoming, { type: "INCOMING_CONTEXT", callId: CALL, context: { status: "unknown" } });
    const accepted = dialerReducer(unknown, { type: "INCOMING_ACCEPTED", at: 7 });
    expect(accepted).toMatchObject({ subject: { leadId: null, label: "Unknown caller" } });
    expect(dialerReducer(accepted, { type: "DISCONNECTED", reason: "completed" })).toMatchObject({ leadId: null, callId: CALL });
  });

  it("context that arrives after accepting updates the call", () => {
    const accepted = dialerReducer(incoming, { type: "INCOMING_ACCEPTED", at: 7 });
    expect(accepted).toMatchObject({ subject: { leadId: null } });
    expect(dialerReducer(accepted, { type: "INCOMING_CONTEXT", callId: CALL, context: { status: "lead", lead } })).toMatchObject({
      subject: { leadId: LEAD, label: "Acme Plumbing" },
    });
  });

  it("declining returns to idle", () => {
    expect(dialerReducer(incoming, { type: "INCOMING_ENDED" })).toEqual(INITIAL_DIALER_STATE);
    expect(dialerReducer(inCall, { type: "INCOMING_ENDED" })).toBe(inCall);
  });
});

describe("helpers", () => {
  it("activeLeadId", () => {
    expect(activeLeadId(INITIAL_DIALER_STATE)).toBeNull();
    expect(activeLeadId(ringing)).toBe(LEAD);
    expect(activeLeadId(dialerReducer(inCall, { type: "DISCONNECTED", reason: "busy" }))).toBe(LEAD);
    expect(activeLeadId(dialerReducer(INITIAL_DIALER_STATE, { type: "INCOMING", callId: null }))).toBeNull();
  });

  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1_000, "0:01"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [754_000, "12:34"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [-5_000, "0:00"],
  ])("formatCallTimer(%i) = %s", (ms, text) => {
    expect(formatCallTimer(ms)).toBe(text);
  });
});
