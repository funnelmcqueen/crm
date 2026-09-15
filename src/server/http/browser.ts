import "server-only";
import type { ServerEnv } from "@/server/env";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for cookie-authenticated POST routes: a present Origin header must be the app's public
 * origin (APP_BASE_URL) or the request's own origin. Requests without Origin (non-browser clients) pass.
 */
export function isAllowedOrigin(req: Request, env: Pick<ServerEnv, "APP_BASE_URL">): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const allowed = [originOf(req.url), originOf(env.APP_BASE_URL)].filter((value): value is string => value !== null);
  return allowed.includes(origin);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}
