import { describe, expect, it } from "vitest";
import {
  EMPTY_OUTCOME_FORM,
  buildLogCallPayload,
  describeCallEnd,
  isReadyToSave,
  isUnansweredCallStatus,
  outcomeFromShortcutKey,
  parseManualDuration,
  resolveFollowUpAt,
  type OutcomeFormTarget,
} from "@/lib/dialer/outcome-form";
import { CALL_OUTCOMES } from "@/lib/domain/outcomes";

const LEAD = "11111111-1111-4111-8111-111111111111";
const CALL = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
// 2026-09-15 14:00 UTC = 10:00 in New York.
const NOW = new Date("2026-09-15T14:00:00.000Z");
const TZ = "America/New_York";

const inApp: OutcomeFormTarget = { mode: "IN_APP", leadId: LEAD, callId: CALL, clientRequestId: null, timezone: TZ, now: NOW };
const tel: OutcomeFormTarget = { mode: "TEL", leadId: LEAD, callId: null, clientRequestId: REQ, timezone: TZ, now: NOW };

describe("outcomeFromShortcutKey", () => {
  it("maps 1-8 to the sheet order", () => {
    expect(CALL_OUTCOMES.map((_, i) => outcomeFromShortcutKey(String(i + 1)))).toEqual([...CALL_OUTCOMES]);
    for (const key of ["0", "9", "a", "Enter", "11", ""]) expect(outcomeFromShortcutKey(key)).toBeNull();
  });
});

describe("resolveFollowUpAt", () => {
  it("quick picks are 9am in the agent timezone", () => {
    expect(resolveFollowUpAt("tomorrow", "", TZ, NOW)?.toISOString()).toBe("2026-09-16T13:00:00.000Z");
    expect(resolveFollowUpAt("in3days", "", TZ, NOW)?.toISOString()).toBe("2026-09-18T13:00:00.000Z");
    expect(resolveFollowUpAt("nextWeek", "", TZ, NOW)?.toISOString()).toBe("2026-09-22T13:00:00.000Z");
    expect(resolveFollowUpAt("tomorrow", "", "Asia/Tokyo", NOW)?.toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("custom values are wall-clock time in the agent timezone", () => {
    expect(resolveFollowUpAt("custom", "2026-09-20T15:30", TZ, NOW)?.toISOString()).toBe("2026-09-20T19:30:00.000Z");
    expect(resolveFollowUpAt("custom", "", TZ, NOW)).toBeNull();
    expect(resolveFollowUpAt("custom", "2026-02-30T10:00", TZ, NOW)).toBeNull();
    expect(resolveFollowUpAt(null, "2026-09-20T15:30", TZ, NOW)).toBeNull();
  });
});

describe("parseManualDuration", () => {
  it.each([
    ["", "", { ok: true, seconds: undefined }],
    [" ", " ", { ok: true, seconds: undefined }],
    ["2", "", { ok: true, seconds: 120 }],
    ["", "45", { ok: true, seconds: 45 }],
    ["3", "05", { ok: true, seconds: 185 }],
    ["1440", "0", { ok: true, seconds: 86_400 }],
  ])("%j min %j sec", (m, s, expected) => {
    expect(parseManualDuration(m, s)).toEqual(expected);
  });

  it.each([
    ["-1", ""],
    ["1.5", ""],
    ["", "60"],
    ["abc", ""],
    ["1440", "1"],
  ])("rejects %j min %j sec", (m, s) => {
    expect(parseManualDuration(m, s)).toMatchObject({ ok: false });
  });
});

describe("buildLogCallPayload", () => {
  it("requires an outcome", () => {
    expect(buildLogCallPayload(EMPTY_OUTCOME_FORM, inApp)).toEqual({ ok: false, error: "Pick an outcome." });
  });

  it("logs an in-app call by call id and ignores a manual duration", () => {
    const result = buildLogCallPayload(
      { ...EMPTY_OUTCOME_FORM, outcome: "NO_ANSWER", notes: "  ", durationMinutes: "5" },
      inApp,
    );
    expect(result).toEqual({ ok: true, payload: { outcome: "NO_ANSWER", leadId: LEAD, callId: CALL } });
  });

  it("logs a phone call by client request id with lead id, notes and duration", () => {
    const result = buildLogCallPayload(
      { ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED", notes: " Spoke to owner ", durationMinutes: "2", durationSeconds: "30" },
      tel,
    );
    expect(result).toEqual({
      ok: true,
      payload: { outcome: "CONNECTED", leadId: LEAD, clientRequestId: REQ, notes: "Spoke to owner", durationSeconds: 150 },
    });
  });

  it("logs a manual phone call against its existing call ID without a lead", () => {
    const result = buildLogCallPayload(
      { ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED", durationMinutes: "2" },
      { ...tel, leadId: null, callId: CALL },
    );
    expect(result).toEqual({ ok: true, payload: { outcome: "CONNECTED", leadId: null, callId: CALL, durationSeconds: 120 } });
  });

  it("rejects a bad manual duration on phone calls", () => {
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED", durationSeconds: "75" }, tel)).toMatchObject({
      ok: false,
    });
  });

  it("requires a follow-up time for Follow Up", () => {
    const values = { ...EMPTY_OUTCOME_FORM, outcome: "FOLLOW_UP" as const };
    expect(buildLogCallPayload(values, inApp)).toEqual({ ok: false, error: "Pick when to follow up." });
    expect(buildLogCallPayload({ ...values, followUpPick: "custom", customFollowUp: "" }, inApp)).toMatchObject({ ok: false });
    expect(buildLogCallPayload({ ...values, followUpPick: "custom", customFollowUp: "2026-09-14T09:00" }, inApp)).toEqual({
      ok: false,
      error: "Pick a follow-up time in the future.",
    });
    expect(
      buildLogCallPayload({ ...values, followUpPick: "tomorrow", followUpNote: " Send quote ", notes: "Call back" }, inApp),
    ).toEqual({
      ok: true,
      payload: {
        outcome: "FOLLOW_UP",
        leadId: LEAD,
        callId: CALL,
        notes: "Call back",
        followUpAt: "2026-09-16T13:00:00.000Z",
        followUpNote: "Send quote",
      },
    });
  });

  it("drops the follow-up fields for other outcomes", () => {
    const result = buildLogCallPayload(
      { ...EMPTY_OUTCOME_FORM, outcome: "INTERESTED", followUpPick: "tomorrow", followUpNote: "x" },
      inApp,
    );
    expect(result).toEqual({ ok: true, payload: { outcome: "INTERESTED", leadId: LEAD, callId: CALL } });
  });

  it("an unknown caller can be logged but not followed up", () => {
    const unknown: OutcomeFormTarget = { ...inApp, leadId: null };
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED" }, unknown)).toEqual({
      ok: true,
      payload: { outcome: "CONNECTED", leadId: null, callId: CALL },
    });
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "FOLLOW_UP", followUpPick: "tomorrow" }, unknown)).toMatchObject({
      ok: false,
    });
  });

  it("refuses targets without the ids log_call needs", () => {
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED" }, { ...inApp, callId: null })).toMatchObject({ ok: false });
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED" }, { ...tel, clientRequestId: null })).toMatchObject({
      ok: false,
    });
  });

  it("limits note lengths", () => {
    expect(buildLogCallPayload({ ...EMPTY_OUTCOME_FORM, outcome: "CONNECTED", notes: "x".repeat(5001) }, inApp)).toMatchObject({
      ok: false,
    });
  });
});

describe("small helpers", () => {
  it("isReadyToSave: one tap with a preselected outcome, Follow Up needs a pick", () => {
    expect(isReadyToSave(EMPTY_OUTCOME_FORM)).toBe(false);
    expect(isReadyToSave({ ...EMPTY_OUTCOME_FORM, outcome: "NO_ANSWER" })).toBe(true);
    expect(isReadyToSave({ ...EMPTY_OUTCOME_FORM, outcome: "FOLLOW_UP" })).toBe(false);
    expect(isReadyToSave({ ...EMPTY_OUTCOME_FORM, outcome: "FOLLOW_UP", followUpPick: "nextWeek" })).toBe(true);
  });

  it("isUnansweredCallStatus", () => {
    expect(["busy", "no-answer", "failed"].every(isUnansweredCallStatus)).toBe(true);
    for (const status of ["completed", "canceled", "in-progress", "queued", "ringing", null, undefined]) {
      expect(isUnansweredCallStatus(status)).toBe(false);
    }
  });

  it("describeCallEnd", () => {
    expect(describeCallEnd("TEL", "completed")).toBe("Phone call");
    expect(describeCallEnd("IN_APP", "busy")).toBe("Line busy");
    expect(describeCallEnd("IN_APP", "no-answer")).toBe("No answer");
    expect(describeCallEnd("IN_APP", "completed")).toBe("Call ended");
  });
});
