import { z } from "zod";
import type { Database } from "@/lib/database.types";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/domain/outcomes";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, toAppError } from "@/server/errors";

export const CALL_STATUSES = [
  "queued",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const FOLLOW_UP_CLOCK_SKEW_MS = 60_000;
const FOLLOW_UP_MAX_AHEAD_MS = 5 * 365 * 86_400_000;

export const logCallInputSchema = z
  .strictObject({
    outcome: z.enum(CALL_OUTCOMES, { error: "Pick an outcome." }),
    leadId: z.uuid({ error: "Invalid lead." }).nullable(),
    callId: z.uuid({ error: "Invalid call." }).optional(),
    clientRequestId: z.uuid({ error: "Invalid call." }).optional(),
    notes: z.string().max(5000, { error: "Notes can be at most 5000 characters." }).optional(),
    // Same bounds as log_call (D21): a past follow-up would be overdue at once and loop Save & Next.
    followUpAt: z.iso
      .datetime({ offset: true, error: "Enter a valid follow-up date and time." })
      .refine(
        (value) => {
          const time = Date.parse(value);
          return time >= Date.now() - FOLLOW_UP_CLOCK_SKEW_MS && time <= Date.now() + FOLLOW_UP_MAX_AHEAD_MS;
        },
        { error: "Pick a follow-up time in the future, within five years." },
      )
      .optional(),
    followUpNote: z.string().max(1000, { error: "The follow-up note can be at most 1000 characters." }).optional(),
    durationSeconds: z
      .number()
      .int({ error: "Duration must be whole seconds." })
      .min(0, { error: "Duration can't be negative." })
      .max(86_400, { error: "Duration can be at most 24 hours." })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.outcome === "FOLLOW_UP" && input.followUpAt === undefined) {
      ctx.addIssue({ code: "custom", path: ["followUpAt"], message: "Pick when to follow up." });
    }
    if (input.callId !== undefined && input.clientRequestId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["clientRequestId"], message: "Invalid call." });
    }
    if (input.callId === undefined && input.leadId === null) {
      ctx.addIssue({ code: "custom", path: ["leadId"], message: "A lead is required." });
    }
  });

export type LogCallInput = z.infer<typeof logCallInputSchema>;

export interface LogCallResult {
  callId: string;
  leadId: string | null;
  status: LeadStatus | null;
  callCount: number | null;
  nextFollowUpAt: string | null;
}

const logCallResultSchema = z.object({
  call_id: z.string(),
  lead_id: z.string().nullable(),
  status: z.enum(LEAD_STATUSES).nullable(),
  call_count: z.number().int().nullable(),
  next_follow_up_at: z.string().nullable(),
});

/**
 * log_call (ARCHITECTURE 4.7, D16). An in-app or inbound call is logged by its row id only, so an id
 * the caller may not log fails as not_found and never falls back to inserting a TEL row. A phone (tel:)
 * call sends its client-generated request id with the lead id, which makes retries idempotent.
 */
export async function logCall(ctx: RequestContext, input: unknown): Promise<LogCallResult> {
  const { supabase } = requireActive(ctx);
  const parsedInput = logCallInputSchema.safeParse(input);
  if (!parsedInput.success) throw toAppError(parsedInput.error);
  const values = parsedInput.data;

  const args: Database["public"]["Functions"]["log_call"]["Args"] = { p_outcome: values.outcome };
  if (values.callId !== undefined) {
    args.p_call_id = values.callId;
  } else {
    if (values.leadId !== null) args.p_lead_id = values.leadId;
    if (values.clientRequestId !== undefined) args.p_call_id = values.clientRequestId;
  }
  if (values.notes !== undefined) args.p_notes = values.notes;
  if (values.followUpAt !== undefined) args.p_follow_up_at = values.followUpAt;
  if (values.followUpNote !== undefined) args.p_follow_up_note = values.followUpNote;
  if (values.durationSeconds !== undefined) args.p_duration_seconds = values.durationSeconds;

  const { data, error } = await supabase.rpc("log_call", args);
  if (error) throw mapPostgrestError(error);

  const parsed = logCallResultSchema.safeParse(data);
  if (!parsed.success) throw new AppError("internal", undefined, { cause: parsed.error });
  return {
    callId: parsed.data.call_id,
    leadId: parsed.data.lead_id,
    status: parsed.data.status,
    callCount: parsed.data.call_count,
    nextFollowUpAt: parsed.data.next_follow_up_at,
  };
}

const callIdSchema = z.uuid();

/** Malformed, missing and inaccessible ids all fail the same way. */
function parseCallId(callId: unknown): string {
  const parsed = callIdSchema.safeParse(callId);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

export interface CallStatusResult {
  callId: string;
  callStatus: CallStatus | null;
  outcome: CallOutcome | null;
  durationSeconds: number | null;
}

function toCallStatus(value: string | null): CallStatus | null {
  return value !== null && (CALL_STATUSES as readonly string[]).includes(value) ? (value as CallStatus) : null;
}

/** The provider status of a call the caller can see through RLS (their lead's call, or their own unmatched call). */
export async function getCallStatus(ctx: RequestContext, callId: unknown): Promise<CallStatusResult> {
  const { supabase } = requireActive(ctx);
  const id = parseCallId(callId);

  const { data, error } = await supabase
    .from("calls")
    .select("id, call_status, outcome, duration_seconds")
    .eq("id", id)
    .maybeSingle();
  if (error) throw mapPostgrestError(error);
  if (!data) throw new AppError("not_found");

  return {
    callId: data.id,
    callStatus: toCallStatus(data.call_status),
    outcome: data.outcome,
    durationSeconds: data.duration_seconds,
  };
}

export interface IncomingCallContext {
  callId: string;
  /** Only the caller's own lead; null means "Unknown caller". */
  lead: { leadId: string; businessName: string; contactName: string | null; status: LeadStatus } | null;
}

export async function getIncomingCallContext(ctx: RequestContext, callId: unknown): Promise<IncomingCallContext> {
  const active = requireActive(ctx);
  const id = parseCallId(callId);

  const call = await active.supabase.from("calls").select("id, lead_id").eq("id", id).maybeSingle();
  if (call.error) throw mapPostgrestError(call.error);
  if (!call.data) throw new AppError("not_found");
  if (call.data.lead_id === null) return { callId: call.data.id, lead: null };

  const lead = await active.supabase
    .from("leads")
    .select("id, business_name, contact_name, status")
    .eq("id", call.data.lead_id)
    .eq("assigned_to", active.userId)
    .maybeSingle();
  if (lead.error) throw mapPostgrestError(lead.error);
  if (!lead.data) return { callId: call.data.id, lead: null };

  return {
    callId: call.data.id,
    lead: {
      leadId: lead.data.id,
      businessName: lead.data.business_name,
      contactName: lead.data.contact_name,
      status: lead.data.status,
    },
  };
}
