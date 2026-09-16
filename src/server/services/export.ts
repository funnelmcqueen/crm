import { parseLeadListParams, type RawSearchParams } from "@/components/leads/list-params";
import type { Database } from "@/lib/database.types";
import { csvFilename, escapeCsvCell } from "@/lib/domain/csv";
import { STATUS_LABELS, type LeadStatus } from "@/lib/domain/statuses";
import { formatInTz, isValidTimeZone } from "@/lib/domain/time";
import { requireActive, type RequestContext } from "@/server/context";
import { mapPostgrestError } from "@/server/errors";

// CSV export of the leads list (SPEC section 10). Runs with the caller's session, so RLS scopes the
// rows; agents additionally get an explicit assigned_to = their id filter.

export const EXPORT_PAGE_SIZE = 1000;
/** Profiles read per request. Must stay at or below the PostgREST row cap so a full page is a full page. */
export const PROFILE_PAGE_SIZE = 500;
export const EXPORT_FILENAME_PREFIX = "funnel-mcqueen-leads";
export const EXPORT_PHONE_HEADER = "Phone";
export const EXPORT_ASSIGNED_AGENT_HEADER = "Assigned agent";
export const EXPORT_HEADERS = [
  "Business",
  "Contact",
  EXPORT_PHONE_HEADER,
  "Email",
  "Website",
  "Address",
  "City",
  "State",
  "Country",
  "Status",
  "Notes",
  "Last contacted",
  "Next follow-up",
  "Call count",
] as const;

/** ISO 8601 with the viewer's UTC offset, e.g. 2026-09-15T09:30:00-04:00. */
export const EXPORT_DATE_PATTERN = "yyyy-MM-dd'T'HH:mm:ssXXX";

export interface LeadExportFilters {
  q: string;
  statuses: LeadStatus[];
  source: string | null;
  /** Admin only; ignored for agents. */
  agent: string | null;
  /** Admin only; ignored for agents. */
  unassigned: boolean;
}

/** The leads list query string (same parser as the page); sort and page do not apply to exports. */
export function parseLeadExportFilters(raw: RawSearchParams): LeadExportFilters {
  const params = parseLeadListParams(raw);
  return { q: params.q, statuses: params.statuses, source: params.source, agent: params.agent, unassigned: params.unassigned };
}

export interface LeadExportOptions {
  /** Used for the file name date. */
  now?: Date;
  /** Rows fetched per page, 1..1000 (default 1000). */
  pageSize?: number;
}

type ExportArgs = Database["public"]["Functions"]["export_leads"]["Args"];
type ExportRow = Database["public"]["Functions"]["export_leads"]["Returns"][number];

export interface LeadExport {
  filename: string;
  headers: string[];
  /** CSV (UTF-8 with BOM, CRLF line endings), produced page by page. */
  stream: ReadableStream<Uint8Array>;
}

function exportTimeZone(tz: string): string {
  return isValidTimeZone(tz) ? tz : "UTC";
}

export function formatExportDate(value: string | null | undefined, tz: string): string {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatInTz(time, exportTimeZone(tz), EXPORT_DATE_PATTERN) : "";
}

function csvLine(cells: readonly unknown[], headers: readonly string[]): string {
  return `${cells.map((cell, i) => escapeCsvCell(cell, { column: headers[i], phoneColumns: [EXPORT_PHONE_HEADER] })).join(",")}\r\n`;
}

/**
 * Prepares the export: resolves the caller, loads the first page (so auth and query errors surface
 * before any bytes are sent) and returns a stream that fetches the remaining pages on demand.
 */
export async function createLeadExport(
  ctx: RequestContext | null,
  filters: LeadExportFilters,
  options: LeadExportOptions = {},
): Promise<LeadExport> {
  const active = requireActive(ctx);
  const isAdmin = active.profile.role === "ADMIN";
  const tz = exportTimeZone(active.profile.timezone);
  const pageSize = Math.max(1, Math.min(EXPORT_PAGE_SIZE, Math.floor(options.pageSize ?? EXPORT_PAGE_SIZE)));
  const headers: string[] = [...EXPORT_HEADERS, ...(isAdmin ? [EXPORT_ASSIGNED_AGENT_HEADER] : [])];

  const baseArgs: ExportArgs = { p_limit: pageSize };
  if (filters.q !== "") baseArgs.p_query = filters.q;
  if (filters.statuses.length > 0) baseArgs.p_statuses = [...new Set(filters.statuses)];
  if (filters.source !== null) baseArgs.p_source = filters.source;
  if (isAdmin) {
    if (filters.unassigned) baseArgs.p_unassigned = true;
    else if (filters.agent) baseArgs.p_assigned_to = filters.agent;
  }

  const agentNames = new Map<string, string>();
  if (isAdmin) {
    // PostgREST truncates an unpaginated response at db-max-rows, and says nothing about it, so the
    // owner directory is read in explicit pages. Assuming one request returned every profile made the
    // export label leads owned by any agent past the cap "Unknown user".
    for (let offset = 0; ; offset += PROFILE_PAGE_SIZE) {
      const { data, error } = await active.supabase
        .from("profiles")
        .select("id, name, email")
        .order("id", { ascending: true })
        .range(offset, offset + PROFILE_PAGE_SIZE - 1);
      if (error) throw mapPostgrestError(error);
      const page = data ?? [];
      for (const profile of page) agentNames.set(profile.id, profile.name || profile.email);
      if (page.length < PROFILE_PAGE_SIZE) break;
    }
  }

  async function fetchPage(after: ExportRow | null): Promise<ExportRow[]> {
    const args: ExportArgs = after ? { ...baseArgs, p_after_created_at: after.created_at, p_after_id: after.id } : baseArgs;
    let query = active.supabase.rpc("export_leads", args);
    // RLS and the RPC already scope agents to their own leads; this keeps the route honest on its own.
    if (!isAdmin) query = query.eq("assigned_to", active.userId);
    const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true });
    if (error) throw mapPostgrestError(error);
    return (data ?? []) as ExportRow[];
  }

  function rowCells(row: ExportRow): unknown[] {
    const cells: unknown[] = [
      row.business_name,
      row.contact_name,
      row.phone,
      row.email,
      row.website,
      row.address,
      row.city,
      row.state,
      row.country,
      STATUS_LABELS[row.status] ?? row.status,
      row.notes,
      formatExportDate(row.last_contacted_at, tz),
      formatExportDate(row.next_follow_up_at, tz),
      row.call_count,
    ];
    if (isAdmin) cells.push(row.assigned_to ? (agentNames.get(row.assigned_to) ?? "Unknown user") : "");
    return cells;
  }

  let page = await fetchPage(null);
  let finished = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`﻿${csvLine(headers, [])}`));
    },
    async pull(controller) {
      if (finished) return;
      try {
        if (page.length > 0) {
          controller.enqueue(encoder.encode(page.map((row) => csvLine(rowCells(row), headers)).join("")));
        }
        if (page.length < pageSize) {
          finished = true;
          controller.close();
          return;
        }
        page = await fetchPage(page[page.length - 1]);
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
  });

  return { filename: csvFilename(EXPORT_FILENAME_PREFIX, options.now ?? new Date(), tz), headers, stream };
}
