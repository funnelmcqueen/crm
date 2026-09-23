import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/lib/database.types";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { endOfDayInTz, isValidTimeZone, startOfDayInTz } from "@/lib/domain/time";
import { isGoogleDriver } from "@/server/calendar/client";
import { requireAdmin, type RequestContext } from "@/server/context";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { provisionAgentCalendar } from "@/server/services/calendar-connection";
import { createAdminClient } from "@/server/supabase/admin";

// Admin agent management (SPEC 8 "Agents (admin)", SPEC 5 "On disable, also ban the user in Supabase Auth").
// Every profile read and write runs with the admin's own session. The service role is used only for the
// Supabase Auth admin API (create user, ban/unban, end sessions), per ARCHITECTURE golden rule 2.

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
  /** Ends every Supabase Auth session of a user (see `revokeAuthSessionsWith`). Throws on failure. */
  revokeSessions(userId: string): Promise<void>;
}

const defaultDeps: AgentServiceDeps = {
  authAdmin: createAdminClient,
  generatePassword: generateStrongPassword,
  revokeSessions: revokeAuthSessions,
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
// Auth session revocation
// ---------------------------------------------------------------------------------------------

/**
 * Ends every Supabase Auth session of one user: the session rows and the refresh tokens hanging off
 * them. After this, that user's outstanding access token is no longer accepted by `/auth/v1/user`
 * (which is what `getUser()` in `src/proxy.ts` and `src/server/context.ts` call), and their refresh
 * token can no longer mint a new one.
 *
 * Supabase Auth has no admin API for this. `auth.admin.signOut(jwt, scope)` signs out the holder of a
 * *user* access token, which an admin server disabling someone else's account never has, hosted Auth
 * exposes no by-id sessions route, and `auth.admin.deleteUser` would destroy the account and its
 * history. A ban alone is not enough either: it blocks sign-in and refresh only while it lasts, so
 * lifting it on reactivation makes every pre-disable cookie and refresh token valid again. So the
 * service-role-only `revoke_user_sessions` RPC deletes the rows in `auth.sessions`, exactly what Auth's
 * own sign-out-everywhere does. See docs/DEVIATIONS.md D31.
 */
export async function revokeAuthSessionsWith(service: SupabaseClient<Database>, userId: string): Promise<void> {
  const { error } = await service.rpc("revoke_user_sessions", { p_user_id: userId });
  if (error) throw new Error(`revoking Auth sessions failed: ${error.code ?? "unknown"} ${error.message}`);
}

/** `revokeAuthSessionsWith` this deployment's service-role client. Created lazily, like the ban. */
export async function revokeAuthSessions(userId: string): Promise<void> {
  await revokeAuthSessionsWith(createAdminClient(), userId);
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
  /**
   * Deleted in the CRM, but closing the login did not finish (D40). Only the Agents list shows these,
   * so the admin can finish the delete; every other list leaves deleted agents out.
   */
  deletePending: boolean;
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
    deletePending: row.deleted && row.email !== deletedAuthEmail(row.user_id),
  };
}

async function readAgentRows(ctx: RequestContext | null): Promise<AgentRowsRow[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase.rpc("admin_agent_rows");
  if (error) fail(error);
  return (data ?? []) as AgentRowsRow[];
}

/**
 * AGENT and ADMIN rows from admin_agent_rows (admin only). Deleted agents are left out of every list and
 * picker built on this; admin_team_totals still counts calls they made today.
 */
export async function listAllAgentRows(ctx: RequestContext | null): Promise<AgentRow[]> {
  return (await readAgentRows(ctx)).filter((row) => !row.deleted).map(toAgentRow);
}

export async function listAgents(ctx: RequestContext | null): Promise<AgentListResult> {
  const all = (await readAgentRows(ctx)).map((row) => ({ deleted: row.deleted, row: toAgentRow(row) }));
  const rows = all.filter((entry) => !entry.deleted).map((entry) => entry.row);
  // A delete whose login closing failed stays on the Agents list, marked, until the admin finishes it.
  const agents = all
    .filter((entry) => entry.row.role === "AGENT" && (!entry.deleted || entry.row.deletePending))
    .map((entry) => entry.row);
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
      : (await provisionCalendar(userId, values.name, values.timezone));

  return { userId, name: values.name, email: values.email, password, warning };
}

/**
 * Gives the new agent their own Google calendar (docs/DEVIATIONS.md D48), so they can book from their first
 * day. Never fails the account: an agent without a calendar simply cannot book yet, and Settings provisions
 * them later. Returns the warning to show, or null when there is nothing to say.
 */
async function provisionCalendar(userId: string, name: string, timeZone: string): Promise<string | null> {
  if (!isGoogleDriver()) return null;
  try {
    const created = await provisionAgentCalendar(userId, name, timeZone);
    return created
      ? null
      : "The account was created, but Google Calendar isn't connected, so they can't book meetings yet.";
  } catch (error) {
    console.error("[agents] provisioning a calendar failed", { userId, code: error instanceof Error ? error.name : typeof error });
    return "The account was created, but their meetings calendar could not be. Give them one from Settings.";
  }
}

// ---------------------------------------------------------------------------------------------
// Profile flags and fields
// ---------------------------------------------------------------------------------------------

async function readProfileFlags(admin: RequestContext, userId: string): Promise<{ id: string; active: boolean }> {
  const { data, error } = await admin.supabase
    .from("profiles")
    .select("id, active, deleted_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) fail(error);
  // A deleted agent is gone as far as management goes: it can never be reactivated (the database refuses too).
  if (!data || data.deleted_at !== null) throw new AppError("not_found");
  return { id: data.id, active: data.active };
}

export interface SetAgentActiveResult {
  userId: string;
  active: boolean;
}

/**
 * Disables or reactivates a user: `profiles.active` with the admin's session, then the Auth ban. If the
 * ban call fails, the profile flag is rolled back so the two never disagree.
 *
 * Both directions also end the account's existing Auth sessions (D31). On reactivate that happens
 * *first*, while the ban is still in place, so a cookie or refresh token from before the disable can
 * never be replayed; the agent has to sign in again. On disable it happens after the ban, so the
 * access token the agent's browser is holding right now stops being accepted too.
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
  const { authAdmin, revokeSessions } = resolveDeps(deps);

  const current = await readProfileFlags(admin, id);

  // Reactivating: end the old sessions while sign-in is still blocked. Doing it afterwards would leave
  // a window in which the agent's pre-disable cookie walks straight back into /dashboard.
  if (next) {
    try {
      await revokeSessions(id);
    } catch (error) {
      throw new AppError(
        "unavailable",
        "Their earlier sessions could not be ended, so the agent stays disabled. Try again.",
        { cause: error },
      );
    }
  }

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

  // Reactivating races a delete: if the agent was deleted after the flag above was written, lifting the
  // ban just undid the delete's permanent ban. Put it back; a deleted login never signs in again (D40).
  if (next) {
    try {
      await readProfileFlags(admin, id);
    } catch (error) {
      if (!(error instanceof AppError && error.code === "not_found")) throw error;
      const reban = await authAdmin().auth.admin.updateUserById(id, { ban_duration: PERMANENT_BAN_DURATION });
      if (reban.error) {
        throw new AppError("unavailable", "This agent was deleted while being reactivated. Delete them again to finish.", {
          cause: reban.error,
        });
      }
      throw error;
    }
  }

  // Disabling: the ban stops new sign-ins and refreshes; this also ends the sessions the agent's
  // browser is holding, so their current access token is rejected as well. The flag and the ban are
  // already written, so the agent is cut off either way — the admin is told to retry, which is safe.
  if (!next) {
    try {
      await revokeSessions(id);
    } catch (error) {
      throw new AppError(
        "unavailable",
        "The agent was disabled, but their open sessions could not be ended. Try again.",
        { cause: error },
      );
    }
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
    /** Deleted by an admin (history kept). Set by getAgentActivity, not by admin_agent_activity. */
    deleted: boolean;
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
      deleted: false,
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
    .select("timezone, deleted_at")
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
  const activity = parseAgentActivity(data, { key, from: from.toISOString(), to: to.toISOString(), timezone });
  activity.profile.deleted = target.deleted_at !== null;
  return activity;
}

// ---------------------------------------------------------------------------------------------
// Delete (docs/DEVIATIONS.md D40)
// ---------------------------------------------------------------------------------------------

export type AgentDeleteBlocker = "deleted" | "self" | "admin" | "has_work";

export interface AgentDeleteCheck {
  leads: number;
  openFollowUps: number;
  completedFollowUps: number;
  calls: number;
  phoneNumbers: number;
  deleted: boolean;
  /**
   * The login of a deleted agent is fully closed. False while `deleted` is true means an earlier delete
   * stopped half way; deleting again finishes it.
   */
  loginClosed: boolean;
  /** Why the user can't be deleted, or null when they can. */
  reason: AgentDeleteBlocker | null;
  deletable: boolean;
}

const DELETE_BLOCKERS: readonly AgentDeleteBlocker[] = ["deleted", "self", "admin", "has_work"];

/** What stands between the admin and deleting this user: counts of their work and history. Admin only. */
export async function getAgentDeleteCheck(ctx: RequestContext | null, userId: unknown): Promise<AgentDeleteCheck> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(userId);
  const { data, error } = await admin.supabase.rpc("admin_agent_delete_check", { p_user_id: id });
  if (error) fail(error);
  const row = asRecord(data as Json);
  const reason = DELETE_BLOCKERS.find((blocker) => blocker === row.reason) ?? null;
  return {
    leads: num(row.leads),
    openFollowUps: num(row.open_follow_ups),
    completedFollowUps: num(row.completed_follow_ups),
    calls: num(row.calls),
    phoneNumbers: num(row.phone_numbers),
    deleted: row.deleted === true,
    loginClosed: row.deleted === true && row.email === deletedAuthEmail(id),
    reason,
    deletable: row.deletable === true && reason === null,
  };
}

export interface DeleteAgentResult {
  userId: string;
  /** The profile was already deleted; this call only finished closing the login. */
  alreadyDeleted: boolean;
  phoneNumbersUnassigned: number;
}

/**
 * The Auth email a deleted agent's login is moved to. `.invalid` is reserved (RFC 2606), so it can never
 * receive mail or belong to a real person, and deriving it from the id keeps it unique and stable across
 * retries. Moving the login off the original address is what lets an admin reuse that address.
 */
export function deletedAuthEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function formatCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

function agentHasWorkError(error: PostgrestLikeError): AppError {
  let leads = 0;
  let openFollowUps = 0;
  try {
    const details = asRecord(JSON.parse(error.details ?? "{}") as Json);
    leads = num(details.leads);
    openFollowUps = num(details.open_follow_ups);
  } catch {
    // Fall back to the generic wording below.
  }
  const work = [
    leads > 0 ? plural(leads, "lead", "leads") : null,
    openFollowUps > 0 ? plural(openFollowUps, "open follow-up", "open follow-ups") : null,
  ].filter(Boolean);
  return new AppError(
    "conflict",
    work.length > 0
      ? `Reassign this agent's ${work.join(" and ")} before deleting them.`
      : "Reassign this agent's leads and open follow-ups before deleting them.",
    { cause: error },
  );
}

/**
 * Deletes an agent who has no leads and no open follow-ups. The database half (admin_delete_agent) marks
 * the profile deleted and inactive, unassigns their phone numbers and keeps their call history; from that
 * moment RLS gives the agent zero rows. The Auth half then closes the login for good, in three steps that
 * can each be repeated: a new random password and a permanent ban, then every open session ended, then
 * the email moved to `deletedAuthEmail` to free the real address. The security steps come first, so a
 * failure to move the email never leaves the login open. The email step goes last because it is what
 * marks the delete finished (the profile email follows the Auth email): until then the agent stays on the
 * Agents list as an unfinished delete, and deleting again (the database half is idempotent) finishes it.
 */
export async function deleteAgent(
  ctx: RequestContext | null,
  userId: unknown,
  deps?: Partial<AgentServiceDeps>,
): Promise<DeleteAgentResult> {
  const admin = requireAdmin(ctx);
  const id = parseUserId(userId);
  if (id === admin.userId) {
    throw new AppError("forbidden", "You can't delete your own account.");
  }
  const { authAdmin, generatePassword, revokeSessions } = resolveDeps(deps);

  const { data, error } = await admin.supabase.rpc("admin_delete_agent", { p_user_id: id });
  if (error) {
    if (error.code === "P0001" && error.message === "agent_has_work") throw agentHasWorkError(error);
    if (error.code === "42501") throw new AppError("forbidden", "Only agents can be deleted.");
    fail(error);
  }
  const result = asRecord(data as Json);

  await closeLoginStep("They are removed from the CRM, but their sign-in could not be blocked yet.", async () => {
    const banned = await authAdmin().auth.admin.updateUserById(id, {
      password: generatePassword(),
      ban_duration: PERMANENT_BAN_DURATION,
    });
    if (banned.error) throw banned.error;
  });
  await closeLoginStep("They are removed from the CRM and can't sign in, but their open sessions could not be ended yet.", () =>
    revokeSessions(id),
  );
  await closeLoginStep("They are signed out and can't sign in, but their email address could not be freed yet.", async () => {
    const moved = await authAdmin().auth.admin.updateUserById(id, { email: deletedAuthEmail(id), email_confirm: true });
    if (moved.error) throw moved.error;
  });

  return {
    userId: id,
    alreadyDeleted: result.already_deleted === true,
    phoneNumbersUnassigned: num(result.phone_numbers_unassigned),
  };
}

async function closeLoginStep(progress: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (cause) {
    throw new AppError("unavailable", `${progress} Delete them again to finish.`, { cause });
  }
}
