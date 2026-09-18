import { handleGoogleCallback } from "@/server/http/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleGoogleCallback(req);
}
