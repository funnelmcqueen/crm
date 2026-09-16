import { z } from "zod";
import type { Database } from "@/lib/database.types";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError } from "@/server/errors";
import { nextLead, type NextLead } from "@/server/services/next-lead";

export type UserRole = Database["public"]["Enums"]["user_role"];

// Dashboard stats (SPEC 8). Shared stat definitions live in supabase/migrations/20260915000600_dashboards.sql:
// dials, connected, interested, appointments and talk seconds are attributed to calls.user_id and "today" is the
// user's own timezone.

export interface MyDashboardStats {
  timezone: string;
  dailyCallTarget: number;
  dialsToday: number;
  remaining: number;
  targetHit: boolean;
  connectedToday: number;
  interestedToday: number;
  appointmentsToday: number;
  talkSecondsToday: number;
  followUpsDue: number;
  unheardVoicemails: number;
}

export interface AgentDashboard {
  stats: MyDashboardStats;
  nextLead: NextLead | null;
}

export interface TeamTotals {
  leadsTotal: number;
  leadsUnassigned: number;
  callsToday: number;
  connectedToday: number;
  interestedToday: number;
  appointmentsToday: number;
  /** Every lead with status CLIENT, whoever owns it. */
  clientsTotal: number;
  /** Leads with status CLIENT that are currently assigned: what the per-agent rows and Reports sum. */
  clientsAssigned: number;
  clientsUnassigned: number;
  /** Raw seconds, so the tile can be floored exactly like the per-agent rows it sits above. */
  talkSecondsToday: number;
  talkMinutesToday: number;
  disabledAgentsWithLeads: number;
  leadsOnDisabledAgents: number;
}

export interface AgentStatsRow {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  inAppCallingEnabled: boolean;
  timezone: string;
  dailyCallTarget: number;
  leadsAssigned: number;
  dialsToday: number;
  connectedToday: number;
  interestedToday: number;
  appointmentsToday: number;
  talkSecondsToday: number;
  assignedNumbers: string[];
}

export interface AdminDashboard {
  totals: TeamTotals;
  agents: AgentStatsRow[];
}

const count = z.coerce.number().int().nonnegative();

const myDashboardSchema = z
  .object({
    timezone: z.string().min(1),
    daily_call_target: count,
    dials_today: count,
    remaining: count,
    target_hit: z.boolean(),
    connected_today: count,
    interested_today: count,
    appointments_today: count,
    talk_seconds_today: count,
    follow_ups_due: count,
    unheard_voicemails: count,
  })
  .transform(
    (d): MyDashboardStats => ({
      timezone: d.timezone,
      dailyCallTarget: d.daily_call_target,
      dialsToday: d.dials_today,
      remaining: d.remaining,
      targetHit: d.target_hit,
      connectedToday: d.connected_today,
      interestedToday: d.interested_today,
      appointmentsToday: d.appointments_today,
      talkSecondsToday: d.talk_seconds_today,
      followUpsDue: d.follow_ups_due,
      unheardVoicemails: d.unheard_voicemails,
    }),
  );

const teamTotalsSchema = z
  .object({
    leads_total: count,
    leads_unassigned: count,
    calls_today: count,
    connected_today: count,
    interested_today: count,
    appointments_today: count,
    clients_total: count,
    clients_assigned: count,
    clients_unassigned: count,
    talk_seconds_today: count,
    talk_minutes_today: count,
    disabled_agents_with_leads: count,
    leads_on_disabled_agents: count,
  })
  .transform(
    (t): TeamTotals => ({
      leadsTotal: t.leads_total,
      leadsUnassigned: t.leads_unassigned,
      callsToday: t.calls_today,
      connectedToday: t.connected_today,
      interestedToday: t.interested_today,
      appointmentsToday: t.appointments_today,
      clientsTotal: t.clients_total,
      clientsAssigned: t.clients_assigned,
      clientsUnassigned: t.clients_unassigned,
      talkSecondsToday: t.talk_seconds_today,
      talkMinutesToday: t.talk_minutes_today,
      disabledAgentsWithLeads: t.disabled_agents_with_leads,
      leadsOnDisabledAgents: t.leads_on_disabled_agents,
    }),
  );

function parseRpc<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AppError("internal", undefined, { cause: parsed.error });
  return parsed.data;
}

/** The caller's own stats for today (in their timezone). Never any team data. */
export async function getMyDashboardStats(ctx: RequestContext): Promise<MyDashboardStats> {
  const { supabase } = requireActive(ctx);
  const { data, error } = await supabase.rpc("get_my_dashboard");
  if (error) throw mapPostgrestError(error);
  return parseRpc(myDashboardSchema, data);
}

/** Agent dashboard: own stats plus the Next Lead suggestion. */
export async function getAgentDashboard(ctx: RequestContext): Promise<AgentDashboard> {
  const active = requireActive(ctx);
  const [stats, lead] = await Promise.all([getMyDashboardStats(active), nextLead(active, [])]);
  return { stats, nextLead: lead };
}

/**
 * Per-user rows for AGENT and ADMIN profiles, "today" in each user's own timezone. Admin only. Deleted
 * agents are left out; admin_team_totals still counts calls they made today.
 */
export async function listAgentStatsRows(ctx: RequestContext): Promise<AgentStatsRow[]> {
  const { supabase } = requireAdmin(ctx);
  const { data, error } = await supabase.rpc("admin_agent_rows");
  if (error) throw mapPostgrestError(error);
  return (data ?? []).filter((r) => !r.deleted).map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active,
    inAppCallingEnabled: r.in_app_calling_enabled,
    timezone: r.timezone,
    dailyCallTarget: Number(r.daily_call_target),
    leadsAssigned: Number(r.leads_assigned),
    dialsToday: Number(r.dials_today),
    connectedToday: Number(r.connected_today),
    interestedToday: Number(r.interested_today),
    appointmentsToday: Number(r.appointments_today),
    talkSecondsToday: Number(r.talk_seconds_today),
    assignedNumbers: Array.isArray(r.assigned_numbers) ? r.assigned_numbers : [],
  }));
}

/** Team totals (today totals are sums of the per-user rows). Admin only. */
export async function getTeamTotals(ctx: RequestContext): Promise<TeamTotals> {
  const { supabase } = requireAdmin(ctx);
  const { data, error } = await supabase.rpc("admin_team_totals");
  if (error) throw mapPostgrestError(error);
  return parseRpc(teamTotalsSchema, data);
}

export async function getAdminDashboard(ctx: RequestContext): Promise<AdminDashboard> {
  const admin = requireAdmin(ctx);
  const [totals, agents] = await Promise.all([getTeamTotals(admin), listAgentStatsRows(admin)]);
  return { totals, agents };
}
