import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";
import { requireActive, requireAdmin, type RequestContext } from "@/server/context";
import { getPublicSupabaseEnv, getServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import {
  agentNameSchema,
  dailyTargetSchema,
  emailSchema,
  listAllAgentRows,
  timeZoneSchema,
} from "@/server/services/agents";

// Settings page (SPEC 8 "Settings"). Everything runs with the caller's own session; RLS and profiles_guard
// decide what may change. Agents can change only their own name, email and password.

type UserRole = Database["public"]["Enums"]["user_role"];

export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt ignores everything after 72 bytes. */
export const MAX_PASSWORD_LENGTH = 72;
export const MAX_COMPANY_NAME_LENGTH = 100;
export const MAX_VOICEMAIL_GREETING_LENGTH = 500;

export interface SettingsServiceDeps {
  /** A fresh anon-key client that never persists or refreshes a session (used to verify the current password). */
  createVerifierClient(): SupabaseClient<Database>;
  /** Public origin for the email-change confirmation link, or null when not configured. */
  appBaseUrl(): string | null;
}

const defaultDeps: SettingsServiceDeps = {
  createVerifierClient() {
    const env = getPublicSupabaseEnv();
    return createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  },
  appBaseUrl() {
    try {
      return getServerEnv().APP_BASE_URL ?? null;
    } catch {
      return null;
    }
  },
};

function resolveDeps(deps?: Partial<SettingsServiceDeps>): SettingsServiceDeps {
  return { ...defaultDeps, ...deps };
}

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

// ---------------------------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------------------------

export interface CompanySettings {
  companyName: string;
  defaultDailyTarget: number;
  defaultTimezone: string;
  voicemailGreeting: string;
}

export interface AgentTargetRow {
  userId: string;
  name: string;
  email: string;
  active: boolean;
  dailyCallTarget: number;
}

export interface SettingsPageData {
  profile: {
    userId: string;
    name: string;
    email: string;
    role: UserRole;
    dailyCallTarget: number;
    timezone: string;
    inAppCallingEnabled: boolean;
  };
  /** Admins only; null for agents. */
  admin: { company: CompanySettings; agentTargets: AgentTargetRow[] } | null;
}

const SETTINGS_COLUMNS = "company_name, default_daily_target, default_timezone, voicemail_greeting";

export async function getSettingsPageData(ctx: RequestContext | null): Promise<SettingsPageData> {
  const active = requireActive(ctx);
  const { data: profile, error } = await active.supabase
    .from("profiles")
    .select("id, name, email, role, daily_call_target, timezone, in_app_calling_enabled")
    .eq("id", active.userId)
    .maybeSingle();
  if (error) fail(error);
  if (!profile) throw new AppError("unauthorized");

  const result: SettingsPageData = {
    profile: {
      userId: profile.id,
      name: profile.name,
      email: profile.email,
      role: profile.role,
      dailyCallTarget: profile.daily_call_target,
      timezone: profile.timezone,
      inAppCallingEnabled: profile.in_app_calling_enabled,
    },
    admin: null,
  };
  if (profile.role !== "ADMIN") return result;

  const [settings, rows] = await Promise.all([
    active.supabase.from("settings").select(SETTINGS_COLUMNS).eq("id", true).maybeSingle(),
    listAllAgentRows(active),
  ]);
  if (settings.error) fail(settings.error);
  if (!settings.data) throw new AppError("unavailable", "Company settings are missing.");

  result.admin = {
    company: {
      companyName: settings.data.company_name,
      defaultDailyTarget: settings.data.default_daily_target,
      defaultTimezone: settings.data.default_timezone,
      voicemailGreeting: settings.data.voicemail_greeting,
    },
    agentTargets: rows
      .filter((row) => row.role === "AGENT")
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        active: row.active,
        dailyCallTarget: row.dailyCallTarget,
      })),
  };
  return result;
}

// ---------------------------------------------------------------------------------------------
// Own profile
// ---------------------------------------------------------------------------------------------

export async function updateOwnName(ctx: RequestContext | null, name: unknown): Promise<{ name: string }> {
  const active = requireActive(ctx);
  const value = agentNameSchema.parse(name);
  const { data, error } = await active.supabase
    .from("profiles")
    .update({ name: value })
    .eq("id", active.userId)
    .select("name");
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("unauthorized");
  return { name: row.name };
}

export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ message: "Enter your current password." }).min(1, "Enter your current password.").max(1024),
    newPassword: z
      .string({ message: "Enter a new password." })
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      .max(MAX_PASSWORD_LENGTH, `Use at most ${MAX_PASSWORD_LENGTH} characters.`)
      .refine((value) => value.trim().length >= MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} non-space characters.`),
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Choose a password different from your current one.",
    path: ["newPassword"],
  });

export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

export async function changePassword(
  ctx: RequestContext | null,
  input: unknown,
  deps?: Partial<SettingsServiceDeps>,
): Promise<{ changed: true }> {
  const active = requireActive(ctx);
  const values = changePasswordSchema.parse(input);
  const { createVerifierClient } = resolveDeps(deps);

  // Verify the current password with a throwaway client so the user's own session is never replaced.
  const verifier = createVerifierClient();
  const verified = await verifier.auth.signInWithPassword({ email: active.profile.email, password: values.currentPassword });
  if (verified.error || verified.data.user?.id !== active.userId) {
    throw new AppError("validation", "Your current password is incorrect.");
  }
  // Revoke the throwaway session right away.
  await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);

  const { error } = await active.supabase.auth.updateUser({ password: values.newPassword });
  if (error) {
    if (error.code === "same_password") {
      throw new AppError("validation", "Choose a password different from your current one.");
    }
    if (error.code === "weak_password") {
      throw new AppError("validation", "That password is too weak. Use a longer one.");
    }
    throw new AppError("unavailable", "Your password could not be changed. Please try again.", { cause: error });
  }
  return { changed: true };
}

export interface EmailChangeResult {
  /** The address the account now uses (unchanged while a confirmation is pending). */
  email: string;
  /** True when Supabase sent confirmation links and the change applies after they are confirmed. */
  pending: boolean;
}

export async function requestEmailChange(
  ctx: RequestContext | null,
  newEmail: unknown,
  deps?: Partial<SettingsServiceDeps>,
): Promise<EmailChangeResult> {
  const active = requireActive(ctx);
  const email = emailSchema.parse(newEmail);
  if (email === active.profile.email.toLowerCase()) {
    throw new AppError("validation", "That is already your email address.");
  }
  const baseUrl = resolveDeps(deps).appBaseUrl();

  const { data, error } = await active.supabase.auth.updateUser(
    { email },
    baseUrl ? { emailRedirectTo: `${baseUrl}/auth/confirm` } : undefined,
  );
  if (error) {
    // Deliberately vague: the form must not become a lookup for other users' addresses.
    if (error.code === "email_exists" || error.code === "email_address_invalid" || error.status === 422 || error.status === 400) {
      throw new AppError("validation", "That email address can't be used. Try a different one.");
    }
    if (error.code === "over_email_send_rate_limit" || error.status === 429) {
      throw new AppError("rate_limited", "Too many email changes. Try again later.");
    }
    throw new AppError("unavailable", "Your email could not be changed. Please try again.", { cause: error });
  }

  const current = (data.user?.email ?? active.profile.email).toLowerCase();
  return { email: current, pending: current !== email };
}

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

export const companySettingsSchema = z
  .object({
    company_name: z
      .string({ message: "Enter a company name." })
      .trim()
      .min(1, "Enter a company name.")
      .max(MAX_COMPANY_NAME_LENGTH, `The company name can be at most ${MAX_COMPANY_NAME_LENGTH} characters.`),
    default_daily_target: dailyTargetSchema,
    default_timezone: timeZoneSchema,
    voicemail_greeting: z
      .string({ message: "Enter a voicemail greeting." })
      .trim()
      .min(1, "Enter a voicemail greeting.")
      .max(
        MAX_VOICEMAIL_GREETING_LENGTH,
        `The voicemail greeting can be at most ${MAX_VOICEMAIL_GREETING_LENGTH} characters.`,
      ),
  })
  .strict();

export type CompanySettingsInput = z.input<typeof companySettingsSchema>;

/** Admin only: the defaults a new agent starts with. */
export async function getCompanyDefaults(
  ctx: RequestContext | null,
): Promise<{ defaultDailyTarget: number; defaultTimezone: string }> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase
    .from("settings")
    .select("default_daily_target, default_timezone")
    .eq("id", true)
    .maybeSingle();
  if (error) fail(error);
  return {
    defaultDailyTarget: data?.default_daily_target ?? 50,
    defaultTimezone: data?.default_timezone ?? "America/New_York",
  };
}

export async function updateCompanySettings(ctx: RequestContext | null, input: unknown): Promise<CompanySettings> {
  const admin = requireAdmin(ctx);
  const values = companySettingsSchema.parse(input);
  const { data, error } = await admin.supabase.from("settings").update(values).eq("id", true).select(SETTINGS_COLUMNS);
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("unavailable", "Company settings are missing.");
  return {
    companyName: row.company_name,
    defaultDailyTarget: row.default_daily_target,
    defaultTimezone: row.default_timezone,
    voicemailGreeting: row.voicemail_greeting,
  };
}

export async function updateAgentTarget(
  ctx: RequestContext | null,
  userId: unknown,
  target: unknown,
): Promise<{ userId: string; dailyCallTarget: number }> {
  const admin = requireAdmin(ctx);
  const parsedId = z.uuid().safeParse(typeof userId === "string" ? userId.trim().toLowerCase() : userId);
  if (!parsedId.success) throw new AppError("not_found");
  const value = dailyTargetSchema.parse(target);
  const { data, error } = await admin.supabase
    .from("profiles")
    .update({ daily_call_target: value })
    .eq("id", parsedId.data)
    .select("id, daily_call_target");
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("not_found");
  return { userId: row.id, dailyCallTarget: row.daily_call_target };
}
