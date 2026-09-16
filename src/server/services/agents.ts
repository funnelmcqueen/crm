import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/lib/database.types";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { endOfDayInTz, isValidTimeZone, startOfDayInTz } from "@/lib/domain/time";
import { requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { createAdminClient } from "@/server/supabase/admin";

// Admin agent management (SPEC 8 "Agents (admin)", SPEC 5 "On disable, also ban the user in Supabase Auth").
// Every profile read and write runs with the admin's own session. The service role is used only for the
// Supabase Auth admin API (create user, ban/unban), per ARCHITECTURE golden rule 2.

type CallDirection = Database["public"]["Enums"]["call_direction"];
type CallMode = Database["public"]["Enums"]["call_mode"];
type CallOutcome = Database["public"]["Enums"]["call_outcome"];
type UserRole = Database["public"]["Enums"]["user_role"];

/** ~100 years. Supabase has no "forever" ban; the seed and fixtures use the same value. */
export const PERMANENT_BAN_DURATION = "876000h";
export const MAX_NAME_LENGTH = 200;
export const MIN_DAILY_TARGET = 0;
export const MAX_DAILY_TARGET = 1000;
/** reassign_leads is called with at most this many ids per request. */
export const REASSIGN_CHUNK_SIZE = 500;
const LEAD_ID_PAGE_SIZE = 1000;
const MAX_SELECTED_LEADS = 5000;

export interface AgentServiceDeps {
  /** Service-role client for Supabase Auth admin operations only. */
  authAdmin(): SupabaseClient<Database>;
  /** One-time password generator (injectable for tests). */
  generatePassword(): string;
}

const defaultDeps: AgentServiceDeps = {
  authAdmin: createAdminClient,
  generatePassword: generateStrongPassword,
};

function resolveDeps(deps?: Partial<AgentServiceDeps>): AgentServiceDeps {
  return { ...defaultDeps, ...deps };
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

const uuidSchema = z.uuid();

/** Malformed ids get the same answer as ids that do not exist. */
function parseUserId(id: unknown): string {
  const parsed = uuidSchema.safeParse(typeof id === "string" ? id.trim().toLowerCase() : id);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Password generation
// ---------------------------------------------------------------------------------------------

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "-_!@#%+=";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

function randomIndex(max: number): number {
  // Rejection sampling keeps the distribution uniform.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % max;
  }
}

/** 20 characters from a 65-symbol alphabet (~120 bits) with every character class present. */
export function generateStrongPassword(length = 20): string {
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(ALL[randomIndex(ALL.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------------------------

export const agentNameSchema = z
  .string({ message: "Enter a name." })
  .trim()
  .min(1, "Enter a name.")
  .max(MAX_NAME_LENGTH, `Names can be at most ${MAX_NAME_LENGTH} characters.`);

export const dailyTargetSchema = z.coerce
  .number({ message: "Enter a daily call target." })
  .int("The daily call target must be a whole number.")
  .min(MIN_DAILY_TARGET, `The daily call target must be between ${MIN_DAILY_TARGET} and ${MAX_DAILY_TARGET}.`)
  .max(MAX_DAILY_TARGET, `The daily call target must be between ${MIN_DAILY_TARGET} and ${MAX_DAILY_TARGET}.`);

export const timeZoneSchema = z
  .string({ message: "Choose a time zone." })
  .trim()
  .refine((value) => isValidTimeZone(value), "Choose a valid time zone.");

export const emailSchema = z
  .string({ message: "Enter an email address." })
  .trim()
  .max(320, "Enter a valid email address.")
  .pipe(z.email("Enter a valid email address."))
  .transform((value) => value.toLowerCase());

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export interface AgentRow {
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

export interface DisabledAgentsWithLeads {
  /** Disabled users that still have at least one lead assigned. */
  agents: Array<{ userId: string; name: string; leadsAssigned: number }>;
  leadCount: number;
}

export interface AgentListResult {
  /** AGENT profiles, active first. */
  agents: AgentRow[];
  /** Every profile that reassign_leads accepts as a target: active agents and admins. */
  reassignTargets: Array<{ userId: string; name: string; role: UserRole }>;
  disabledWithLeads: DisabledAgentsWithLeads;
}

type AgentRowsRow = Database["public"]["Functions"]["admin_agent_rows"]["Returns"][number];

function toAgentRow(row: AgentRowsRow): AgentRow {
  return {
    userId: row.user_id,
    name: row.name || row.email,
    email: row.email,
    role: row.role,
    active: row.active,
    inAppCallingEnabled: row.in_app_calling_enabled,
    timezone: row.timezone,
    dailyCallTarget: row.daily_call_target,
    leadsAssigned: Number(row.leads_assigned ?? 0),
    dialsToday: Number(row.dials_today ?? 0),
    connectedToday: Number(row.connected_today ?? 0),
    interestedToday: Number(row.interested_today ?? 0),
    appointmentsToday: Number(row.appointments_today ?? 0),
    talkSecondsToday: Number(row.talk_seconds_today ?? 0),
    assignedNumbers: Array.isArray(row.assigned_numbers) ? row.assigned_numbers : [],
  };
}

/** All AGENT and ADMIN rows from admin_agent_rows (admin only). */
export async function listAllAgentRows(ctx: RequestContext | null): Promise<AgentRow[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase.rpc("admin_agent_rows");
  if (error) fail(error);
  return ((data ?? []) as AgentRowsRow[]).map(toAgentRow);
}

export async function listAgents(ctx: RequestContext | null): Promise<AgentListResult> {
  const rows = await listAllAgentRows(ctx);
  const agents = rows.filter((row) => row.role === "AGENT");
  const disabled = rows.filter((row) => !row.active && row.leadsAssigned > 0);
  return {
    agents,
    reassignTargets: rows
      .filter((row) => row.active)
      .map((row) => ({ userId: row.userId, name: row.name, role: row.role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    disabledWithLeads: {
      agents: disabled.map((row) => ({ userId: row.userId, name: row.name, leadsAssigned: row.leadsAssigned })),
      leadCount: disabled.reduce((sum, row) => sum + row.leadsAssigned, 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export const createAgentSchema = z
  .object({
    name: agentNameSchema,
    email: emailSchema,
    dailyCallTarget: dailyTargetSchema,
    timezone: timeZoneSchema,
  })
  .strict();

export type CreateAgentInput = z.input<typeof createAgentSchema>;

export interface CreateAgentResult {
  userId: string;
  name: string;
  email: string;
  /** Shown once. Never stored or logged by the app. */
  password: string;
  /** Set when the account exists but the target/timezone could not be saved. */
  warning: string | null;
}

function isEmailTaken(error: { code?: string; status?: number; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "email_exists" || error.code === "user_already_exists") return true;
  return error.status === 422 && /already (been )?registered|already exists/i.test(error.message ?? "");
}

export async function createAgent(
  ctx: RequestContext | null,
  input: unknown,
  deps?: Partial<AgentServiceDeps>,
): Promise<CreateAgentResult> {
  const admin = requireAdmin(ctx);
  const values = createAgentSchema.parse(input);
  const { authAdmin, generatePassword } = resolveDeps(deps);
  const password = generatePassword();

  const created = await authAdmin().auth.admin.createUser({
    email: values.email,
    password,
    email_confirm: true,
    user_metadata: { name: values.name },
  });
  if (isEmailTaken(created.error)) {
    throw new AppError("conflict", "An account with this email already exists.");
  }
  if (created.error || !created.data.user) {
    throw new AppError("unavailable", "The account could not be created. Please try again.", {
      cause: created.error ?? undefined,
    });
  }
  const userId = created.data.user.id;

  // The auth trigger created the AGENT profile with the company defaults; apply this form with the admin's session.
  const updated = await admin.supabase
    .from("profiles")
    .update({ name: values.name, daily_call_target: values.dailyCallTarget, timezone: values.timezone })
    .eq("id", userId)
    .select("id");
  const warning =
    updated.error || (updated.data ?? []).length !== 1
      ? "The account was created, but its daily target and time zone could not be saved. Edit the agent to set them."
      : null;

  return { userId, name: values.name, email: values.email, password, warning };
}

// ---------------------------------------------------------------------------------------------
// Profile flags and fields
// ---------------------------------------------------------------------------------------------

async function readProfileFlags(admin: RequestContext, userId: string): Promise<{ id: string; active: boolean }> {
  const { data, error } = await admin.supabase.from("profiles").select("id, active").eq("id", userId).maybeSingle();
  if (error) fail(error);
  if (!data) throw new AppError("not_found");
  return data;
}

export interface SetAgentActiveResult {
  userId: string;
  active: boolean;
}

/**
 * Disables or reactivates a user: profiles.active with the admin's session, then the Auth ban. If the ban call
 * fails, the profile flag is rolled back so the two never disagree.
 */
export async function setAgentActive(
  ctx: RequestContext | null,
  userId: unknown,
  active: unknown,
  deps?: Partial<AgentServiceDeps>,
): Promise<SetAgentActiveResult> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(userId);
  const next = z.boolean({ message: "Choose active or disabled." }).parse(active);
  if (id === admin.userId) {
    throw new AppError("forbidden", "You can't disable or reactivate your own account.");
  }
  const { authAdmin } = resolveDeps(deps);

  const current = await readProfileFlags(admin, id);

  if (current.active !== next) {
    const updated = await admin.supabase.from("profiles").update({ active: next }).eq("id", id).select("id");
    if (updated.error) fail(updated.error);
    if ((updated.data ?? []).length !== 1) throw new AppError("not_found");
  }

  let banError: unknown = null;
  try {
    const result = await authAdmin().auth.admin.updateUserById(id, {
      ban_duration: next ? "none" : PERMANENT_BAN_DURATION,
    });
    banError = result.error;
  } catch (error) {
    banError = error;
  }

  if (banError) {
    if (current.active !== next) {
      const rollback = await admin.supabase.from("profiles").update({ active: current.active }).eq("id", id).select("id");
      if (rollback.error) {
        throw new AppError(
          "unavailable",
          next
            ? "Sign-in could not be unblocked, and the agent could not be set back to disabled. Try again."
            : "Sign-in could not be blocked, and the agent could not be set back to active. Try again.",
          { cause: banError },
        );
      }
    }
    throw new AppError(
      "unavailable",
      next
        ? "Sign-in could not be unblocked, so the agent stays disabled. Try again."
        : "Sign-in could not be blocked, so the agent stays active. Try again.",
      { cause: banError },
    );
  }

  return { userId: id, active: next };
}

export async function setInAppCalling(
  ctx: RequestContext | null,
  userId: unknown,
  enabled: unknown,
): Promise<{ userId: string; inAppCallingEnabled: boolean }> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(userId);
  const value = z.boolean({ message: "Choose on or off." }).parse(enabled);
  const { data, error } = await admin.supabase
    .from("profiles")
    .update({ in_app_calling_enabled: value })
    .eq("id", id)
    .select("id, in_app_calling_enabled");
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("not_found");
  return { userId: row.id, inAppCallingEnabled: row.in_app_calling_enabled };
}

export const updateAgentProfileSchema = z
  .object({
    name: agentNameSchema.optional(),
    dailyCallTarget: dailyTargetSchema.optional(),
    timezone: timeZoneSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.dailyCallTarget !== undefined || value.timezone !== undefined,
    "Nothing to update.",
  );

export type UpdateAgentProfileInput = z.input<typeof updateAgentProfileSchema>;

export interface AgentProfileSummary {
  userId: string;
  name: string;
  dailyCallTarget: number;
  timezone: string;
}

export async function updateAgentProfile(
  ctx: RequestContext | null,
  userId: unknown,
  fields: unknown,
): Promise<AgentProfileSummary> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(userId);
  const values = updateAgentProfileSchema.parse(fields ?? {});
  const patch: Database["public"]["Tables"]["profiles"]["Update"] = {};
  if (values.name !== undefined) patch.name = values.name;
  if (values.dailyCallTarget !== undefined) patch.daily_call_target = values.dailyCallTarget;
  if (values.timezone !== undefined) patch.timezone = values.timezone;

  const { data, error } = await admin.supabase
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select("id, name, daily_call_target, timezone");
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("not_found");
  return { userId: row.id, name: row.name, dailyCallTarget: row.daily_call_target, timezone: row.timezone };
}

// ---------------------------------------------------------------------------------------------
// Reassignment
// ---------------------------------------------------------------------------------------------

const statusListSchema = z
  .array(z.enum(LEAD_STATUSES))
  .max(LEAD_STATUSES.length)
  .optional()
  .transform((value) => (value && value.length > 0 ? [...new Set(value)] : null));

const targetSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  uuidSchema.nullable(),
);

export const bulkReassignSchema = z
  .object({
    fromUserId: uuidSchema,
    toUserId: targetSchema,
    statuses: statusListSchema,
  })
  .strict()
  .refine((value) => value.fromUserId !== value.toUserId, {
    message: "Choose a different agent to receive the leads.",
    path: ["toUserId"],
  });

export type BulkReassignInput = z.input<typeof bulkReassignSchema>;

async function sourceLeadIds(admin: RequestContext, fromUserId: string, statuses: LeadStatus[] | null): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += LEAD_ID_PAGE_SIZE) {
    let query = admin.supabase.from("leads").select("id").eq("assigned_to", fromUserId);
    if (statuses) query = query.in("status", statuses);
    const { data, error } = await query.order("id", { ascending: true }).range(offset, offset + LEAD_ID_PAGE_SIZE - 1);
    if (error) fail(error);
    const page = data ?? [];
    for (const row of page) ids.push(row.id);
    if (page.length < LEAD_ID_PAGE_SIZE) return ids;
  }
}

async function reassignInChunks(admin: RequestContext, leadIds: string[], toUserId: string | null): Promise<number> {
  let count = 0;
  for (let start = 0; start < leadIds.length; start += REASSIGN_CHUNK_SIZE) {
    const { data, error } = await admin.supabase.rpc("reassign_leads", {
      p_lead_ids: leadIds.slice(start, start + REASSIGN_CHUNK_SIZE),
      // The generated type says string, but the RPC accepts null (= unassign).
      p_to_user_id: toUserId as string,
    });
    if (error) {
      if (error.code === "22023") throw new AppError("validation", "Choose an active agent or Unassigned.");
      // Earlier chunks have already committed. Report how many leads moved, so the admin knows the
      // operation was partial instead of assuming nothing happened and retrying blind.
      const mapped = mapPostgrestError(error);
      if (count === 0) throw mapped;
      throw new AppError(
        mapped.code,
        `${count.toLocaleString("en-US")} of ${leadIds.length.toLocaleString("en-US")} leads were reassigned before this failed. ${mapped.message}`,
        { cause: error },
      );
    }
    count += typeof data === "number" ? data : 0;
  }
  return count;
}

/** How many leads a bulk reassign with these filters would move right now. */
export async function countReassignableLeads(
  ctx: RequestContext | null,
  fromUserId: unknown,
  statuses?: unknown,
): Promise<{ count: number }> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(fromUserId);
  const statusList = statusListSchema.parse(statuses ?? undefined);
  let query = admin.supabase.from("leads").select("id", { count: "exact", head: true }).eq("assigned_to", id);
  if (statusList) query = query.in("status", statusList);
  const { count, error } = await query;
  if (error) fail(error);
  return { count: count ?? 0 };
}

/**
 * Moves every lead currently assigned to `fromUserId` (optionally only some statuses) to `toUserId` or to
 * Unassigned. Open follow-ups move with them (leads_move_open_follow_ups); call history stays attributed.
 */
export async function bulkReassign(ctx: RequestContext | null, input: unknown): Promise<{ count: number }> {
  const admin = requireAdmin(ctx);
  const values = bulkReassignSchema.parse(input);
  const ids = await sourceLeadIds(admin, values.fromUserId, values.statuses);
  if (ids.length === 0) return { count: 0 };
  return { count: await reassignInChunks(admin, ids, values.toUserId) };
}

const selectedIdsSchema = z
  .array(uuidSchema, { message: "Select at least one lead." })
  .min(1, "Select at least one lead.")
  .max(MAX_SELECTED_LEADS, `Select at most ${MAX_SELECTED_LEADS.toLocaleString("en-US")} leads at a time.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

export async function reassignSelected(
  ctx: RequestContext | null,
  leadIds: unknown,
  toUserId: unknown,
): Promise<{ count: number }> {
  const admin = requireAdmin(ctx);
  const ids = selectedIdsSchema.parse(leadIds);
  const parsedTarget = targetSchema.safeParse(toUserId);
  if (!parsedTarget.success) throw new AppError("validation", "Choose an active agent or Unassigned.");
  return { count: await reassignInChunks(admin, ids, parsedTarget.data) };
}

// ---------------------------------------------------------------------------------------------
// Drill-down activity
// ---------------------------------------------------------------------------------------------

export const ACTIVITY_RANGES = ["today", "7d", "30d"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const ACTIVITY_RANGE_LABELS: Readonly<Record<ActivityRange, string>> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
};

export function parseActivityRange(value: unknown): ActivityRange {
  const raw = Array.isArray(value) ? value[0] : value;
  return (ACTIVITY_RANGES as readonly unknown[]).includes(raw) ? (raw as ActivityRange) : "today";
}

const DAY_MS = 86_400_000;

/**
 * [start, end) in `tz`: today, or the last 7/30 calendar days including today. Start is local midnight of the
 * first day, end is the next local midnight after today (DST-safe: each boundary is computed from a local date).
 */
export function activityRangeBounds(range: ActivityRange, tz: string, now: Date | number = Date.now()): { from: Date; to: Date } {
  const zone = isValidTimeZone(tz) ? tz : "America/New_York";
  const nowMs = typeof now === "number" ? now : now.getTime();
  const to = endOfDayInTz(zone, nowMs);
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  // Noon of today stepped back whole days lands inside the right local date even across DST changes.
  const todayStart = startOfDayInTz(zone, nowMs);
  const middayToday = todayStart.getTime() + (to.getTime() - todayStart.getTime()) / 2;
  const from = startOfDayInTz(zone, middayToday - (days - 1) * DAY_MS);
  return { from, to };
}

export interface AgentActivityCall {
  id: string;
  createdAt: string;
  direction: CallDirection;
  mode: CallMode;
  outcome: CallOutcome | null;
  callStatus: string | null;
  durationSeconds: number | null;
  leadId: string | null;
  businessName: string | null;
}

export interface AgentActivity {
  profile: {
    userId: string;
    name: string;
    email: string;
    role: UserRole;
    active: boolean;
    timezone: string;
    dailyCallTarget: number;
    inAppCallingEnabled: boolean;
    createdAt: string;
    leadsAssigned: number;
    clients: number;
  };
  range: { key: ActivityRange; from: string; to: string; timezone: string };
  stats: {
    dials: number;
    connected: number;
    /** connected / dials, 0 without dials. */
    connectRate: number;
    interested: number;
    appointments: number;
    talkSeconds: number;
    /** talkSeconds / calls with a duration, 0 without such calls. */
    avgCallSeconds: number;
    inboundCalls: number;
    totalCalls: number;
    clients: number;
  };
  outcomes: Partial<Record<CallOutcome, number>>;
  recentCalls: AgentActivityCall[];
}

function asRecord(value: Json | undefined): Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function num(value: Json | undefined): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function parseAgentActivity(json: Json, range: AgentActivity["range"]): AgentActivity {
  const root = asRecord(json);
  const profile = asRecord(root.profile);
  const stats = asRecord(root.stats);
  const outcomes = asRecord(root.outcomes);
  const recent = Array.isArray(root.recent_calls) ? root.recent_calls : [];

  const dials = num(stats.dials);
  const connected = num(stats.connected);
  const talkSeconds = num(stats.talk_seconds);
  const withDuration = num(stats.calls_with_duration);
  const clients = num(profile.clients);

  return {
    profile: {
      userId: str(profile.user_id) ?? "",
      name: str(profile.name) || (str(profile.email) ?? ""),
      email: str(profile.email) ?? "",
      role: profile.role === "ADMIN" ? "ADMIN" : "AGENT",
      active: profile.active === true,
      timezone: str(profile.timezone) ?? "America/New_York",
      dailyCallTarget: num(profile.daily_call_target),
      inAppCallingEnabled: profile.in_app_calling_enabled === true,
      createdAt: str(profile.created_at) ?? "",
      leadsAssigned: num(profile.leads_assigned),
      clients,
    },
    range,
    stats: {
      dials,
      connected,
      connectRate: dials > 0 ? connected / dials : 0,
      interested: num(stats.interested),
      appointments: num(stats.appointments),
      talkSeconds,
      avgCallSeconds: withDuration > 0 ? talkSeconds / withDuration : 0,
      inboundCalls: num(stats.inbound_calls),
      totalCalls: num(stats.total_calls),
      clients,
    },
    outcomes: Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, num(value)])) as Partial<
      Record<CallOutcome, number>
    >,
    recentCalls: recent.map((item) => {
      const call = asRecord(item);
      return {
        id: str(call.id) ?? "",
        createdAt: str(call.created_at) ?? "",
        direction: call.direction === "INBOUND" ? "INBOUND" : "OUTBOUND",
        mode: call.mode === "IN_APP" ? "IN_APP" : "TEL",
        outcome: (str(call.outcome) as CallOutcome | null) ?? null,
        callStatus: str(call.call_status),
        durationSeconds: call.duration_seconds === null || call.duration_seconds === undefined ? null : num(call.duration_seconds),
        leadId: str(call.lead_id),
        businessName: str(call.business_name),
      };
    }),
  };
}

/** Null for a malformed or unknown user id. Range boundaries use the agent's own timezone. */
export async function getAgentActivity(
  ctx: RequestContext | null,
  userId: unknown,
  range: unknown,
  now: Date | number = Date.now(),
): Promise<AgentActivity | null> {
  const admin = requireAdmin(ctx);
  let id: string;
  try {
    id = parseUserId(userId);
  } catch {
    return null;
  }
  const key = parseActivityRange(range);

  // The agents list (admin_agent_rows), the admin dashboard and the agent's own dashboard all count
  // "today" in the *agent's* timezone. Using the viewing admin's zone here meant one click changed the
  // same agent's numbers, with both screens labelling the window "Today".
  const { data: target, error: targetError } = await admin.supabase
    .from("profiles")
    .select("timezone")
    .eq("id", id)
    .maybeSingle();
  if (targetError) fail(targetError);
  if (!target) return null;
  const timezone = isValidTimeZone(target.timezone) ? target.timezone : "America/New_York";
  const { from, to } = activityRangeBounds(key, timezone, now);

  const { data, error } = await admin.supabase.rpc("admin_agent_activity", {
    p_user_id: id,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) {
    if (error.code === "P0002") return null;
    fail(error);
  }
  return parseAgentActivity(data, { key, from: from.toISOString(), to: to.toISOString(), timezone });
}
