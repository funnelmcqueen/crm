import { z } from "zod";
import { MAX_SKIP_IDS, isNextLeadReason, type NextLeadReason } from "@/lib/dialer/skip-list";
import type { LeadStatus } from "@/lib/domain/statuses";
import { requireActive, type RequestContext } from "@/server/context";
import { mapPostgrestError, toAppError } from "@/server/errors";

export interface NextLead {
  leadId: string;
  businessName: string;
  contactName: string | null;
  phone: string;
  status: LeadStatus;
  city: string | null;
  state: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  callCount: number;
  reason: NextLeadReason;
}

const skipIdsSchema = z.array(z.uuid({ error: "Invalid lead." })).max(MAX_SKIP_IDS, { error: "Too many skipped leads." });

/** get_next_lead: the caller's own assigned leads only, excluding `skipIds`. */
export async function nextLead(ctx: RequestContext, skipIds: unknown = []): Promise<NextLead | null> {
  const { supabase } = requireActive(ctx);
  const parsed = skipIdsSchema.safeParse(skipIds);
  if (!parsed.success) throw toAppError(parsed.error);
  const exclude = parsed.data;

  const { data, error } = await supabase.rpc("get_next_lead", { p_exclude_ids: exclude });
  if (error) throw mapPostgrestError(error);
  const row = data?.[0];
  if (!row) return null;

  return {
    leadId: row.lead_id,
    businessName: row.business_name,
    contactName: row.contact_name ?? null,
    phone: row.phone,
    status: row.status,
    city: row.city ?? null,
    state: row.state ?? null,
    lastContactedAt: row.last_contacted_at ?? null,
    nextFollowUpAt: row.next_follow_up_at ?? null,
    callCount: row.call_count,
    reason: isNextLeadReason(row.reason) ? row.reason : "RETRY",
  };
}
