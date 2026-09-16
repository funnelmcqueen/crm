import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { LOGIN_PATH, isAdminPath, isPublicPath, safeNextPath } from "@/lib/supabase/auth-redirect";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";
import { getPublicSupabaseEnv } from "@/server/env";

// Folders starting with "_" are private in the App Router, so no page can ever match this path and
// the rewrite renders the standard 404 page with a 404 status. (Not "/_not-found": Next uses that
// name for its own built-in route.)
const NOT_FOUND_REWRITE = "/_fmq-not-found";

const SESSION_HEADERS = ["cache-control", "expires", "pragma"] as const;

type ProfileProbe = { role: Database["public"]["Enums"]["user_role"]; active: boolean } | null | "error";

async function readOwnProfile(supabase: SupabaseClient<Database>, userId: string): Promise<ProfileProbe> {
  const { data, error } = await supabase.from("profiles").select("role, active").eq("id", userId).maybeSingle();
  return error ? "error" : data;
}

/**
 * Optimistic gate only. Pages, server actions and route handlers re-check the session and role
 * themselves, and RLS enforces isolation in Postgres.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { url, anonKey } = getPublicSupabaseEnv();

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(url, anonKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // getUser() validates the JWT with Supabase Auth and refreshes an expired session via setAll.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const carrySession = (target: NextResponse): NextResponse => {
    for (const cookie of response.cookies.getAll()) target.cookies.set(cookie);
    for (const key of SESSION_HEADERS) {
      const value = response.headers.get(key);
      if (value !== null) target.headers.set(key, value);
    }
    return target;
  };

  if (isPublicPath(pathname)) {
    if (user && pathname === LOGIN_PATH) {
      const profile = await readOwnProfile(supabase, user.id);
      if (profile === "error") return response;
      if (profile?.active) {
        const target = safeNextPath(request.nextUrl.searchParams.get("next"));
        return carrySession(NextResponse.redirect(new URL(target, request.url)));
      }
      // A valid session for a disabled or unknown profile: clear it so the login form is usable.
      await supabase.auth.signOut({ scope: "local" });
    }
    return response;
  }

  if (!user) {
    const loginUrl = new URL(LOGIN_PATH, request.url);
    if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
    return carrySession(NextResponse.redirect(loginUrl));
  }

  if (isAdminPath(pathname)) {
    const profile = await readOwnProfile(supabase, user.id);
    if (profile === "error" || !profile?.active || profile.role !== "ADMIN") {
      return carrySession(NextResponse.rewrite(new URL(NOT_FOUND_REWRITE, request.url), { request }));
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/|favicon\\.ico$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|woff2?|map)$).*)",
  ],
};
