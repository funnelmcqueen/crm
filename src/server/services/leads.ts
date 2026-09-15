import { z } from "zod";
import {
  LEAD_SORT_KEYS,
  MAX_QUERY_LENGTH,
  MAX_SOURCE_LENGTH,
  pageWindow,
  type LeadSortKey,
  type PageWindow,
  type SortDir,
} from "@/components/leads/list-params";
import type { Database } from "@/lib/database.types";
import { normalizePhone } from "@/lib/domain/phone";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { normalizeWebsiteDomain } from "@/lib/domain/website";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";

export const LEADS_PAGE_SIZE = 25;
export const MAX_NOTES_LENGTH = 10_000;
export const MAX_FOLLOW_UP_NOTE_LENGTH = 500;

type CallDirection = Database["public"]["Enums"]["call_direction"];
type CallMode = Database["public"]["Enums"]["call_mode"];
type CallOutcome = Database["public"]["Enums"]["call_outcome"];

const LEAD_COLUMNS =
  "id, created_at, updated_at, business_name, contact_name, phone, phone_raw, email, website, website_domain, address, city, state, country, source, status, notes, assigned_to, last_contacted_at, next_follow_up_at, call_count";

const uuidSchema = z.uuid();

/** Malformed ids get the same answer as ids that do not exist or are not visible. */
function parseId(id: unknown): string {
  const parsed = uuidSchema.safeParse(typeof id === "string" ? id.trim().toLowerCase() : id);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    });

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

const listLeadsSchema = z.object({
  query: z.string().max(1000).optional().transform((q) => (q ?? "").trim().slice(0, MAX_QUERY_LENGTH)),
  statuses: z.array(z.enum(LEAD_STATUSES)).max(LEAD_STATUSES.length * 2).optional().default([]),
  source: optionalText(MAX_SOURCE_LENGTH),
  agentId: uuidSchema.nullish(),
  unassigned: z.boolean().optional().default(false),
  sort: z.enum(LEAD_SORT_KEYS).optional().default("created_at"),
  dir: z.enum(["asc", "desc"]).optional().default("desc"),
  page: z.number().int().min(1).max(100_000).optional().default(1),
});

export type ListLeadsInput = z.input<typeof listLeadsSchema>;

export interface LeadListRow {
  id: string;
  createdAt: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  email: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  source: string | null;
  status: LeadStatus;
  /** Admins only; always null for agents. */
  assignedTo: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  callCount: number;
}

export interface LeadListResult extends PageWindow {
  rows: LeadListRow[];
  sort: LeadSortKey;
  dir: SortDir;
}

type SearchLeadsArgs = Database["public"]["Functions"]["search_leads"]["Args"];
type SearchLeadsRow = Database["public"]["Functions"]["search_leads"]["Returns"][number];

export async function listLeads(ctx: RequestContext | null, input: ListLeadsInput = {}): Promise<LeadListResult> {
  const active = requireActive(ctx);
  const params = listLeadsSchema.parse(input);
  const isAdmin = active.profile.role === "ADMIN";

  const args: SearchLeadsArgs = {
    p_sort: params.sort,
    p_dir: params.dir,
    p_limit: LEADS_PAGE_SIZE,
    p_offset: (params.page - 1) * LEADS_PAGE_SIZE,
  };
  if (params.query !== "") args.p_query = params.query;
  if (params.statuses.length > 0) args.p_statuses = [...new Set(params.statuses)];
  if (params.source !== null) args.p_source = params.source;
  // The RPC also ignores these for non-admins; not sending them keeps agent requests honest.
  if (isAdmin) {
    if (params.unassigned) args.p_unassigned = true;
    else if (params.agentId) args.p_assigned_to = params.agentId;
  }

  const { data, error } = await active.supabase.rpc("search_leads", args);
  if (error) fail(error);
  const rows = (data ?? []) as SearchLeadsRow[];

  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && params.page > 1) {
    // Past the last page the window function has no row to report the total on.
    const probe = await active.supabase.rpc("search_leads", { ...args, p_limit: 1, p_offset: 0 });
    if (probe.error) fail(probe.error);
    const first = (probe.data ?? [])[0] as SearchLeadsRow | undefined;
    total = first ? Number(first.total_count) : 0;
  }

  return {
    ...pageWindow(params.page, LEADS_PAGE_SIZE, total, rows.length),
    sort: params.sort,
    dir: params.dir,
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      businessName: row.business_name,
      contactName: row.contact_name ?? null,
      phone: row.phone,
      email: row.email ?? null,
      website: row.website ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      source: row.source ?? null,
      status: row.status,
      assignedTo: isAdmin ? (row.assigned_to ?? null) : null,
      lastContactedAt: row.last_contacted_at ?? null,
      nextFollowUpAt: row.next_follow_up_at ?? null,
      callCount: row.call_count,
    })),
  };
}

export async function listLeadSources(ctx: RequestContext | null): Promise<string[]> {
  const active = requireActive(ctx);
  const { data, error } = await active.supabase.rpc("list_lead_sources");
  if (error) fail(error);
  return ((data ?? []) as string[]).filter((source) => typeof source === "string" && source.trim() !== "");
}

export interface AgentOption {
  id: string;
  name: string;
  email: string;
  active: boolean;
  role: "ADMIN" | "AGENT";
}

/** Admin only: every profile, for the agent filter and the reassign picker. */
export async function listAgentsForFilter(ctx: RequestContext | null): Promise<AgentOption[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase
    .from("profiles")
    .select("id, name, email, active, role")
    .order("name", { ascending: true })
    .order("email", { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((p) => ({ id: p.id, name: p.name || p.email, email: p.email, active: p.active, role: p.role }));
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

export interface LeadRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  phoneRaw: string | null;
  email: string | null;
  website: string | null;
  websiteDomain: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  callCount: number;
}

export interface CallHistoryEntry {
  id: string;
  createdAt: string;
  direction: CallDirection;
  mode: CallMode;
  callStatus: string | null;
  outcome: CallOutcome | null;
  notes: string | null;
  durationSeconds: number | null;
  hasVoicemail: boolean;
  voicemailDurationSeconds: number | null;
  handledAt: string | null;
  /** Admins only; null for agents, who never learn who made a call. */
  caller: { name: string | null; callerIdE164: string | null } | null;
}

export interface LeadDetail {
  lead: LeadRecord;
  history: CallHistoryEntry[];
  /** Admins only; null for agents. */
  admin: { assignedTo: { id: string; name: string; active: boolean } | null } | null;
}

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
type HistoryRow = Database["public"]["Functions"]["get_lead_call_history"]["Returns"][number];

function toLeadRecord(row: Omit<LeadRow, "dedupe_name_key">): LeadRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    businessName: row.business_name,
    contactName: row.contact_name,
    phone: row.phone,
    phoneRaw: row.phone_raw,
    email: row.email,
    website: row.website,
    websiteDomain: row.website_domain,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    source: row.source,
    status: row.status,
    notes: row.notes,
    lastContactedAt: row.last_contacted_at,
    nextFollowUpAt: row.next_follow_up_at,
    callCount: row.call_count,
  };
}

/** The lead as the caller's session sees it, or null when it does not exist, is not visible, or the id is malformed. */
export async function getLeadDetail(ctx: RequestContext | null, id: unknown): Promise<LeadDetail | null> {
  const active = requireActive(ctx);
  let leadId: string;
  try {
    leadId = parseId(id);
  } catch {
    return null;
  }
  const isAdmin = active.profile.role === "ADMIN";

  const { data: row, error } = await active.supabase.from("leads").select(LEAD_COLUMNS).eq("id", leadId).maybeSingle();
  if (error) fail(error);
  if (!row) return null;

  const historyResult = await active.supabase.rpc("get_lead_call_history", { p_lead_id: leadId });
  if (historyResult.error) fail(historyResult.error);
  const history = ((historyResult.data ?? []) as HistoryRow[]).map(
    (call): CallHistoryEntry => ({
      id: call.id,
      createdAt: call.created_at,
      direction: call.direction,
      mode: call.mode,
      callStatus: call.call_status ?? null,
      outcome: call.outcome ?? null,
      notes: call.notes ?? null,
      durationSeconds: call.duration_seconds ?? null,
      hasVoicemail: call.has_voicemail === true,
      voicemailDurationSeconds: call.voicemail_duration_seconds ?? null,
      handledAt: call.handled_at ?? null,
      caller: isAdmin ? { name: call.caller_name ?? null, callerIdE164: call.caller_id_e164 ?? null } : null,
    }),
  );

  let admin: LeadDetail["admin"] = null;
  if (isAdmin) {
    let assignedTo: { id: string; name: string; active: boolean } | null = null;
    if (row.assigned_to) {
      const owner = await active.supabase
        .from("profiles")
        .select("id, name, email, active")
        .eq("id", row.assigned_to)
        .maybeSingle();
      if (owner.error) fail(owner.error);
      assignedTo = owner.data
        ? { id: owner.data.id, name: owner.data.name || owner.data.email, active: owner.data.active }
        : { id: row.assigned_to, name: "Unknown user", active: false };
    }
    admin = { assignedTo };
  }

  return { lead: toLeadRecord(row), history, admin };
}

// ---------------------------------------------------------------------------------------------
// Agent-allowed updates
// ---------------------------------------------------------------------------------------------

const statusSchema = z.enum(LEAD_STATUSES);

export async function updateLeadStatus(
  ctx: RequestContext | null,
  id: unknown,
  status: unknown,
): Promise<{ id: string; status: LeadStatus }> {
  const active = requireActive(ctx);
  const leadId = parseId(id);
  const parsedStatus = statusSchema.safeParse(status);
  if (!parsedStatus.success) throw new AppError("validation", "Choose a valid status.");

  const { data, error } = await active.supabase
    .from("leads")
    .update({ status: parsedStatus.data })
    .eq("id", leadId)
    .select("id, status");
  if (error) {
    // leads_guard: an agent cannot move a lead away from DO_NOT_CONTACT (DEVIATIONS D12).
    if (error.code === "42501") throw new AppError("forbidden", "Only an admin can reopen a Do Not Contact lead.");
    fail(error);
  }
  const updated = data?.[0];
  if (!updated) throw new AppError("not_found");
  return { id: updated.id, status: updated.status };
}

const notesSchema = z
  .string()
  .max(MAX_NOTES_LENGTH, `Notes can be at most ${MAX_NOTES_LENGTH.toLocaleString("en-US")} characters.`)
  .nullable()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  });

export async function updateLeadNotes(
  ctx: RequestContext | null,
  id: unknown,
  notes: unknown,
): Promise<{ id: string; notes: string | null }> {
  const active = requireActive(ctx);
  const leadId = parseId(id);
  const parsedNotes = notesSchema.parse(notes ?? null);

  const { data, error } = await active.supabase
    .from("leads")
    .update({ notes: parsedNotes })
    .eq("id", leadId)
    .select("id, notes");
  if (error) fail(error);
  const updated = data?.[0];
  if (!updated) throw new AppError("not_found");
  return { id: updated.id, notes: updated.notes };
}

const YEAR_MS = 365 * 86_400_000;

const followUpSchema = z.object({
  dueAt: z.iso
    .datetime({ offset: true, message: "Pick a valid date and time." })
    .refine((value) => {
      const time = Date.parse(value);
      return time > Date.now() - 86_400_000 && time < Date.now() + 5 * YEAR_MS;
    }, "Pick a date between today and five years from now."),
  note: z
    .string()
    .max(MAX_FOLLOW_UP_NOTE_LENGTH, `The note can be at most ${MAX_FOLLOW_UP_NOTE_LENGTH} characters.`)
    .nullish()
    .transform((value) => (value === undefined ? undefined : (value ?? "").trim() || null)),
});

export interface SetFollowUpResult {
  followUpId: string;
  action: "created" | "rescheduled";
  nextFollowUpAt: string | null;
}

/**
 * Moves the earliest open follow-up of the follow-up owner on this lead, or creates one. The owner is
 * the lead's agent when an admin schedules on an assigned lead, otherwise the caller. RLS decides.
 */
export async function setNextFollowUp(
  ctx: RequestContext | null,
  leadId: unknown,
  dueAtIso: unknown,
  note?: unknown,
): Promise<SetFollowUpResult> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const input = followUpSchema.parse({ dueAt: dueAtIso, note });
  const dueAt = new Date(input.dueAt).toISOString();

  const { data: lead, error: leadError } = await active.supabase
    .from("leads")
    .select("id, assigned_to")
    .eq("id", id)
    .maybeSingle();
  if (leadError) fail(leadError);
  if (!lead) throw new AppError("not_found");

  const ownerId = active.profile.role === "ADMIN" && lead.assigned_to ? lead.assigned_to : active.userId;

  const open = await active.supabase
    .from("follow_ups")
    .select("id")
    .eq("lead_id", id)
    .eq("user_id", ownerId)
    .is("completed_at", null)
    .order("due_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);
  if (open.error) fail(open.error);

  let followUpId: string;
  let action: SetFollowUpResult["action"];
  const existing = open.data?.[0];
  if (existing) {
    const patch: Database["public"]["Tables"]["follow_ups"]["Update"] = { due_at: dueAt };
    if (input.note !== undefined) patch.note = input.note;
    const updated = await active.supabase.from("follow_ups").update(patch).eq("id", existing.id).select("id");
    if (updated.error) fail(updated.error);
    if (!updated.data?.[0]) throw new AppError("not_found");
    followUpId = updated.data[0].id;
    action = "rescheduled";
  } else {
    const inserted = await active.supabase
      .from("follow_ups")
      .insert({ lead_id: id, user_id: ownerId, due_at: dueAt, note: input.note ?? null })
      .select("id");
    if (inserted.error) {
      // RLS refusing the insert means the lead is not the caller's (e.g. reassigned a moment ago).
      if (inserted.error.code === "42501") throw new AppError("not_found");
      fail(inserted.error);
    }
    if (!inserted.data?.[0]) throw new AppError("not_found");
    followUpId = inserted.data[0].id;
    action = "created";
  }

  const refreshed = await active.supabase.from("leads").select("next_follow_up_at").eq("id", id).maybeSingle();
  if (refreshed.error) fail(refreshed.error);
  return { followUpId, action, nextFollowUpAt: refreshed.data?.next_follow_up_at ?? null };
}

/** Marks an unheard voicemail as handled. Voicemails the caller cannot access are not_found. */
export async function markVoicemailHeard(ctx: RequestContext | null, callId: unknown): Promise<{ callId: string }> {
  const active = requireActive(ctx);
  const id = parseId(callId);
  const { data, error } = await active.supabase.rpc("mark_voicemail_heard", { p_call_id: id });
  if (error) fail(error);
  if (data !== true) throw new AppError("not_found");
  return { callId: id };
}

// ---------------------------------------------------------------------------------------------
// Admin only
// ---------------------------------------------------------------------------------------------

const leadDetailsSchema = z
  .object({
    businessName: z.string().trim().min(1, "Business name is required.").max(200, "Business name is too long."),
    contactName: optionalText(200),
    phone: z.string().max(100, "Enter a valid phone number."),
    email: z
      .string()
      .max(320)
      .nullish()
      .transform((value) => (value ?? "").trim())
      .pipe(z.union([z.literal(""), z.email("Enter a valid email address.")]))
      .transform((value) => (value === "" ? null : value.toLowerCase())),
    website: optionalText(2048),
    address: optionalText(300),
    city: optionalText(200),
    state: optionalText(100),
    country: optionalText(100),
    source: optionalText(MAX_SOURCE_LENGTH),
  })
  .partial()
  .strict();

export type LeadDetailsInput = z.input<typeof leadDetailsSchema>;

export async function updateLeadDetails(
  ctx: RequestContext | null,
  id: unknown,
  fields: unknown,
): Promise<LeadRecord> {
  const admin = requireAdmin(ctx);
  const leadId = parseId(id);
  const input = leadDetailsSchema.parse(fields ?? {});

  const { data: current, error: currentError } = await admin.supabase
    .from("leads")
    .select("id, phone")
    .eq("id", leadId)
    .maybeSingle();
  if (currentError) fail(currentError);
  if (!current) throw new AppError("not_found");

  const patch: Database["public"]["Tables"]["leads"]["Update"] = {};
  if (input.businessName !== undefined) patch.business_name = input.businessName;
  if (input.contactName !== undefined) patch.contact_name = input.contactName;
  if (input.phone !== undefined) {
    const normalized = normalizePhone(input.phone);
    if (!normalized.ok) throw new AppError("validation", "Enter a valid phone number.");
    if (normalized.e164 !== current.phone) {
      patch.phone = normalized.e164;
      patch.phone_raw = input.phone.trim();
    }
  }
  if (input.email !== undefined) patch.email = input.email;
  if (input.website !== undefined) {
    patch.website = input.website;
    patch.website_domain = normalizeWebsiteDomain(input.website);
  }
  if (input.address !== undefined) patch.address = input.address;
  if (input.city !== undefined) patch.city = input.city;
  if (input.state !== undefined) patch.state = input.state;
  if (input.country !== undefined) patch.country = input.country;
  if (input.source !== undefined) patch.source = input.source;

  const { data, error } = await admin.supabase.from("leads").update(patch).eq("id", leadId).select(LEAD_COLUMNS);
  if (error) fail(error);
  const updated = data?.[0];
  if (!updated) throw new AppError("not_found");
  return toLeadRecord(updated);
}

export async function reassignLead(
  ctx: RequestContext | null,
  id: unknown,
  toUserId: unknown,
): Promise<{ id: string; assignedTo: string | null }> {
  const admin = requireAdmin(ctx);
  const leadId = parseId(id);
  const target = uuidSchema.nullable().safeParse(toUserId ?? null);
  if (!target.success) throw new AppError("validation", "Choose an active agent or Unassigned.");

  const { data, error } = await admin.supabase.rpc("reassign_leads", {
    p_lead_ids: [leadId],
    // The generated type says string, but the RPC accepts null (= unassign).
    p_to_user_id: target.data as string,
  });
  if (error) {
    if (error.code === "22023") throw new AppError("validation", "Choose an active agent or Unassigned.");
    fail(error);
  }
  if (data !== 1) throw new AppError("not_found");
  return { id: leadId, assignedTo: target.data };
}

/** Hard delete. Calls and follow-ups cascade. */
export async function deleteLead(ctx: RequestContext | null, id: unknown): Promise<{ id: string }> {
  const admin = requireAdmin(ctx);
  const leadId = parseId(id);
  const { data, error } = await admin.supabase.from("leads").delete().eq("id", leadId).select("id");
  if (error) fail(error);
  if (!data?.[0]) throw new AppError("not_found");
  return { id: leadId };
}
