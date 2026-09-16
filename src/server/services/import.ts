import { z } from "zod";
import {
  assigneeForPosition,
  checkImportRow,
  BATCH_FAILED_REASON,
  IMPORT_BATCH_SIZE,
  MAX_CELL_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_SPLIT_AGENTS,
  DUPLICATE_KEY_CHUNK_SIZE,
  type BatchAssignment,
  type BatchRowResult,
  type ExistingDuplicateLead,
} from "@/components/import/import-model";
import type { TablesInsert } from "@/lib/database.types";
import { IMPORT_FIELD_KEYS, missingRequiredImportFields } from "@/lib/domain/import-mapping";
import { requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, toAppError } from "@/server/errors";

// Admin-only CSV import (SPEC section 9). Every query runs with the admin's own session (RLS).

const uuidSchema = z.uuid();

/** Zod parse whose failure is an AppError('validation'), so services and actions report the same code. */
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw toAppError(result.error);
  return result.data;
}

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

export interface ImportAgentOption {
  id: string;
  name: string;
  email: string;
}

/** Active agents that imported leads can be assigned to. */
export async function listImportAgents(ctx: RequestContext | null): Promise<ImportAgentOption[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase
    .from("profiles")
    .select("id, name, email")
    .eq("role", "AGENT")
    .eq("active", true)
    .order("name", { ascending: true })
    .order("email", { ascending: true });
  if (error) throw mapPostgrestError(error);
  return (data ?? []).map((profile) => ({ id: profile.id, name: profile.name || profile.email, email: profile.email }));
}

// ---------------------------------------------------------------------------------------------
// Duplicates against the database
// ---------------------------------------------------------------------------------------------

const keyList = (max: number) => z.array(z.string().max(max)).max(DUPLICATE_KEY_CHUNK_SIZE);

const duplicateKeysSchema = z
  .object({
    phones: keyList(32),
    domains: keyList(300),
    nameKeys: keyList(1000),
  })
  .strict();

/** One chunk (at most 1000 keys per list) of the preview's duplicate check. */
export async function checkImportDuplicates(ctx: RequestContext | null, input: unknown): Promise<ExistingDuplicateLead[]> {
  const admin = requireAdmin(ctx);
  const keys = parseInput(duplicateKeysSchema, input);
  if (keys.phones.length === 0 && keys.domains.length === 0 && keys.nameKeys.length === 0) return [];

  const { data, error } = await admin.supabase.rpc("find_duplicate_leads", {
    p_phones: keys.phones,
    p_domains: keys.domains,
    p_name_keys: keys.nameKeys,
  });
  if (error) throw mapPostgrestError(error);
  return (data ?? []).map((row) => ({
    leadId: row.lead_id,
    businessName: row.business_name,
    city: row.city ?? null,
    phone: row.phone ?? null,
    websiteDomain: row.website_domain ?? null,
    nameCityKey: row.dedupe_name_key ?? null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Batch insert
// ---------------------------------------------------------------------------------------------

const mappingSchema = z
  .record(z.string().max(MAX_HEADER_LENGTH), z.enum(IMPORT_FIELD_KEYS).nullable())
  .refine((mapping) => Object.keys(mapping).length <= MAX_IMPORT_COLUMNS + 1, "Too many columns.");

const batchSchema = z
  .object({
    mapping: mappingSchema,
    appendUnmappedToNotes: z.boolean(),
    rows: z
      .array(
        z
          .object({
            rowIndex: z.number().int().min(0).max(MAX_IMPORT_ROWS - 1),
            position: z.number().int().min(0).max(MAX_IMPORT_ROWS - 1),
            cells: z
              .record(z.string().max(MAX_HEADER_LENGTH), z.string().max(MAX_CELL_LENGTH))
              .refine((cells) => Object.keys(cells).length <= MAX_IMPORT_COLUMNS + 1, "Too many columns."),
          })
          .strict(),
      )
      .min(1, "Nothing to import.")
      .max(IMPORT_BATCH_SIZE, `At most ${IMPORT_BATCH_SIZE} rows per batch.`),
  })
  .strict()
  .superRefine((batch, issue) => {
    if (new Set(batch.rows.map((row) => row.rowIndex)).size !== batch.rows.length) {
      issue.addIssue({ code: "custom", message: "Each row may appear only once." });
    }
    if (new Set(batch.rows.map((row) => row.position)).size !== batch.rows.length) {
      issue.addIssue({ code: "custom", message: "Each row may appear only once." });
    }
    if (missingRequiredImportFields(batch.mapping).length > 0) {
      issue.addIssue({ code: "custom", message: "Map the business name and phone columns first." });
    }
  });

const assignmentSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("unassigned") }).strict(),
  z.object({ mode: z.literal("agent"), agentId: uuidSchema }).strict(),
  z
    .object({
      mode: z.literal("split"),
      agentIds: z
        .array(uuidSchema)
        .min(1, "Choose at least one agent.")
        .max(MAX_SPLIT_AGENTS)
        .refine((ids) => new Set(ids).size === ids.length, "Choose each agent only once."),
      total: z.number().int().min(1).max(MAX_IMPORT_ROWS),
    })
    .strict(),
]);

export interface ImportBatchResult {
  results: BatchRowResult[];
}

const INVALID_AGENTS_MESSAGE = "Assign leads to active agents only. Reload the agent list and try again.";
const ROW_FAILED_REASON = "The database rejected this row.";

/**
 * Round trips the row-by-row fallback may spend before it gives up and reports the rest as retryable.
 * The fallback used to be linear, so one row the database rejected turned a single insert into up to
 * IMPORT_BATCH_SIZE (500) sequential requests inside one server action — 10-20 seconds at a realistic
 * 20-40ms each, enough to exceed a serverless function timeout and have the action killed mid-loop,
 * reporting the whole batch as failed even though many rows had committed.
 */
export const MAX_IMPORT_FALLBACK_REQUESTS = 64;

type PendingRow = { rowIndex: number; record: TablesInsert<"leads"> };

/**
 * Isolates the rows the database rejected by halving, not by walking: a single bad row costs O(log n)
 * round trips instead of O(n), and the rows around it still commit in bulk. The whole batch has already
 * failed once by the time this runs, so it starts from that batch's halves.
 */
async function insertPendingByBisect(admin: RequestContext, pending: readonly PendingRow[], results: BatchRowResult[]): Promise<void> {
  const stack: PendingRow[][] = [];
  const pushHalves = (slice: readonly PendingRow[]): void => {
    const middle = Math.floor(slice.length / 2);
    // Pushed largest-last so the halves are attempted in row order.
    stack.push(slice.slice(middle), slice.slice(0, middle));
  };
  pushHalves(pending);

  let requests = 0;
  while (stack.length > 0) {
    const slice = stack.pop();
    if (!slice || slice.length === 0) continue;
    if (requests >= MAX_IMPORT_FALLBACK_REQUESTS) {
      // Bounded work beats a perfect diagnosis: these rows are reported as retryable, which is what the
      // wizard's "download the rows, fix them, import that file again" loop already handles.
      for (const item of slice) results.push({ rowIndex: item.rowIndex, ok: false, reason: BATCH_FAILED_REASON });
      continue;
    }

    requests += 1;
    const { error } = await admin.supabase.from("leads").insert(slice.map((item) => item.record));
    if (!error) {
      for (const item of slice) results.push({ rowIndex: item.rowIndex, ok: true, leadId: item.record.id as string });
      continue;
    }
    if (isAuthError(error.code)) throw mapPostgrestError(error);
    if (slice.length === 1) {
      results.push({ rowIndex: slice[0].rowIndex, ok: false, reason: ROW_FAILED_REASON });
      continue;
    }
    pushHalves(slice);
  }
}

function agentIdsOf(assignment: BatchAssignment): string[] {
  if (assignment.mode === "agent") return [assignment.agentId];
  if (assignment.mode === "split") return assignment.agentIds;
  return [];
}

async function requireActiveAgents(admin: RequestContext, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const { data, error } = await admin.supabase.from("profiles").select("id, role, active").in("id", unique);
  if (error) throw mapPostgrestError(error);
  const found = new Map((data ?? []).map((profile) => [profile.id, profile]));
  const valid = unique.every((id) => {
    const profile = found.get(id);
    return profile !== undefined && profile.role === "AGENT" && profile.active;
  });
  if (!valid) throw new AppError("validation", INVALID_AGENTS_MESSAGE);
}

function isAuthError(code: string | undefined): boolean {
  return code === "42501" || code === "PGRST301" || code === "PGRST302" || code === "PGRST303";
}

/**
 * Inserts one batch (at most 500 rows) of CSV rows. Every row is re-validated and re-normalized here
 * from its raw cells; the owner comes from the assignment, whose agents must be active AGENTs. Returns
 * one result per row: the new lead id, or the reason the row was not saved. A database error on the
 * batch insert falls back to row-by-row inserts, so one bad row never loses the others.
 */
export async function importLeadsBatch(ctx: RequestContext | null, batchInput: unknown, assignmentInput: unknown): Promise<ImportBatchResult> {
  const admin = requireAdmin(ctx);
  const batch = parseInput(batchSchema, batchInput);
  const assignment = parseInput(assignmentSchema, assignmentInput);
  if (assignment.mode === "split" && batch.rows.some((row) => row.position >= assignment.total)) {
    throw new AppError("validation", "The split does not cover every row.");
  }
  await requireActiveAgents(admin, agentIdsOf(assignment));

  const results: BatchRowResult[] = [];
  const pending: Array<{ rowIndex: number; record: TablesInsert<"leads"> }> = [];

  for (const row of batch.rows) {
    const check = checkImportRow(row.cells, batch.mapping, batch.appendUnmappedToNotes);
    if (!check.ok) {
      results.push({ rowIndex: row.rowIndex, ok: false, reason: check.reasons.join("; ") });
      continue;
    }
    const { lead } = check;
    pending.push({
      rowIndex: row.rowIndex,
      record: {
        // A server-generated id ties each row to its result without relying on RETURNING order.
        id: crypto.randomUUID(),
        business_name: lead.business_name,
        contact_name: lead.contact_name,
        phone: lead.phone,
        phone_raw: lead.phone_raw,
        email: lead.email,
        website: lead.website,
        website_domain: lead.website_domain,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        source: lead.source,
        notes: lead.notes,
        assigned_to: assigneeForPosition(assignment, row.position),
      },
    });
  }

  if (pending.length > 0) {
    const { error } = await admin.supabase.from("leads").insert(pending.map((item) => item.record));
    if (!error) {
      for (const item of pending) results.push({ rowIndex: item.rowIndex, ok: true, leadId: item.record.id as string });
    } else if (isAuthError(error.code)) {
      throw mapPostgrestError(error);
    } else {
      await insertPendingByBisect(admin, pending, results);
    }
  }

  results.sort((a, b) => a.rowIndex - b.rowIndex);
  return { results };
}
