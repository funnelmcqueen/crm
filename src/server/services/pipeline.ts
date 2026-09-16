import { z } from "zod";
import type { Database } from "@/lib/database.types";
import {
  CLOSED_PIPELINE_COLUMNS,
  PIPELINE_COLUMNS,
  type LeadStatus,
  type PipelineColumn,
  type PipelineColumnKey,
} from "@/lib/domain/statuses";
import { requireActive, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { updateLeadStatus } from "@/server/services/leads";

/** Cards per column page (SPEC 8 "Paginate per column"). */
export const PIPELINE_PAGE_SIZE = 20;
const MAX_OFFSET = 1_000_000;

export const PIPELINE_COLUMN_KEYS = [
  "NEW",
  "TO_CALL",
  "CONNECTED",
  "INTERESTED",
  "APPOINTMENT",
  "PROPOSAL",
  "CLIENT",
  "NOT_INTERESTED",
  "DO_NOT_CONTACT",
] as const satisfies readonly PipelineColumnKey[];

const ALL_COLUMNS: readonly PipelineColumn[] = [...PIPELINE_COLUMNS, ...CLOSED_PIPELINE_COLUMNS];

export interface PipelineCard {
  id: string;
  businessName: string;
  contactName: string | null;
  status: LeadStatus;
  /** Admins only; always null for agents. */
  assignedTo: string | null;
  nextFollowUpAt: string | null;
  updatedAt: string;
  callCount: number;
}

export interface PipelineColumnPage {
  key: PipelineColumnKey;
  /** Offset this page was fetched at. */
  offset: number;
  total: number;
  cards: PipelineCard[];
}

export interface PipelineBoard {
  closed: boolean;
  columns: PipelineColumnPage[];
}

export interface PipelineMoveResult {
  id: string;
  status: LeadStatus;
  /** False when the lead already sat in the target column (nothing was written). */
  changed: boolean;
}

type ColumnArgs = Database["public"]["Functions"]["pipeline_column"]["Args"];
type ColumnRow = Database["public"]["Functions"]["pipeline_column"]["Returns"][number];

const uuidSchema = z.uuid();

const filterShape = {
  agentId: uuidSchema.nullish(),
  unassigned: z.boolean().optional().default(false),
};

const boardSchema = z.object({ ...filterShape, closed: z.boolean().optional().default(false) });
const columnPageSchema = z.object({
  ...filterShape,
  column: z.enum(PIPELINE_COLUMN_KEYS),
  offset: z.number().int().min(0).max(MAX_OFFSET).optional().default(0),
});

export type PipelineBoardInput = z.input<typeof boardSchema>;
export type PipelineColumnInput = z.input<typeof columnPageSchema>;

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

function columnFor(key: PipelineColumnKey): PipelineColumn {
  const column = ALL_COLUMNS.find((c) => c.key === key);
  if (!column) throw new AppError("validation", "Choose a pipeline column.");
  return column;
}

async function fetchColumn(
  ctx: RequestContext,
  column: PipelineColumn,
  offset: number,
  filters: { agentId?: string | null; unassigned: boolean },
): Promise<PipelineColumnPage> {
  const isAdmin = ctx.profile.role === "ADMIN";
  const args: ColumnArgs = { p_statuses: [...column.statuses], p_limit: PIPELINE_PAGE_SIZE, p_offset: offset };
  // The RPC ignores these for non-admins too; not sending them keeps agent requests honest.
  if (isAdmin) {
    if (filters.unassigned) args.p_unassigned = true;
    else if (filters.agentId) args.p_assigned_to = filters.agentId;
  }

  const { data, error } = await ctx.supabase.rpc("pipeline_column", args);
  if (error) fail(error);
  const rows = (data ?? []) as ColumnRow[];

  let total = rows.length > 0 ? Number(rows[0].total_count) : 0;
  if (rows.length === 0 && offset > 0) {
    // Past the end the window function has no row to report the total on.
    const probe = await ctx.supabase.rpc("pipeline_column", { ...args, p_limit: 1, p_offset: 0 });
    if (probe.error) fail(probe.error);
    const firstRow = (probe.data ?? [])[0] as ColumnRow | undefined;
    total = firstRow ? Number(firstRow.total_count) : 0;
  }

  return {
    key: column.key,
    offset,
    total,
    cards: rows.map((row) => ({
      id: row.id,
      businessName: row.business_name,
      contactName: row.contact_name ?? null,
      status: row.status,
      assignedTo: isAdmin ? (row.assigned_to ?? null) : null,
      nextFollowUpAt: row.next_follow_up_at ?? null,
      updatedAt: row.updated_at,
      callCount: row.call_count,
    })),
  };
}

/** First page of every visible column. Agents always get their own leads; admin filters are ignored for them. */
export async function getPipelineBoard(ctx: RequestContext | null, input: PipelineBoardInput = {}): Promise<PipelineBoard> {
  const active = requireActive(ctx);
  const params = boardSchema.parse(input);
  const columns = params.closed ? ALL_COLUMNS : PIPELINE_COLUMNS;
  const pages = await Promise.all(columns.map((column) => fetchColumn(active, column, 0, params)));
  return { closed: params.closed, columns: pages };
}

/** One more page of one column ("Load more"). */
export async function loadPipelineColumn(ctx: RequestContext | null, input: unknown): Promise<PipelineColumnPage> {
  const active = requireActive(ctx);
  const params = columnPageSchema.parse(input ?? {});
  return fetchColumn(active, columnFor(params.column), params.offset, params);
}

/**
 * Moves a lead to a column by setting the column's drop status (same semantics as updateLeadStatus:
 * user session, invisible lead -> not_found, agent re-opening Do Not Contact -> forbidden). A lead
 * already in the target column keeps its status, so No Answer stays No Answer inside To Call.
 */
export async function moveLeadToColumn(
  ctx: RequestContext | null,
  leadId: unknown,
  columnKey: unknown,
): Promise<PipelineMoveResult> {
  const active = requireActive(ctx);
  const id = uuidSchema.safeParse(typeof leadId === "string" ? leadId.trim().toLowerCase() : leadId);
  if (!id.success) throw new AppError("not_found");
  const key = z.enum(PIPELINE_COLUMN_KEYS).safeParse(columnKey);
  if (!key.success) throw new AppError("validation", "Choose a pipeline column.");
  const column = columnFor(key.data);

  const { data: current, error } = await active.supabase.from("leads").select("id, status").eq("id", id.data).maybeSingle();
  if (error) fail(error);
  if (!current) throw new AppError("not_found");
  if (column.statuses.includes(current.status)) return { id: current.id, status: current.status, changed: false };

  const updated = await updateLeadStatus(active, id.data, column.dropStatus);
  return { ...updated, changed: true };
}
