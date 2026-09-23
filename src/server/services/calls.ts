import { z } from "zod";
import { pageWindow, type PageWindow } from "@/components/leads/list-params";
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

export const CALL_HISTORY_PAGE_SIZE = 50;
export const CALL_HISTORY_TABS = ["all", "missed", "voicemail"] as const;
export type CallHistoryTab = (typeof CALL_HISTORY_TABS)[number];

const callHistoryInputSchema = z.strictObject({
  tab: z.enum(CALL_HISTORY_TABS),
  agentId: z.uuid().optional(),
  page: z.number().int().min(1).max(100_000).optional().default(1),
});

export interface CallHistoryRow {
  id: string;
  createdAt: string;
  leadId: string | null;
  leadStatus: LeadStatus | null;
  businessName: string | null;
  contactName: string | null;
  remoteE164: string | null;
  userId: string | null;
  agentName: string | null;
  direction: Database["public"]["Enums"]["call_direction"];
  outcome: CallOutcome | null;
  callStatus: CallStatus | null;
  durationSeconds: number | null;
  hasVoicemail: boolean;
  voicemailDurationSeconds: number | null;
  handledAt: string | null;
}

export interface CallHistoryPage extends PageWindow {
  tab: CallHistoryTab;
  rows: CallHistoryRow[];
}

type CallHistoryDbRow = Database["public"]["Functions"]["list_call_history"]["Returns"][number];

/** Calls are scoped by calls.user_id in SQL; agent filters apply only to admins. */
export async function listCallHistory(ctx: RequestContext | null, input: unknown): Promise<CallHistoryPage> {
  const active = requireActive(ctx);
  const parsed = callHistoryInputSchema.safeParse(input);
  if (!parsed.success) throw toAppError(parsed.error);
  const { tab, page, agentId } = parsed.data;
  const isAdmin = active.profile.role === "ADMIN";
  const args: Database["public"]["Functions"]["list_call_history"]["Args"] = {
    p_tab: tab,
    p_limit: CALL_HISTORY_PAGE_SIZE,
    p_offset: (page - 1) * CALL_HISTORY_PAGE_SIZE,
  };
  if (isAdmin && agentId) args.p_agent_id = agentId;
  const { data, error } = await active.supabase.rpc("list_call_history", args);
  if (error) throw mapPostgrestError(error);
  const rows = (data ?? []) as CallHistoryDbRow[];
  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && page > 1) {
    const probe = await active.supabase.rpc("list_call_history", { ...args, p_limit: 1, p_offset: 0 });
    if (probe.error) throw mapPostgrestError(probe.error);
    total = Number(probe.data?.[0]?.total_count ?? 0);
  }
  return {
    ...pageWindow(page, CALL_HISTORY_PAGE_SIZE, total, rows.length),
    tab,
    rows: rows.map((row) => ({
      id: row.call_id,
      createdAt: row.created_at,
      leadId: row.lead_id,
      leadStatus: row.lead_status,
      businessName: row.business_name,
      contactName: row.contact_name,
      remoteE164: row.remote_e164,
      userId: row.user_id,
      agentName: isAdmin ? row.agent_name : null,
      direction: row.direction,
      outcome: row.outcome,
      callStatus: toCallStatus(row.call_status),
      durationSeconds: row.duration_seconds,
      hasVoicemail: row.has_voicemail,
      voicemailDurationSeconds: row.voicemail_duration_seconds,
      handledAt: row.handled_at,
    })),
  };
}

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

/** The fields that name a row. A bad value in one of them is an id problem, not a form problem. */
const LOG_CALL_ID_FIELDS: ReadonlySet<string> = new Set(["leadId", "callId", "clientRequestId"]);

/**
 * "Unauthorized equals nonexistent" (ARCHITECTURE rule 4) covers malformed ids too (D19): a leadId or
 * callId that is not a uuid must answer exactly like one that is foreign or missing, so the shape of an
 * id the caller submitted never becomes a separate signal. Everything else — a missing follow-up time,
 * an out-of-range duration, an unknown outcome, and the cross-field rules in `superRefine` (`custom`) —
 * stays `validation`, because those are the caller's own form errors and describe nothing about our rows.
 */
function logCallInputError(error: z.ZodError): AppError {
  const onlyMalformedIds = error.issues.every(
    (issue) => issue.code !== "custom" && issue.path.length === 1 && typeof issue.path[0] === "string" && LOG_CALL_ID_FIELDS.has(issue.path[0]),
  );
  return onlyMalformedIds ? new AppError("not_found") : toAppError(error);
}

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
  if (!parsedInput.success) throw logCallInputError(parsedInput.error);
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
