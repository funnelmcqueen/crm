import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { sessionCookieOptions } from "@/lib/supabase/cookie-options";
import { isUnsafePublicSupabaseKey } from "@/lib/supabase/public-key";

let browserClient: SupabaseClient<Database> | undefined;

/** Browser singleton using the anon key and the user's cookie session (RLS applies). */
export function createBrowserSupabase(): SupabaseClient<Database> {
  if (browserClient) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set.");
  }
  if (isUnsafePublicSupabaseKey(anonKey)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY must be the anon or publishable key.");
  }
  // The session cookie is written here, from JavaScript, so its attributes are set here too.
  browserClient = createBrowserClient<Database>(url, anonKey, { cookieOptions: sessionCookieOptions() });
  return browserClient;
}
