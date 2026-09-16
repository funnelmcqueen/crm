import "server-only";
import { CSV_CONTENT_TYPE } from "@/lib/domain/csv";
import { getRouteAuth, requireActive } from "@/server/context";
import { toHttpResponse } from "@/server/errors";
import { createLeadExport, parseLeadExportFilters } from "@/server/services/export";

export interface LeadsExportDeps {
  now: () => Date;
  /** Rows per database page (tests use small pages to exercise streaming). */
  pageSize: number;
}

/**
 * GET /api/leads/export?<leads list filters> → CSV attachment of every lead the caller may see that
 * matches the filters. Cookie or Bearer session; no session → 401 `{ error: 'unauthorized' }`.
 */
export async function handleLeadsExport(req: Request, deps: Partial<LeadsExportDeps> = {}): Promise<Response> {
  let auth: Awaited<ReturnType<typeof getRouteAuth>>;
  try {
    auth = await getRouteAuth(req);
  } catch (error) {
    return toHttpResponse(error);
  }
  const { ctx, applyCookies } = auth;
  try {
    const active = requireActive(ctx);
    const filters = parseLeadExportFilters(new URL(req.url).searchParams);
    const csv = await createLeadExport(active, filters, { now: deps.now?.() ?? new Date(), pageSize: deps.pageSize });
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
