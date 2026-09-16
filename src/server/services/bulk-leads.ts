import { z } from "zod";
import { MAX_QUERY_LENGTH, MAX_SOURCE_LENGTH } from "@/components/leads/list-params";
import {
  MAX_BULK_LEADS,
  MAX_BULK_NOTE_LENGTH,
  type BulkAssignResult,
  type BulkAssignUndo,
  type BulkCountResult,
  type BulkFollowUpResult,
  type BulkStatusResult,
  type BulkStatusUndo,
  type BulkUndoResult,
} from "@/lib/domain/bulk-leads";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, toAppError, type PostgrestLikeError } from "@/server/errors";

// Bulk lead actions from the Leads list (docs/DEVIATIONS.md D41). Every call runs with the caller's own session
// and the SECURITY INVOKER functions in 20260915001600_bulk_leads.sql, so RLS and the guard triggers scope a
// bulk action exactly like the single-lead actions in services/leads.ts.

const uuidSchema = z.uuid();

const leadIdsSchema = z
  .array(z.string(), { message: "Select at least one lead." })
  .min(1, "Select at least one lead.")
  .max(MAX_BULK_LEADS, `Select at most ${MAX_BULK_LEADS.toLocaleString("en-US")} leads at a time.`)
  .transform((ids, ctx) => {
    const unique = new Set<string>();
    for (const raw of ids) {
      const parsed = uuidSchema.safeParse(raw.trim().toLowerCase());
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "The selection is out of date. Clear it and select the leads again." });
        return z.NEVER;
      }
      unique.add(parsed.data);
    }
    return [...unique];
  });

const statusSchema = z.enum(LEAD_STATUSES, { message: "Choose a valid status." });

const targetUserSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  uuidSchema.nullable(),
);

function isTooMany(error: PostgrestLikeError): boolean {
  return error.code === "22023" && (error.message ?? "").includes("too_many_leads");
}

function fail(error: PostgrestLikeError): never {
  if (isTooMany(error)) {
    throw new AppError("validation", `Select at most ${MAX_BULK_LEADS.toLocaleString("en-US")} leads at a time.`, { cause: error });
  }
  throw mapPostgrestError(error);
}

/** Validation failures are AppError("validation") with the first issue's message, like the other services. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw toAppError(result.error);
  return result.data;
}

function parseIds(leadIds: unknown): string[] {
  return parse(leadIdsSchema, leadIds);
}

// ---------------------------------------------------------------------------------------------
// Select all matching
// ---------------------------------------------------------------------------------------------

const matchingFiltersSchema = z
  .object({
    query: z.string().max(1000).optional().transform((q) => (q ?? "").trim().slice(0, MAX_QUERY_LENGTH)),
    statuses: z.array(statusSchema).max(LEAD_STATUSES.length * 2).optional().default([]),
    source: z
      .string()
      .max(MAX_SOURCE_LENGTH)
      .nullish()
      .transform((value) => {
        const trimmed = value?.trim() ?? "";
        return trimmed === "" ? null : trimmed;
      }),
    agentId: uuidSchema.nullish(),
    unassigned: z.boolean().optional().default(false),
  })
  .strict();

export type MatchingLeadFilters = z.input<typeof matchingFiltersSchema>;

export interface MatchingLeadIds {
  ids: string[];
  /** Every lead matching the filters; more than `ids.length` when the selection cap cut it short. */
  total: number;
}

/** The ids behind "Select all N matching": the same visibility and filters as the Leads list, capped. */
export async function listMatchingLeadIds(ctx: RequestContext | null, filters: unknown): Promise<MatchingLeadIds> {
  const active = requireActive(ctx);
  const params = parse(matchingFiltersSchema, filters ?? {});
  const isAdmin = active.profile.role === "ADMIN";

  const args: {
    p_limit: number;
    p_query?: string;
    p_statuses?: LeadStatus[];
    p_source?: string;
    p_assigned_to?: string;
    p_unassigned?: boolean;
  } = { p_limit: MAX_BULK_LEADS };
  if (params.query !== "") args.p_query = params.query;
  if (params.statuses.length > 0) args.p_statuses = [...new Set(params.statuses)];
  if (params.source !== null) args.p_source = params.source;
  if (isAdmin) {
    if (params.unassigned) args.p_unassigned = true;
    else if (params.agentId) args.p_assigned_to = params.agentId;
  }

  const { data, error } = await active.supabase.rpc("search_lead_ids", args);
  if (error) fail(error);
  const rows = data ?? [];
  return { ids: rows.map((row) => row.id), total: rows.length > 0 ? Number(rows[0].total_count) : 0 };
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

type StatusRow = { lead_id: string; previous_status: LeadStatus; result: string };

async function runStatus(active: RequestContext, ids: string[], status: LeadStatus, expected: LeadStatus | null): Promise<StatusRow[]> {
  const { data, error } = await active.supabase.rpc("bulk_set_lead_status", {
    p_lead_ids: ids,
    p_status: status,
    // The generated type says the default is required; null means "any current status".
    p_expected_status: expected as LeadStatus,
  });
  if (error) fail(error);
  return (data ?? []) as StatusRow[];
}

/** Moves every selected lead the caller may change to `status`, and returns what an undo needs. */
export async function bulkUpdateStatus(ctx: RequestContext | null, leadIds: unknown, status: unknown): Promise<BulkStatusResult> {
  const active = requireActive(ctx);
  const ids = parseIds(leadIds);
  const target = parse(statusSchema, status);
  const rows = await runStatus(active, ids, target, null);

  const groups = new Map<LeadStatus, string[]>();
  let updated = 0;
  let locked = 0;
  for (const row of rows) {
    if (row.result === "updated") {
      updated += 1;
      groups.set(row.previous_status, [...(groups.get(row.previous_status) ?? []), row.lead_id]);
    } else if (row.result === "locked") {
      locked += 1;
    }
  }
  return {
    requested: ids.length,
    updated,
    locked,
    unchanged: rows.length - updated - locked,
    missing: ids.length - rows.length,
    undo: updated > 0 ? { kind: "status", applied: target, groups: [...groups].map(([previous, groupIds]) => ({ status: previous, ids: groupIds })) } : null,
  };
}

const statusUndoSchema = z
  .object({
    kind: z.literal("status"),
    applied: statusSchema,
    groups: z
      .array(z.object({ status: statusSchema, ids: leadIdsSchema }).strict())
      .min(1)
      .max(LEAD_STATUSES.length),
  })
  .strict()
  .refine((undo) => undo.groups.reduce((sum, group) => sum + group.ids.length, 0) <= MAX_BULK_LEADS, "There is too much to undo at once.");

/** Puts each lead back to its previous status, but only leads still at the status the bulk action set. */
export async function undoBulkStatus(ctx: RequestContext | null, undo: unknown): Promise<BulkUndoResult> {
  const active = requireActive(ctx);
  const parsed: BulkStatusUndo = parse(statusUndoSchema, undo);
  let restored = 0;
  let skipped = 0;
  for (const group of parsed.groups) {
    const rows = await runStatus(active, group.ids, group.status, parsed.applied);
    const done = rows.filter((row) => row.result === "updated").length;
    restored += done;
    skipped += group.ids.length - done;
  }
  return { restored, skipped, failed: 0 };
}

// ---------------------------------------------------------------------------------------------
// Assignment (admin)
// ---------------------------------------------------------------------------------------------

type AssignRow = { lead_id: string; previous_assigned_to: string | null; result: string };

async function runAssign(
  admin: RequestContext,
  ids: string[],
  toUserId: string | null,
  expected: { owner: string | null } | null,
): Promise<AssignRow[]> {
  const { data, error } = await admin.supabase.rpc("bulk_assign_leads", {
    p_lead_ids: ids,
    // The generated types say string; the function takes null for "unassigned".
    p_to_user_id: toUserId as string,
    p_expected_assigned_to: (expected?.owner ?? null) as string,
    p_match_expected: expected !== null,
  });
  if (error) {
    if (error.code === "22023" && !isTooMany(error)) {
      throw new AppError("validation", "Choose an active agent or Unassigned.", { cause: error });
    }
    fail(error);
  }
  return (data ?? []) as AssignRow[];
}

/** Assigns every selected lead to `toUserId`, or unassigns them (null). Open follow-ups move with them. */
export async function bulkAssign(ctx: RequestContext | null, leadIds: unknown, toUserId: unknown): Promise<BulkAssignResult> {
  const admin = requireAdmin(ctx);
  const ids = parseIds(leadIds);
  const target = targetUserSchema.safeParse(toUserId);
  if (!target.success) throw new AppError("validation", "Choose an active agent or Unassigned.");
  const rows = await runAssign(admin, ids, target.data, null);

  const groups = new Map<string | null, string[]>();
  let updated = 0;
  for (const row of rows) {
    if (row.result !== "updated") continue;
    updated += 1;
    groups.set(row.previous_assigned_to, [...(groups.get(row.previous_assigned_to) ?? []), row.lead_id]);
  }
  return {
    requested: ids.length,
    updated,
    unchanged: rows.length - updated,
    missing: ids.length - rows.length,
    undo:
      updated > 0
        ? { kind: "assign", applied: target.data, groups: [...groups].map(([assignedTo, groupIds]) => ({ assignedTo, ids: groupIds })) }
        : null,
  };
}

const assignUndoSchema = z
  .object({
    kind: z.literal("assign"),
    applied: uuidSchema.nullable(),
    groups: z
      .array(z.object({ assignedTo: uuidSchema.nullable(), ids: leadIdsSchema }).strict())
      .min(1)
      .max(MAX_BULK_LEADS),
  })
  .strict()
  .refine((undo) => undo.groups.reduce((sum, group) => sum + group.ids.length, 0) <= MAX_BULK_LEADS, "There is too much to undo at once.");

/**
 * Gives each lead back to its previous owner, but only leads still owned by whoever the bulk action assigned
 * them to. A previous owner who can no longer take leads (disabled or deleted) keeps nothing: those leads stay.
 */
export async function undoBulkAssign(ctx: RequestContext | null, undo: unknown): Promise<BulkUndoResult> {
  const admin = requireAdmin(ctx);
  const parsed: BulkAssignUndo = parse(assignUndoSchema, undo);
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const group of parsed.groups) {
    try {
      const rows = await runAssign(admin, group.ids, group.assignedTo, { owner: parsed.applied });
      const done = rows.filter((row) => row.result === "updated").length;
      restored += done;
      skipped += group.ids.length - done;
    } catch (error) {
      if (error instanceof AppError && error.code === "validation") {
        failed += group.ids.length;
        continue;
      }
      throw error;
    }
  }
  return { restored, skipped, failed };
}

// ---------------------------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------------------------

const YEAR_MS = 365 * 86_400_000;

const followUpSchema = z
  .object({
    dueAt: z.iso
      .datetime({ offset: true, message: "Pick a valid date and time." })
      .refine((value) => {
        const time = Date.parse(value);
        return time > Date.now() - 86_400_000 && time < Date.now() + 5 * YEAR_MS;
      }, "Pick a date between today and five years from now."),
    note: z
      .string()
      .max(MAX_BULK_NOTE_LENGTH, `The note can be at most ${MAX_BULK_NOTE_LENGTH} characters.`)
      .nullish()
      .transform((value) => (value === undefined ? undefined : (value ?? "").trim() || null)),
  })
  .strict();

/**
 * The lead page's follow-up picker, for every selected lead: moves the earliest open follow-up of the lead's
 * owner (the caller on unassigned leads) or creates one. `note` undefined keeps existing notes.
 */
export async function bulkScheduleFollowUp(
  ctx: RequestContext | null,
  leadIds: unknown,
  dueAtIso: unknown,
  note?: unknown,
): Promise<BulkFollowUpResult> {
  const active = requireActive(ctx);
  const ids = parseIds(leadIds);
  const input = parse(followUpSchema, { dueAt: dueAtIso, note });
  const { data, error } = await active.supabase.rpc("bulk_schedule_follow_ups", {
    p_lead_ids: ids,
    p_due_at: new Date(input.dueAt).toISOString(),
    p_note: (input.note ?? null) as string,
    p_set_note: input.note !== undefined,
  });
  if (error) {
    if (error.code === "22023" && !isTooMany(error)) {
      throw new AppError("validation", "Pick a date between today and five years from now.", { cause: error });
    }
    fail(error);
  }
  const rows = data ?? [];
  const created = rows.filter((row) => row.result === "created").length;
  return { requested: ids.length, created, rescheduled: rows.length - created, missing: ids.length - rows.length };
}

/** Completes every open follow-up the caller can see on the selected leads ("Clear follow-ups"). */
export async function bulkCompleteFollowUps(ctx: RequestContext | null, leadIds: unknown): Promise<BulkCountResult> {
  const active = requireActive(ctx);
  const ids = parseIds(leadIds);
  const { data, error } = await active.supabase.rpc("bulk_complete_follow_ups", { p_lead_ids: ids });
  if (error) fail(error);
  return { requested: ids.length, count: typeof data === "number" ? data : 0 };
}

// ---------------------------------------------------------------------------------------------
// Admin only: source and delete
// ---------------------------------------------------------------------------------------------

const sourceSchema = z
  .string({ message: "Enter a source, or leave it empty to clear it." })
  .max(MAX_SOURCE_LENGTH, `The source can be at most ${MAX_SOURCE_LENGTH} characters.`)
  .nullable()
  .transform((value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  });

export async function bulkSetSource(ctx: RequestContext | null, leadIds: unknown, source: unknown): Promise<BulkCountResult & { source: string | null }> {
  const admin = requireAdmin(ctx);
  const ids = parseIds(leadIds);
  const value = parse(sourceSchema, source ?? null);
  const { data, error } = await admin.supabase.rpc("bulk_set_lead_source", { p_lead_ids: ids, p_source: value as string });
  if (error) fail(error);
  return { requested: ids.length, count: typeof data === "number" ? data : 0, source: value };
}

/** Hard delete of the selected leads; their calls and follow-ups go with them (SPEC 4). */
export async function bulkDelete(ctx: RequestContext | null, leadIds: unknown): Promise<BulkCountResult> {
  const admin = requireAdmin(ctx);
  const ids = parseIds(leadIds);
  const { data, error } = await admin.supabase.rpc("bulk_delete_leads", { p_lead_ids: ids });
  if (error) fail(error);
  return { requested: ids.length, count: typeof data === "number" ? data : 0 };
}

/** Validates a selection posted to the export route. */
export function parseSelectedLeadIds(leadIds: unknown): string[] {
  return parseIds(leadIds);
}
