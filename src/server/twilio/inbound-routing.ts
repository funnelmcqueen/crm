import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { normalizePhone } from "@/lib/domain/phone";

export const DEVICE_PRESENCE_MAX_AGE_MS = 3 * 60_000;
export const LIVE_CALL_WINDOW_MS = 2 * 3_600_000;
export const LIVE_CALL_STATUSES = ["queued", "ringing", "in-progress"] as const;

export interface InboundLeadFacts {
  id: string;
  assignedTo: string | null;
}

export interface InboundNumberFacts {
  id: string;
  assignedTo: string | null;
  active: boolean;
}

/** The profile of the user pickInboundTarget chose, plus whether they are on a live call. */
export interface InboundTargetFacts {
  id: string;
  active: boolean;
  inAppCallingEnabled: boolean;
  deviceSeenAt: string | null;
  busy: boolean;
}

export interface InboundFacts {
  /** Normalized caller number, or null when From is not a usable phone number. */
  fromE164: string | null;
  /** The lead with that phone: most recently contacted first. */
  lead: InboundLeadFacts | null;
  /** The dialed Twilio number (To). */
  number: InboundNumberFacts | null;
  target: InboundTargetFacts | null;
}

export type InboundRouteReason = "lead_owner" | "unassigned_lead" | "assigned_number" | "no_owner";

export interface InboundTarget {
  /** null = admin-only voicemail. */
  userId: string | null;
  reason: InboundRouteReason;
}

export interface InboundDecision extends InboundTarget {
  action: "ring" | "voicemail";
  leadId: string | null;
  phoneNumberId: string | null;
}

/**
 * ARCHITECTURE 7: the lead's owner always wins (whatever number was dialed); a matched lead without an
 * owner is admin-only; only an unmatched caller falls back to the agent the dialed number is assigned to.
 */
export function pickInboundTarget(lead: InboundLeadFacts | null, number: InboundNumberFacts | null): InboundTarget {
  if (lead) {
    return lead.assignedTo ? { userId: lead.assignedTo, reason: "lead_owner" } : { userId: null, reason: "unassigned_lead" };
  }
  if (number && number.active && number.assignedTo) return { userId: number.assignedTo, reason: "assigned_number" };
  return { userId: null, reason: "no_owner" };
}

export function canRingTarget(target: InboundTargetFacts | null, userId: string | null, now: Date): boolean {
  if (!userId || !target || target.id !== userId) return false;
  if (!target.active || !target.inAppCallingEnabled || target.busy || !target.deviceSeenAt) return false;
  const seenAt = Date.parse(target.deviceSeenAt);
  if (Number.isNaN(seenAt)) return false;
  return now.getTime() - seenAt <= DEVICE_PRESENCE_MAX_AGE_MS;
}

export function decideInboundRoute(facts: InboundFacts, now: Date): InboundDecision {
  const target = pickInboundTarget(facts.lead, facts.number);
  return {
    ...target,
    action: canRingTarget(facts.target, target.userId, now) ? "ring" : "voicemail",
    leadId: facts.lead?.id ?? null,
    phoneNumberId: facts.number?.id ?? null,
  };
}

/** Reads the routing facts with the service role (webhooks have no user session). */
export async function loadInboundFacts(
  admin: SupabaseClient<Database>,
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date,
): Promise<InboundFacts> {
  const fromResult = normalizePhone(from);
  const toResult = normalizePhone(to);
  const fromE164 = fromResult.ok ? fromResult.e164 : null;

  let lead: InboundLeadFacts | null = null;
  if (fromE164) {
    const { data, error } = await admin
      .from("leads")
      .select("id, assigned_to")
      .eq("phone", fromE164)
      .order("last_contacted_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    if (row) lead = { id: row.id, assignedTo: row.assigned_to };
  }

  let number: InboundNumberFacts | null = null;
  if (toResult.ok) {
    const { data, error } = await admin
      .from("phone_numbers")
      .select("id, assigned_to, active")
      .eq("e164", toResult.e164)
      .maybeSingle();
    if (error) throw error;
    if (data) number = { id: data.id, assignedTo: data.assigned_to, active: data.active };
  }

  const { userId } = pickInboundTarget(lead, number);
  let target: InboundTargetFacts | null = null;
  if (userId) {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("id, active, in_app_calling_enabled, device_seen_at")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    if (profile) {
      const { data: live, error: liveError } = await admin
        .from("calls")
        .select("id")
        .eq("user_id", userId)
        .is("outcome", null)
        .in("call_status", [...LIVE_CALL_STATUSES])
        .gt("created_at", new Date(now.getTime() - LIVE_CALL_WINDOW_MS).toISOString())
        .limit(1);
      if (liveError) throw liveError;
      target = {
        id: profile.id,
        active: profile.active,
        inAppCallingEnabled: profile.in_app_calling_enabled,
        deviceSeenAt: profile.device_seen_at,
        busy: (live?.length ?? 0) > 0,
      };
    }
  }

  return { fromE164, lead, number, target };
}
