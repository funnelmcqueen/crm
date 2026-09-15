import { requireActive, type RequestContext } from "@/server/context";
import { mapPostgrestError } from "@/server/errors";

/** Unheard voicemails the caller may access (unheard_voicemail_count is scoped in SQL). */
export async function unheardVoicemailCount(ctx: RequestContext): Promise<number> {
  const { supabase } = requireActive(ctx);
  const { data, error } = await supabase.rpc("unheard_voicemail_count");
  if (error) throw mapPostgrestError(error);
  return typeof data === "number" && Number.isFinite(data) ? data : 0;
}
