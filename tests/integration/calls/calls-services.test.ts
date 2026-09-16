// Stage 3 services against localbase with real user sessions: log_call idempotency and isolation,
// call status / incoming context scoping, Next Lead and the voicemail count.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@/server/context";
import { getCallStatus, getIncomingCallContext, logCall } from "@/server/services/calls";
import { nextLead } from "@/server/services/next-lead";
import { unheardVoicemailCount } from "@/server/services/voicemails";
import { serviceClient } from "../../helpers/clients";
import { contextForUser } from "../../helpers/context";
import {
  createCall,
  createFollowUp,
  createLead,
  createUser,
  fakeTwilioSid,
  type FixtureUser,
  type Lead,
} from "../../helpers/fixtures";

const HOUR = 3_600_000;

async function leadRow(id: string) {
  const { data, error } = await serviceClient()
    .from("leads")
    .select("id, status, call_count, last_contacted_at, next_follow_up_at")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`lead ${id}: ${error?.message ?? "missing"}`);
  return data;
}

async function callsForLead(leadId: string) {
  const { data, error } = await serviceClient()
    .from("calls")
    .select("id, mode, direction, outcome, notes, duration_seconds, client_request_id, user_id")
    .eq("lead_id", leadId);
  if (error || !data) throw new Error(`calls for ${leadId}: ${error?.message ?? "missing"}`);
  return data;
}

let userA: FixtureUser;
let userB: FixtureUser;
let a: RequestContext;
let b: RequestContext;
let bLead: Lead;

beforeAll(async () => {
  [userA, userB] = await Promise.all([
    createUser({ name: "Calls Agent A", timezone: "America/New_York" }),
    createUser({ name: "Calls Agent B" }),
  ]);
  [a, b] = await Promise.all([contextForUser(userA), contextForUser(userB)]);
  bLead = await createLead({ assigned_to: userB.id, status: "NEW", business_name: "B Only Roofing" });
});

describe("logCall", () => {
  it("logs a phone (TEL) call once per client request id", async () => {
    const lead = await createLead({ assigned_to: userA.id, status: "NEW" });
    const clientRequestId = randomUUID();
    const input = { outcome: "NO_ANSWER", leadId: lead.id, clientRequestId, notes: "Rang out", durationSeconds: 20 };

    const first = await logCall(a, input);
    const retry = await logCall(a, input);

    expect(first).toMatchObject({ leadId: lead.id, status: "NO_ANSWER", callCount: 1 });
    expect(retry.callId).toBe(first.callId);
    expect(retry.callCount).toBe(1);
    expect(first.callId).not.toBe(clientRequestId);

    const calls = await callsForLead(lead.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: first.callId,
      mode: "TEL",
      direction: "OUTBOUND",
      outcome: "NO_ANSWER",
      notes: "Rang out",
      duration_seconds: 20,
      client_request_id: clientRequestId,
      user_id: userA.id,
    });
    expect((await leadRow(lead.id)).call_count).toBe(1);

    const another = await logCall(a, { outcome: "VOICEMAIL", leadId: lead.id, clientRequestId: randomUUID() });
    expect(another.callId).not.toBe(first.callId);
    expect(another.callCount).toBe(2);
  });

  it("logs a pre-created in-app call by its id and counts it once", async () => {
    const lead = await createLead({ assigned_to: userA.id, status: "TO_CALL" });
    const created = await a.supabase.rpc("create_outbound_call", { p_lead_id: lead.id });
    expect(created.error).toBeNull();
    const callId = created.data as string;

    const first = await logCall(a, { outcome: "CONNECTED", leadId: lead.id, callId, durationSeconds: 999 });
    expect(first).toMatchObject({ callId, leadId: lead.id, status: "CONNECTED", callCount: 1 });

    const relog = await logCall(a, { outcome: "INTERESTED", leadId: lead.id, callId, notes: "Wants a quote" });
    expect(relog).toMatchObject({ callId, status: "INTERESTED", callCount: 1 });

    const calls = await callsForLead(lead.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: callId, mode: "IN_APP", outcome: "INTERESTED", notes: "Wants a quote", duration_seconds: null });
    expect((await leadRow(lead.id)).call_count).toBe(1);
  });

  it("creates a follow-up for Follow Up and prefixes Wrong Number notes", async () => {
    const lead = await createLead({ assigned_to: userA.id, status: "NEW" });
    const due = new Date(Date.now() + 48 * HOUR);
    due.setMilliseconds(0);
    const result = await logCall(a, {
      outcome: "FOLLOW_UP",
      leadId: lead.id,
      clientRequestId: randomUUID(),
      followUpAt: due.toISOString(),
      followUpNote: "Send pricing",
    });
    expect(result.status).toBe("FOLLOW_UP");
    expect(new Date(result.nextFollowUpAt ?? 0).getTime()).toBe(due.getTime());

    const wrong = await createLead({ assigned_to: userA.id, status: "NEW" });
    const logged = await logCall(a, { outcome: "WRONG_NUMBER", leadId: wrong.id, clientRequestId: randomUUID(), notes: "Pizza place" });
    expect(logged.status).toBe("DO_NOT_CONTACT");
    expect((await callsForLead(wrong.id))[0].notes).toBe("Wrong number — Pizza place");
  });

  it("rejects Follow Up without a date, and other invalid input, as validation errors", async () => {
    const lead = await createLead({ assigned_to: userA.id, status: "NEW" });
    const base = { leadId: lead.id, clientRequestId: randomUUID() };
    await expect(logCall(a, { ...base, outcome: "FOLLOW_UP" })).rejects.toMatchObject({ code: "validation" });
    await expect(logCall(a, { ...base, outcome: "CALLED_BACK" })).rejects.toMatchObject({ code: "validation" });
    await expect(logCall(a, { ...base, outcome: "CONNECTED", durationSeconds: 86_401 })).rejects.toMatchObject({ code: "validation" });
    await expect(logCall(a, { ...base, outcome: "CONNECTED", notes: "x".repeat(5001) })).rejects.toMatchObject({ code: "validation" });
    // A malformed id is not a validation error: it is not_found, like every other id the caller
    // cannot use. See "answers a malformed id exactly like a foreign or nonexistent one" below.
    await expect(logCall(a, { outcome: "CONNECTED", leadId: null })).rejects.toMatchObject({ code: "validation" });
    await expect(logCall(a, { ...base, outcome: "CONNECTED", callId: randomUUID() })).rejects.toMatchObject({ code: "validation" });
    await expect(logCall(a, { ...base, outcome: "CONNECTED", extra: true })).rejects.toMatchObject({ code: "validation" });
    // A past follow-up would make Save & Next serve this same lead again as OVERDUE (D21).
    for (const followUpAt of ["1970-01-01T00:00:00Z", new Date(Date.now() - 10 * 60_000).toISOString(), "9999-12-31T00:00:00Z"]) {
      await expect(logCall(a, { ...base, outcome: "FOLLOW_UP", followUpAt })).rejects.toMatchObject({
        code: "validation",
        message: "Pick a follow-up time in the future, within five years.",
      });
    }

    expect((await leadRow(lead.id)).call_count).toBe(0);
    expect(await callsForLead(lead.id)).toHaveLength(0);
  });

  it("treats B's lead and B's call exactly like ids that do not exist", async () => {
    const bCall = await createCall({ lead_id: bLead.id, user_id: userB.id, direction: "OUTBOUND", mode: "TEL" });
    const aLead = await createLead({ assigned_to: userA.id, status: "NEW" });

    const attempts = [
      logCall(a, { outcome: "CONNECTED", leadId: bLead.id, clientRequestId: randomUUID() }),
      logCall(a, { outcome: "CONNECTED", leadId: bLead.id }),
      logCall(a, { outcome: "CONNECTED", leadId: null, callId: bCall.id }),
      logCall(a, { outcome: "CONNECTED", leadId: bLead.id, callId: bCall.id }),
      logCall(a, { outcome: "CONNECTED", leadId: aLead.id, callId: bCall.id }),
    ];
    const missing = [
      logCall(a, { outcome: "CONNECTED", leadId: randomUUID(), clientRequestId: randomUUID() }),
      logCall(a, { outcome: "CONNECTED", leadId: null, callId: randomUUID() }),
    ];
    const results = await Promise.allSettled([...attempts, ...missing]);
    const errors = results.map((result) => {
      expect(result.status).toBe("rejected");
      const reason = (result as PromiseRejectedResult).reason as { code: string; message: string };
      return { code: reason.code, message: reason.message };
    });
    expect(new Set(errors.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(errors[0].code).toBe("not_found");

    expect(await leadRow(bLead.id)).toMatchObject({ call_count: 0, status: "NEW", last_contacted_at: null });
    expect(await callsForLead(bLead.id)).toHaveLength(1);
    expect((await callsForLead(bLead.id))[0].outcome).toBeNull();
    expect(await callsForLead(aLead.id)).toHaveLength(0);
  });

  it("answers a malformed id exactly like a foreign or nonexistent one (ARCHITECTURE rule 4, D19)", async () => {
    const bCall = await createCall({ lead_id: bLead.id, user_id: userB.id, direction: "OUTBOUND", mode: "TEL" });

    // Three ways of naming a lead the caller may not log against, and three of naming a call row.
    // All six must be indistinguishable: foreign, nonexistent and malformed alike.
    const inputs: unknown[] = [
      { outcome: "CONNECTED", leadId: bLead.id, clientRequestId: randomUUID() },
      { outcome: "CONNECTED", leadId: randomUUID(), clientRequestId: randomUUID() },
      { outcome: "CONNECTED", leadId: "not-a-uuid", clientRequestId: randomUUID() },
      { outcome: "CONNECTED", leadId: null, callId: bCall.id },
      { outcome: "CONNECTED", leadId: null, callId: randomUUID() },
      { outcome: "CONNECTED", leadId: null, callId: "not-a-uuid" },
    ];

    const errors: Array<{ code: string; message: string }> = [];
    for (const input of inputs) {
      const settled = await Promise.allSettled([logCall(a, input)]);
      expect(settled[0].status, JSON.stringify(input)).toBe("rejected");
      const reason = (settled[0] as PromiseRejectedResult).reason as { code: string; message: string };
      errors.push({ code: reason.code, message: reason.message });
    }

    expect(errors).toEqual(Array.from({ length: inputs.length }, () => ({ code: "not_found", message: "Not found." })));
    // A malformed idempotency key is the caller's own value, but it still must not answer differently.
    await expect(
      logCall(a, { outcome: "CONNECTED", leadId: randomUUID(), clientRequestId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "not_found", message: "Not found." });
  });

  it("logs an answered unknown-caller inbound call without a lead", async () => {
    const inbound = await createCall({
      lead_id: null,
      user_id: userA.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      remote_e164: "+12125550199",
      call_status: "completed",
      duration_seconds: 42,
    });
    const result = await logCall(a, { outcome: "CONNECTED", leadId: null, callId: inbound.id, notes: "Asked about pricing" });
    expect(result).toEqual({ callId: inbound.id, leadId: null, status: null, callCount: null, nextFollowUpAt: null });

    const { data } = await serviceClient().from("calls").select("outcome, notes, duration_seconds").eq("id", inbound.id).single();
    expect(data).toEqual({ outcome: "CONNECTED", notes: "Asked about pricing", duration_seconds: 42 });

    await expect(
      logCall(b, { outcome: "CONNECTED", leadId: null, callId: inbound.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a new phone call on a Do Not Contact lead", async () => {
    const lead = await createLead({ assigned_to: userA.id, status: "DO_NOT_CONTACT" });
    await expect(logCall(a, { outcome: "CONNECTED", leadId: lead.id, clientRequestId: randomUUID() })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("requires an active profile", async () => {
    const inactive: RequestContext = { ...a, profile: { ...a.profile, active: false } };
    await expect(logCall(inactive, { outcome: "CONNECTED", leadId: bLead.id })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(nextLead(inactive, [])).rejects.toMatchObject({ code: "unauthorized" });
    await expect(unheardVoicemailCount(inactive)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(getCallStatus(inactive, randomUUID())).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("getCallStatus and getIncomingCallContext", () => {
  it("return own calls and hide B's calls like missing ids", async () => {
    const aLead = await createLead({ assigned_to: userA.id, status: "INTERESTED", business_name: "A Bakery", contact_name: "Ann" });
    const outbound = await createCall({
      lead_id: aLead.id,
      user_id: userA.id,
      direction: "OUTBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      call_status: "no-answer",
      duration_seconds: 0,
    });
    const inbound = await createCall({
      lead_id: aLead.id,
      user_id: userA.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      call_status: "in-progress",
    });
    const unmatched = await createCall({
      lead_id: null,
      user_id: userA.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      call_status: "ringing",
      remote_e164: "+12125550198",
    });
    const bInbound = await createCall({
      lead_id: bLead.id,
      user_id: userB.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      call_status: "ringing",
    });
    const bUnmatched = await createCall({
      lead_id: null,
      user_id: userB.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      call_status: "ringing",
    });

    expect(await getCallStatus(a, outbound.id)).toEqual({
      callId: outbound.id,
      callStatus: "no-answer",
      outcome: null,
      durationSeconds: 0,
    });
    expect(await getIncomingCallContext(a, inbound.id)).toEqual({
      callId: inbound.id,
      lead: { leadId: aLead.id, businessName: "A Bakery", contactName: "Ann", status: "INTERESTED" },
    });
    expect(await getIncomingCallContext(a, unmatched.id)).toEqual({ callId: unmatched.id, lead: null });

    for (const id of [bInbound.id, bUnmatched.id, randomUUID(), "not-a-uuid", 42]) {
      await expect(getCallStatus(a, id)).rejects.toMatchObject({ code: "not_found", message: "Not found." });
      await expect(getIncomingCallContext(a, id)).rejects.toMatchObject({ code: "not_found", message: "Not found." });
    }
    await expect(getIncomingCallContext(b, bInbound.id)).resolves.toMatchObject({ lead: { businessName: "B Only Roofing" } });
  });
});

describe("nextLead", () => {
  it("returns only the caller's own leads, in order, honoring skip", async () => {
    const [agent, other] = await Promise.all([createUser({ name: "Next A" }), createUser({ name: "Next B" })]);
    const [ctxAgent, ctxOther] = await Promise.all([contextForUser(agent), contextForUser(other)]);

    const older = await createLead({ assigned_to: agent.id, status: "NEW", created_at: new Date(Date.now() - 3 * HOUR).toISOString() });
    const newer = await createLead({ assigned_to: agent.id, status: "TO_CALL", created_at: new Date(Date.now() - 2 * HOUR).toISOString() });
    await createLead({ assigned_to: agent.id, status: "CLIENT" });
    await createLead({ assigned_to: agent.id, status: "DO_NOT_CONTACT" });
    // The other agent's lead would win (overdue follow-up bucket) if it were visible.
    const otherLead = await createLead({ assigned_to: other.id, status: "FOLLOW_UP", created_at: new Date(Date.now() - 9 * HOUR).toISOString() });
    await createFollowUp({ lead_id: otherLead.id, user_id: other.id, due_at: new Date(Date.now() - HOUR).toISOString() });
    await createLead({ assigned_to: null, status: "NEW", created_at: new Date(Date.now() - 10 * HOUR).toISOString() });

    const first = await nextLead(ctxAgent, []);
    expect(first).toMatchObject({ leadId: older.id, reason: "NEW", status: "NEW", callCount: 0 });
    expect(await nextLead(ctxAgent, [older.id])).toMatchObject({ leadId: newer.id, reason: "NEW" });
    expect(await nextLead(ctxAgent, [older.id, newer.id])).toBeNull();
    expect(await nextLead(ctxAgent, [otherLead.id])).toMatchObject({ leadId: older.id });

    expect(await nextLead(ctxOther, [])).toMatchObject({ leadId: otherLead.id, reason: "OVERDUE" });

    await expect(nextLead(ctxAgent, ["not-a-uuid"])).rejects.toMatchObject({ code: "validation" });
    await expect(nextLead(ctxAgent, Array.from({ length: 201 }, () => randomUUID()))).rejects.toMatchObject({ code: "validation" });

    // Logging the lead moves it out of the queue for 4 hours.
    await logCall(ctxAgent, { outcome: "NO_ANSWER", leadId: older.id, clientRequestId: randomUUID() });
    expect(await nextLead(ctxAgent, [])).toMatchObject({ leadId: newer.id });
  });
});

describe("unheardVoicemailCount", () => {
  it("counts only the caller's voicemails and drops after logging the lead", async () => {
    const [agent, other] = await Promise.all([createUser({ name: "VM A" }), createUser({ name: "VM B" })]);
    const [ctxAgent, ctxOther] = await Promise.all([contextForUser(agent), contextForUser(other)]);
    expect(await unheardVoicemailCount(ctxAgent)).toBe(0);

    const agentLead = await createLead({ assigned_to: agent.id, status: "VOICEMAIL" });
    const otherLead = await createLead({ assigned_to: other.id, status: "VOICEMAIL" });
    const voicemail = (leadId: string | null, userId: string) =>
      createCall({
        lead_id: leadId,
        user_id: userId,
        direction: "INBOUND",
        mode: "IN_APP",
        provider_call_sid: fakeTwilioSid("CA"),
        call_status: "completed",
        voicemail_recording_sid: fakeTwilioSid("RE"),
        voicemail_duration_seconds: 9,
      });
    await Promise.all([voicemail(agentLead.id, agent.id), voicemail(null, agent.id), voicemail(otherLead.id, other.id), voicemail(null, other.id)]);
    await createCall({
      lead_id: agentLead.id,
      user_id: agent.id,
      direction: "INBOUND",
      mode: "IN_APP",
      provider_call_sid: fakeTwilioSid("CA"),
      voicemail_recording_sid: fakeTwilioSid("RE"),
      handled_at: new Date().toISOString(),
    });

    expect(await unheardVoicemailCount(ctxAgent)).toBe(2);
    expect(await unheardVoicemailCount(ctxOther)).toBe(2);

    await logCall(ctxAgent, { outcome: "CONNECTED", leadId: agentLead.id, clientRequestId: randomUUID() });
    expect(await unheardVoicemailCount(ctxAgent)).toBe(1);
    expect(await unheardVoicemailCount(ctxOther)).toBe(2);
  });
});
