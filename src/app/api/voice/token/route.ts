import { handleVoiceToken } from "@/server/http/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleVoiceToken(req);
}
