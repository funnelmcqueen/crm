import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { Database } from "@/lib/database.types";
import { LOGIN_PATH } from "@/lib/supabase/auth-redirect";
import { AppError } from "@/server/errors";
import { createRequestSupabase, getJwtRole } from "@/server/supabase/request";
import { createServerSupabase } from "@/server/supabase/server";

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];

export interface RequestContext {
  supabase: SupabaseClient<Database>;
  userId: string;
  profile: Profile;
}

export const PROFILE_COLUMNS =
  "id, email, name, role, active, daily_call_target, timezone, in_app_calling_enabled, device_seen_at, created_at";

type AuthState =
  | { status: "anonymous" }
  | { status: "inactive"; supabase: SupabaseClient<Database> }
  | { status: "active"; ctx: RequestContext };

async function resolveAuth(supabase: SupabaseClient<Database>, bearerToken: string | null): Promise<AuthState> {
  if (bearerToken !== null && getJwtRole(bearerToken) !== "authenticated") return { status: "anonymous" };

  const { data, error } = bearerToken !== null ? await supabase.auth.getUser(bearerToken) : await supabase.auth.getUser();
  if (error || !data.user) {
    return error?.code === "user_banned" ? { status: "inactive", supabase } : { status: "anonymous" };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw new AppError("unavailable", undefined, { cause: profileError });
  // RLS hides the row of an inactive user, so a missing row and active=false both mean "disabled".
  if (!profile || !profile.active) return { status: "inactive", supabase };

  return { status: "active", ctx: { supabase, userId: data.user.id, profile } };
}

const getActionAuth = cache(async (): Promise<AuthState> => resolveAuth(await createServerSupabase(), null));

/** Session from next/headers cookies (Server Components and Server Actions). Cached per request. */
export async function getActionContext(): Promise<RequestContext | null> {
  const state = await getActionAuth();
  return state.status === "active" ? state.ctx : null;
}

/**
 * Like getRouteContext, plus applyCookies() to forward a refreshed session to the response.
 * Use it in route handlers that browsers call with cookies.
 */
export async function getRouteAuth(
  req: Request,
): Promise<{ ctx: RequestContext | null; applyCookies(res: Response): Response }> {
  const { supabase, bearerToken, applyCookies } = createRequestSupabase(req);
  const state = await resolveAuth(supabase, bearerToken);
  return { ctx: state.status === "active" ? state.ctx : null, applyCookies };
}

/** Session from the request's Cookie header, or an `Authorization: Bearer <access token>` header. */
export async function getRouteContext(req: Request): Promise<RequestContext | null> {
  return (await getRouteAuth(req)).ctx;
}

export function requireActive(ctx: RequestContext | null): RequestContext {
  if (!ctx || !ctx.profile.active) throw new AppError("unauthorized");
  return ctx;
}

export function requireAdmin(ctx: RequestContext | null): RequestContext {
  const active = requireActive(ctx);
  if (active.profile.role !== "ADMIN") throw new AppError("forbidden");
  return active;
}

/** For pages and layouts: redirects to /login without a session, and signs out disabled users. */
export async function requireUserPage(): Promise<RequestContext> {
  const state = await getActionAuth();
  if (state.status === "active") return state.ctx;
  if (state.status === "inactive") {
    // Revokes the refresh tokens server-side. The cookies themselves are cleared by src/proxy.ts on
    // /login, because a Server Component render cannot write cookies.
    await state.supabase.auth.signOut().catch(() => undefined);
    redirect(`${LOGIN_PATH}?disabled=1`);
  }
  redirect(LOGIN_PATH);
}

/** For admin pages: non-admins get the regular 404 page, same as a route that does not exist. */
export async function requireAdminPage(): Promise<RequestContext> {
  const ctx = await requireUserPage();
  if (ctx.profile.role !== "ADMIN") notFound();
  return ctx;
}
