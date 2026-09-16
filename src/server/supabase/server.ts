import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";
import { getPublicSupabaseEnv } from "@/server/env";

/** User-session client for Server Components, Server Actions and Route Handlers (RLS applies). */
export async function createServerSupabase(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();
  const { url, anonKey } = getPublicSupabaseEnv();
  return createServerClient<Database>(url, anonKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. src/proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
