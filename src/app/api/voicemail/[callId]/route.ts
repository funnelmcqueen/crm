import { handleVoicemail } from "@/server/http/voicemail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ callId: string }> }): Promise<Response> {
  const { callId } = await params;
  return handleVoicemail(req, callId);
}
