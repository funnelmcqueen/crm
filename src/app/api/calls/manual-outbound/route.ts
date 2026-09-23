import { handleManualCallsOutbound } from "@/server/http/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleManualCallsOutbound(req);
}
