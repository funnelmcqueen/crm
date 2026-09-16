import "server-only";
import { CSV_CONTENT_TYPE } from "@/lib/domain/csv";
import { getRouteAuth, requireActive, type RequestContext } from "@/server/context";
import { getServerEnv, type ServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, toHttpResponse } from "@/server/errors";
import { isAllowedOrigin } from "@/server/http/browser";
import { parseSelectedLeadIds } from "@/server/services/bulk-leads";
import { createLeadExport, parseLeadExportFilters, type LeadExportFilters } from "@/server/services/export";

export interface LeadsExportDeps {
  now: () => Date;
  /** Rows per database page (tests use small pages to exercise streaming). */
  pageSize: number;
  /** The POST origin check's app origin; defaults to the server env. */
  env: Pick<ServerEnv, "APP_BASE_URL">;
}

/**
 * GET /api/leads/export?<leads list filters> → CSV attachment of every lead the caller may see that
 * matches the filters. Cookie or Bearer session; no session → 401 `{ error: 'unauthorized' }`.
 */
export async function handleLeadsExport(req: Request, deps: Partial<LeadsExportDeps> = {}): Promise<Response> {
  return exportResponse(req, deps, () => ({ filters: parseLeadExportFilters(new URL(req.url).searchParams) }));
}

const NO_FILTERS: LeadExportFilters = { q: "", statuses: [], source: null, agent: null, unassigned: false };

/**
 * POST /api/leads/export with form field `ids` (comma-separated lead ids) → CSV of exactly those leads, of the
 * ones the caller may see (DEVIATIONS D41). A form post, so the browser downloads the file itself and a
 * selection of thousands of ids never has to fit in a URL. Cookie-authenticated, so a cross-site Origin is refused.
 */
export async function handleSelectedLeadsExport(req: Request, deps: Partial<LeadsExportDeps> = {}): Promise<Response> {
  let env: Pick<ServerEnv, "APP_BASE_URL">;
  try {
    env = deps.env ?? getServerEnv();
  } catch (error) {
    return toHttpResponse(new AppError("unavailable", undefined, { cause: error }));
  }
  if (!isAllowedOrigin(req, env)) return toHttpResponse(new AppError("forbidden"));

  let raw: string;
  try {
    const form = await req.formData();
    const value = form.get("ids");
    raw = typeof value === "string" ? value : "";
  } catch {
    return toHttpResponse(new AppError("validation", "Select at least one lead."));
  }
  return exportResponse(req, deps, () => ({
    filters: NO_FILTERS,
    leadIds: parseSelectedLeadIds(raw.split(",").filter((id) => id.trim() !== "")),
  }));
}

async function exportResponse(
  req: Request,
  deps: Partial<LeadsExportDeps>,
  select: () => { filters: LeadExportFilters; leadIds?: string[] },
): Promise<Response> {
  let auth: Awaited<ReturnType<typeof getRouteAuth>>;
  try {
    auth = await getRouteAuth(req);
  } catch (error) {
    return toHttpResponse(error);
  }
  const { ctx, applyCookies } = auth;
  try {
    const active: RequestContext = requireActive(ctx);
    const { filters, leadIds } = select();
    // Each export pages the caller's whole book (an admin's covers every lead), so an unlimited export
    // is an unbounded database and egress cost per request. The policy lives in SQL with the others
    // (D14), so it holds across serverless instances and no caller argument can shrink the window.
    const { data: allowed, error: limitError } = await active.supabase.rpc("consume_rate_limit", { p_bucket: "export" });
    if (limitError) throw mapPostgrestError(limitError);
    if (allowed !== true) throw new AppError("rate_limited");

    const csv = await createLeadExport(active, filters, { now: deps.now?.() ?? new Date(), pageSize: deps.pageSize, leadIds });
    return applyCookies(
      new Response(csv.stream, {
        status: 200,
        headers: {
          "Content-Type": CSV_CONTENT_TYPE,
          "Content-Disposition": `attachment; filename="${csv.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }),
    );
  } catch (error) {
    return applyCookies(toHttpResponse(error));
  }
}
