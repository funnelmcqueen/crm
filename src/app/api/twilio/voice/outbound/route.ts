import { handleTwilioOutbound } from "@/server/http/twilio/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleTwilioOutbound(req);
}
