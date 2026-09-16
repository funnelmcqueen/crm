import { handleLeadsExport, handleSelectedLeadsExport } from "@/server/http/leads-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleLeadsExport(req);
}

export function POST(req: Request): Promise<Response> {
  return handleSelectedLeadsExport(req);
}
