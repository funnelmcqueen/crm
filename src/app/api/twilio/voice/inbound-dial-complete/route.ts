import { handleTwilioInboundDialComplete } from "@/server/http/twilio/callbacks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleTwilioInboundDialComplete(req);
}
