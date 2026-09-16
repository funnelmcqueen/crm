import { z } from "zod";
import { FOLLOW_UPS_PAGE_SIZE } from "@/components/follow-ups/params";
import { pageWindow, type PageWindow } from "@/components/leads/list-params";
import {
  MAX_SKIP_NOTE_LENGTH,
  SKIP_REASONS,
  isSkipReason,
  isSkipResolution,
  type SkipReason,
  type SkipResolution,
} from "@/lib/domain/skips";
import type { LeadStatus } from "@/lib/domain/statuses";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, toAppError, type PostgrestLikeError } from "@/server/errors";

// Skipped queue (docs/DEVIATIONS.md D42). Writes go through skip_lead / resume_skipped_lead; reads use RLS on
// lead_skips (own skips on own leads for an agent, everything for an admin). Queue actions other than Resume
// reuse the existing services (status, follow-up, reassign): the triggers in 20260915001700_skipped_leads.sql
// close the skip when those change the lead.

const uuidSchema = z.uuid();
const MAX_PAGE = 100_000;
const HISTORY_LIMIT = 20;

function parseId(id: unknown): string {
  const parsed = uuidSchema.safeParse(typeof id === "string" ? id.trim().toLowerCase() : id);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

/** Validation failures are AppError("validation") with the first issue's message, like the other services. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw toAppError(result.error);
  return result.data;
}

const skipInputSchema = z
  .object({
    reason: z.enum(SKIP_REASONS, { message: "Choose a reason from the list." }).nullish(),
    note: z
      .string()
      .max(MAX_SKIP_NOTE_LENGTH, `The note can be at most ${MAX_SKIP_NOTE_LENGTH} characters.`)
      .nullish()
      .transform((value) => (value ?? "").trim() || null),
  })
  .strict();

/** Saves a skip on the caller's own lead. Leads the caller does not own are not_found. */
export async function skipLead(
  ctx: RequestContext | null,
  leadId: unknown,
  input: unknown = {},
): Promise<{ skipId: string; leadId: string }> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const values = parse(skipInputSchema, input ?? {});
  const { data, error } = await active.supabase.rpc("skip_lead", {
    p_lead_id: id,
    p_reason: (values.reason ?? null) as string,
    p_note: values.note as string,
  });
  if (error) fail(error);
  if (typeof data !== "string") throw new AppError("internal");
  return { skipId: data, leadId: id };
}

/** "Resume calling": closes the open skip so the lead is back in the call queue. */
export async function resumeSkippedLead(ctx: RequestContext | null, leadId: unknown): Promise<{ leadId: string; resumed: number }> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const { data, error } = await active.supabase.rpc("resume_skipped_lead", { p_lead_id: id });
  if (error) fail(error);
  const resumed = typeof data === "number" ? data : 0;
  if (resumed === 0) throw new AppError("not_found", "This lead is no longer in your Skipped queue.");
  return { leadId: id, resumed };
}

export interface SkippedLeadRow {
  skipId: string;
  leadId: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  leadStatus: LeadStatus;
  reason: SkipReason | null;
  note: string | null;
  skippedAt: string;
  nextFollowUpAt: string | null;
  /** Admins only (null for agents). */
  assignedTo: string | null;
  ownerName: string | null;
}

export interface SkippedLeadList extends PageWindow {
  rows: SkippedLeadRow[];
}

const pageSchema = z.number().int().min(1).max(MAX_PAGE);

/** The Skipped queue, longest-waiting first, one page. */
export async function listSkippedLeads(ctx: RequestContext | null, page: unknown = 1): Promise<SkippedLeadList> {
  const active = requireActive(ctx);
  const parsedPage = pageSchema.safeParse(page ?? 1);
  if (!parsedPage.success) throw new AppError("validation", "Choose a valid page.");
  const pageNumber = parsedPage.data;
  const isAdmin = active.profile.role === "ADMIN";

  const args = { p_limit: FOLLOW_UPS_PAGE_SIZE, p_offset: (pageNumber - 1) * FOLLOW_UPS_PAGE_SIZE };
  const { data, error } = await active.supabase.rpc("list_skipped_leads", args);
  if (error) fail(error);
  const rows = data ?? [];

  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && pageNumber > 1) {
    total = await countSkippedLeads(active);
  }

  return {
    ...pageWindow(pageNumber, FOLLOW_UPS_PAGE_SIZE, total, rows.length),
    rows: rows.map((row) => ({
      skipId: row.skip_id,
      leadId: row.lead_id,
      businessName: row.business_name,
      contactName: row.contact_name ?? null,
      phone: row.phone,
      leadStatus: row.lead_status,
      reason: isSkipReason(row.reason) ? row.reason : null,
      note: row.note ?? null,
      skippedAt: row.skipped_at,
      nextFollowUpAt: row.next_follow_up_at ?? null,
      assignedTo: isAdmin ? (row.assigned_to ?? null) : null,
      ownerName: isAdmin ? (row.owner_name ?? null) : null,
    })),
  };
}

/** Open skips the caller can see: their own for an agent, the team's for an admin. */
export async function countSkippedLeads(ctx: RequestContext | null): Promise<number> {
  const active = requireActive(ctx);
  let query = active.supabase.from("lead_skips").select("id", { count: "exact", head: true }).is("resolved_at", null);
  // RLS already limits an agent to their own skips on their own leads; this keeps the query honest on its own.
  if (active.profile.role !== "ADMIN") query = query.eq("user_id", active.userId);
  const { count, error } = await query;
  if (error) fail(error);
  return count ?? 0;
}

export interface LeadSkipEntry {
  id: string;
  reason: SkipReason | null;
  note: string | null;
  skippedAt: string;
  resolvedAt: string | null;
  resolution: SkipResolution | null;
  /** Admins only: who skipped. */
  skippedBy: string | null;
}

/** Skip history on the lead page, newest first: the caller's own for an agent, everyone's for an admin. */
export async function getLeadSkipHistory(ctx: RequestContext | null, leadId: unknown): Promise<LeadSkipEntry[]> {
  const active = requireActive(ctx);
  const id = parseId(leadId);
  const isAdmin = active.profile.role === "ADMIN";
  let query = active.supabase
    .from("lead_skips")
    .select("id, user_id, reason, note, created_at, resolved_at, resolution")
    .eq("lead_id", id);
  if (!isAdmin) query = query.eq("user_id", active.userId);
  const { data, error } = await query.order("created_at", { ascending: false }).order("id", { ascending: true }).limit(HISTORY_LIMIT);
  if (error) fail(error);
  const rows = data ?? [];

  const names = new Map<string, string>();
  if (isAdmin && rows.length > 0) {
    const userIds = [...new Set(rows.map((row) => row.user_id))];
    const profiles = await active.supabase.from("profiles").select("id, name, email").in("id", userIds);
    if (profiles.error) fail(profiles.error);
    for (const profile of profiles.data ?? []) names.set(profile.id, profile.name || profile.email);
  }

  return rows.map((row) => ({
    id: row.id,
    reason: isSkipReason(row.reason) ? row.reason : null,
    note: row.note ?? null,
    skippedAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
    resolution: isSkipResolution(row.resolution) ? row.resolution : null,
    skippedBy: isAdmin ? (names.get(row.user_id) ?? "Unknown user") : null,
  }));
}
