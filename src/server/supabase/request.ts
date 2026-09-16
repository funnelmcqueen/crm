import "server-only";
import { createServerClient, parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";
import { getPublicSupabaseEnv } from "@/server/env";

export interface RequestSupabase {
  supabase: SupabaseClient<Database>;
  /** Token from `Authorization: Bearer`, or null when the session comes from cookies. */
  bearerToken: string | null;
  /** Adds any refreshed session cookies (and their no-store headers) to the response. */
  applyCookies(res: Response): Response;
}

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match ? match[1] : null;
}

/** Unverified `role` claim. Only used to reject non-user tokens early; getUser() does the real check. */
export function getJwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    const role = (payload as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

function withHeaders(res: Response, cookies: string[], headers: Record<string, string>): Response {
  if (cookies.length === 0) return res;
  const apply = (target: Headers) => {
    for (const cookie of cookies) target.append("Set-Cookie", cookie);
    for (const [key, value] of Object.entries(headers)) target.set(key, value);
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    // Headers of e.g. Response.redirect() are immutable; copy into a new response.
    const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
    apply(copy.headers);
    return copy;
  }
}

/** Supabase client for a Route Handler request: Bearer header when present, otherwise the Cookie header. */
export function createRequestSupabase(req: Request): RequestSupabase {
  const { url, anonKey } = getPublicSupabaseEnv();
  const bearerToken = readBearerToken(req.headers.get("authorization"));

  if (bearerToken !== null) {
    const supabase = createClient<Database>(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return { supabase, bearerToken, applyCookies: (res) => res };
  }

  const pendingCookies: { name: string; value: string; options: CookieOptions }[] = [];
  const pendingHeaders: Record<string, string> = {};
  const supabase = createServerClient<Database>(url, anonKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return parseCookieHeader(req.headers.get("cookie") ?? "").map(({ name, value }) => ({ name, value: value ?? "" }));
      },
      setAll(cookiesToSet, headers) {
        pendingCookies.push(...cookiesToSet);
        Object.assign(pendingHeaders, headers);
      },
    },
  });

  return {
    supabase,
    bearerToken: null,
    applyCookies(res) {
      const serialized = pendingCookies.map(({ name, value, options }) => serializeCookieHeader(name, value, options));
      return withHeaders(res, serialized, pendingHeaders);
    },
  };
}
