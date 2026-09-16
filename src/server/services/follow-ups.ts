import { z } from "zod";
import { FOLLOW_UP_LIST_TABS, FOLLOW_UPS_PAGE_SIZE, type FollowUpListTab } from "@/components/follow-ups/params";
import { pageWindow, type PageWindow } from "@/components/leads/list-params";
import type { Database } from "@/lib/database.types";
import type { LeadStatus } from "@/lib/domain/statuses";
import { followUpQuickPicks, tryZonedLocalInputToUtc } from "@/lib/domain/time";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { countSkippedLeads } from "@/server/services/skipped-leads";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Same window as `log_call` (DEVIATIONS D21). */
const MAX_DAYS_AHEAD = 1825;
const MAX_PAGE = 100_000;

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

const pageSchema = z.number().int().min(1).max(MAX_PAGE);

function parsePage(page: unknown): number {
  const parsed = pageSchema.safeParse(page ?? 1);
  if (!parsed.success) throw new AppError("validation", "Choose a valid page.");
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

export interface FollowUpRow {
  id: string;
  leadId: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  leadStatus: LeadStatus;
  dueAt: string;
  completedAt: string | null;
  note: string | null;
  /** Admins only; always null for agents. */
  ownerName: string | null;
}

export interface FollowUpListResult extends PageWindow {
  tab: FollowUpListTab;
  rows: FollowUpRow[];
}

type ListFollowUpsRow = Database["public"]["Functions"]["list_follow_ups"]["Returns"][number];

const listTabSchema = z.enum(FOLLOW_UP_LIST_TABS);

export async function listFollowUps(
  ctx: RequestContext | null,
  tab: unknown,
  page: unknown = 1,
): Promise<FollowUpListResult> {
  const active = requireActive(ctx);
  const parsedTab = listTabSchema.safeParse(tab);
  if (!parsedTab.success) throw new AppError("validation", "Choose a valid tab.");
  const pageNumber = parsePage(page);
  const isAdmin = active.profile.role === "ADMIN";

  const args = { p_tab: parsedTab.data, p_limit: FOLLOW_UPS_PAGE_SIZE, p_offset: (pageNumber - 1) * FOLLOW_UPS_PAGE_SIZE };
  const { data, error } = await active.supabase.rpc("list_follow_ups", args);
  if (error) fail(error);
  const rows = (data ?? []) as ListFollowUpsRow[];

  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && pageNumber > 1) {
    // Past the last page the window function has no row to report the total on.
    const probe = await active.supabase.rpc("list_follow_ups", { ...args, p_limit: 1, p_offset: 0 });
    if (probe.error) fail(probe.error);
    const firstRow = (probe.data ?? [])[0] as ListFollowUpsRow | undefined;
    total = firstRow ? Number(firstRow.total_count) : 0;
  }

  return {
    ...pageWindow(pageNumber, FOLLOW_UPS_PAGE_SIZE, total, rows.length),
    tab: parsedTab.data,
    rows: rows.map((row) => ({
      id: row.follow_up_id,
      leadId: row.lead_id,
      businessName: row.business_name,
      contactName: row.contact_name ?? null,
      phone: row.phone,
      leadStatus: row.lead_status,
      dueAt: row.due_at,
      completedAt: row.completed_at ?? null,
      note: row.note ?? null,
      ownerName: isAdmin ? (row.owner_name ?? null) : null,
    })),
  };
}

export interface FollowUpCounts {
  overdue: number;
  today: number;
  upcoming: number;
  completed: number;
  /** Every voicemail the Voicemails tab lists: what its badge shows. */
  voicemailsTotal: number;
  /** The subset that has not been heard: drives the alert styling and the nav badge. */
  voicemailsUnheard: number;
  /** Open skips in the Skipped queue (own for an agent, the team's for an admin). */
  skipped: number;
}

const count = z.number().int().nonnegative();
const countsSchema = z.object({
  overdue: count,
  today: count,
  upcoming: count,
  completed: count,
  voicemails_unheard: count,
  voicemails_total: count,
});

/** Tab badge counts, scoped exactly like the lists. */
export async function followUpCounts(ctx: RequestContext | null): Promise<FollowUpCounts> {
  const active = requireActive(ctx);
  const [{ data, error }, skipped] = await Promise.all([active.supabase.rpc("follow_up_tab_counts"), countSkippedLeads(active)]);
  if (error) fail(error);
  const parsed = countsSchema.safeParse(data);
  if (!parsed.success) throw new AppError("internal", undefined, { cause: parsed.error });
  return {
    overdue: parsed.data.overdue,
    today: parsed.data.today,
    upcoming: parsed.data.upcoming,
    completed: parsed.data.completed,
    voicemailsTotal: parsed.data.voicemails_total,
    voicemailsUnheard: parsed.data.voicemails_unheard,
    skipped,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations (user session; RLS decides which follow-ups exist for the caller)
// ---------------------------------------------------------------------------------------------

/** Completes an open follow-up. Completed, inaccessible, missing and malformed ids are all not_found. */
export async function completeFollowUp(
  ctx: RequestContext | null,
  id: unknown,
): Promise<{ id: string; completedAt: string }> {
  const active = requireActive(ctx);
  const followUpId = parseId(id);
  const { data, error } = await active.supabase
    .from("follow_ups")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", followUpId)
    .is("completed_at", null)
    .select("id, completed_at");
  if (error) {
    if (error.code === "42501") throw new AppError("not_found");
    fail(error);
  }
  const updated = data?.[0];
  if (!updated || !updated.completed_at) throw new AppError("not_found");
  return { id: updated.id, completedAt: updated.completed_at };
}

export const FOLLOW_UP_TIME_MESSAGE = "Pick a follow-up time in the future, within five years.";

const dueAtSchema = z.iso
  .datetime({ offset: true, message: "Pick a valid date and time." })
  .refine((value) => {
    const time = Date.parse(value);
    const now = Date.now();
    return time >= now - MINUTE_MS && time <= now + MAX_DAYS_AHEAD * DAY_MS;
  }, FOLLOW_UP_TIME_MESSAGE);

/** Moves an open follow-up to `dueAtIso`. Completed, inaccessible, missing and malformed ids are not_found. */
export async function rescheduleFollowUp(
  ctx: RequestContext | null,
  id: unknown,
  dueAtIso: unknown,
): Promise<{ id: string; dueAt: string }> {
  const active = requireActive(ctx);
  const followUpId = parseId(id);
  const parsedDue = dueAtSchema.safeParse(dueAtIso);
  if (!parsedDue.success) {
    throw new AppError("validation", parsedDue.error.issues[0]?.message ?? FOLLOW_UP_TIME_MESSAGE, { cause: parsedDue.error });
  }
  const dueAt = new Date(parsedDue.data).toISOString();

  const { data, error } = await active.supabase
    .from("follow_ups")
    .update({ due_at: dueAt })
    .eq("id", followUpId)
    .is("completed_at", null)
    .select("id, due_at");
  if (error) {
    if (error.code === "42501") throw new AppError("not_found");
    fail(error);
  }
  const updated = data?.[0];
  if (!updated) throw new AppError("not_found");
  return { id: updated.id, dueAt: updated.due_at };
}

export const RESCHEDULE_QUICK_PICKS = ["tomorrow9am", "in3Days", "nextWeek"] as const;
export type RescheduleQuickPick = (typeof RESCHEDULE_QUICK_PICKS)[number];

const rescheduleChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quick"), pick: z.enum(RESCHEDULE_QUICK_PICKS) }).strict(),
  z.object({ kind: z.literal("custom"), local: z.string().max(32) }).strict(),
]);

/** Quick pick or a `datetime-local` value; both are resolved in the caller's profile time zone on the server. */
export type RescheduleChoice = z.input<typeof rescheduleChoiceSchema>;

/** UTC instant for a reschedule choice in `tz`, or null when a custom value is not a valid local date-time. */
export function resolveRescheduleChoice(tz: string, choice: RescheduleChoice, now: number = Date.now()): Date | null {
  if (choice.kind === "quick") return followUpQuickPicks(tz, now)[choice.pick];
  return tryZonedLocalInputToUtc(choice.local, tz);
}

export async function rescheduleFollowUpTo(
  ctx: RequestContext | null,
  id: unknown,
  choice: unknown,
): Promise<{ id: string; dueAt: string }> {
  const active = requireActive(ctx);
  const followUpId = parseId(id);
  const parsed = rescheduleChoiceSchema.safeParse(choice);
  if (!parsed.success) throw new AppError("validation", "Pick a follow-up time.");
  const due = resolveRescheduleChoice(active.profile.timezone, parsed.data);
  if (!due) throw new AppError("validation", "Pick a date and time.");
  return rescheduleFollowUp(active, followUpId, due.toISOString());
}

// ---------------------------------------------------------------------------------------------
// Voicemails tab
// ---------------------------------------------------------------------------------------------

export interface VoicemailRow {
  callId: string;
  createdAt: string;
  leadId: string | null;
  businessName: string | null;
  contactName: string | null;
  /** Lead phone, or the caller's number for an unmatched call. */
  phone: string | null;
  leadStatus: LeadStatus | null;
  durationSeconds: number | null;
  unheard: boolean;
  /**
   * Whether playing it should mark it heard (D20). Agents only see their own voicemails. For admins: unmatched
   * calls and leads that are unassigned or assigned to the admin (the server makes the final decision).
   */
  canMarkHeard: boolean;
}

export interface VoicemailListResult extends PageWindow {
  unheardOnly: boolean;
  rows: VoicemailRow[];
}

type ListVoicemailsRow = Database["public"]["Functions"]["list_voicemails"]["Returns"][number];

const voicemailListSchema = z
  .object({
    unheardOnly: z.boolean().optional().default(false),
    page: pageSchema.optional().default(1),
  })
  .strict();

export type ListVoicemailsInput = z.input<typeof voicemailListSchema>;

export async function listVoicemails(
  ctx: RequestContext | null,
  input: ListVoicemailsInput = {},
): Promise<VoicemailListResult> {
  const active = requireActive(ctx);
  const parsed = voicemailListSchema.safeParse(input ?? {});
  if (!parsed.success) throw new AppError("validation", "Choose a valid page.");
  const { unheardOnly, page } = parsed.data;
  const isAdmin = active.profile.role === "ADMIN";

  const args = {
    p_unheard_only: unheardOnly,
    p_limit: FOLLOW_UPS_PAGE_SIZE,
    p_offset: (page - 1) * FOLLOW_UPS_PAGE_SIZE,
  };
  const { data, error } = await active.supabase.rpc("list_voicemails", args);
  if (error) fail(error);
  const rows = (data ?? []) as ListVoicemailsRow[];

  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && page > 1) {
    const probe = await active.supabase.rpc("list_voicemails", { ...args, p_limit: 1, p_offset: 0 });
    if (probe.error) fail(probe.error);
    const firstRow = (probe.data ?? [])[0] as ListVoicemailsRow | undefined;
    total = firstRow ? Number(firstRow.total_count) : 0;
  }

  // Admins only: which listed leads belong to someone else, so an admin play leaves them unheard (D20).
  const ownerByLead = new Map<string, string | null>();
  if (isAdmin) {
    const leadIds = [...new Set(rows.map((row) => row.lead_id).filter((id): id is string => typeof id === "string"))];
    if (leadIds.length > 0) {
      const owners = await active.supabase.from("leads").select("id, assigned_to").in("id", leadIds);
      if (owners.error) fail(owners.error);
      for (const lead of owners.data ?? []) ownerByLead.set(lead.id, lead.assigned_to);
    }
  }

  return {
    ...pageWindow(page, FOLLOW_UPS_PAGE_SIZE, total, rows.length),
    unheardOnly,
    rows: rows.map((row) => {
      const leadId = row.lead_id ?? null;
      const owner = leadId === null ? null : (ownerByLead.get(leadId) ?? null);
      return {
        callId: row.call_id,
        createdAt: row.created_at,
        leadId,
        businessName: row.business_name ?? null,
        contactName: row.contact_name ?? null,
        phone: row.phone ?? null,
        leadStatus: row.lead_status ?? null,
        durationSeconds: row.voicemail_duration_seconds ?? null,
        unheard: row.handled_at === null || row.handled_at === undefined,
        canMarkHeard: !isAdmin || leadId === null || owner === null || owner === active.userId,
      };
    }),
  };
}
