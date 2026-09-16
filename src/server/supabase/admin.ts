import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getServerEnv } from "@/server/env";

/**
 * Service-role client: bypasses RLS. Allowed only for Supabase Auth admin operations (including the
 * revoke_user_sessions RPC, D31), Twilio webhooks
 * and the voicemail route's get_voicemail_recording lookup for the verified session user
 * (docs/ARCHITECTURE.md golden rule 2, DEVIATIONS D13). Everything else must use the user's session.
 */
export function createAdminClient(): SupabaseClient<Database> {
  const env = getServerEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
