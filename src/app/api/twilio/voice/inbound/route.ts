import { handleTwilioInbound } from "@/server/http/twilio/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleTwilioInbound(req);
}
