// Admin Phone Numbers (SPEC 7d): list, add an existing Twilio number, assign/unassign, deactivate/reactivate.
// Every query runs with the admin's session (phone_numbers RLS is admin-only). Twilio REST is called only
// here on the server, through an injectable verifier so tests never reach the network. Numbers are never
// bought or released.
import { createHash } from "node:crypto";
import { z } from "zod";
import { isE164, normalizePhone } from "@/lib/domain/phone";
import { requireAdmin, type RequestContext } from "@/server/context";
import { getDialerDriver, getServerEnv, isTwilioConfigured, type ServerEnv } from "@/server/env";
import { AppError, mapPostgrestError, type PostgrestLikeError } from "@/server/errors";
import { createTwilioRest, type TwilioIncomingNumber, type TwilioRest } from "@/server/twilio/rest";

export const MAX_NUMBER_LABEL_LENGTH = 100;

export const PHONE_NUMBER_MESSAGES = {
  invalidNumber: "Enter a valid number in E.164 format, like +14155550150.",
  duplicate: "That number is already in the CRM.",
  notInTwilio: "That number was not found in your Twilio account",
  lookupFailed: "Could not reach Twilio to look up that number. Try again.",
  voiceAppFailed: "Twilio could not point that number at the TwiML App, so it was not added. Try again.",
  twilioUnconfigured:
    "Twilio is not configured, so numbers cannot be verified. Set the Twilio environment variables and try again.",
  mockOnly: "Mock mode: only fictional 555-01xx numbers can be added.",
  chooseAgent: "Choose an active agent.",
} as const;

const PHONE_NUMBER_COLUMNS = "id, e164, label, twilio_sid, active, assigned_to, last_used_at, created_at";

function fail(error: PostgrestLikeError): never {
  throw mapPostgrestError(error);
}

const uuidSchema = z.uuid();

/** Malformed ids get the same answer as ids that do not exist. */
function parseId(id: unknown): string {
  const parsed = uuidSchema.safeParse(typeof id === "string" ? id.trim().toLowerCase() : id);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Verification (Twilio, mock, or unavailable)
// ---------------------------------------------------------------------------------------------

export type NumberVerificationMode = "twilio" | "mock" | "unavailable";

export type NumberVerifier =
  | { mode: "twilio"; rest: Pick<TwilioRest, "findIncomingNumber" | "setIncomingNumberVoiceApp">; twimlAppSid: string }
  | { mode: "mock" }
  | { mode: "unavailable" };

/**
 * `mock` when the dialer driver is mock (never in production, D24), `twilio` when Twilio is fully configured,
 * otherwise `unavailable` (adding is refused). An invalid server environment is `unavailable`.
 */
export function resolveNumberVerifier(env?: ServerEnv): NumberVerifier {
  let parsed: ServerEnv;
  try {
    parsed = env ?? getServerEnv();
  } catch {
    return { mode: "unavailable" };
  }
  if (parsed.NODE_ENV !== "production" && getDialerDriver(parsed) === "mock") return { mode: "mock" };
  if (isTwilioConfigured(parsed) && parsed.TWILIO_TWIML_APP_SID) {
    return { mode: "twilio", rest: createTwilioRest(parsed), twimlAppSid: parsed.TWILIO_TWIML_APP_SID };
  }
  return { mode: "unavailable" };
}

export function numberVerificationMode(env?: ServerEnv): NumberVerificationMode {
  return resolveNumberVerifier(env).mode;
}

/** Fictional +1 NXX 555-0100..0199, the only numbers mock mode accepts. */
const MOCK_NUMBER_PATTERN = /^\+1[2-9]\d{2}55501\d{2}$/;

/**
 * MOCK lookup for local dev and tests, not a Twilio call: accepts only fictional 555-01xx numbers and
 * returns a fake, deterministic PN sid.
 */
export function mockFindIncomingNumber(e164: string): TwilioIncomingNumber | null {
  if (!MOCK_NUMBER_PATTERN.test(e164)) return null;
  const hex = createHash("sha256").update(`fmq-mock-number:${e164}`).digest("hex").slice(0, 32);
  return { sid: `PN${hex}`, phoneNumber: e164, voiceApplicationSid: null };
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

export interface PhoneNumberListRow {
  id: string;
  e164: string;
  label: string | null;
  twilioSid: string;
  active: boolean;
  assignedTo: string | null;
  /** Null when the number is in the shared pool. */
  assignedName: string | null;
  /**
   * Whether the assignee is still an active user; null when the number is in the pool. A number held
   * by a disabled agent stays assigned (so reactivating restores it) but is used by nobody, so the
   * page has to say so rather than showing a name that looks normal.
   */
  assignedActive: boolean | null;
  /** Calls (both directions) on this number since midnight in the admin's timezone. */
  callsToday: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listPhoneNumbers(ctx: RequestContext | null): Promise<PhoneNumberListRow[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase.rpc("admin_phone_number_rows");
  if (error) fail(error);
  return (data ?? []).map((row) => ({
    id: row.id,
    e164: row.e164,
    label: row.label ?? null,
    twilioSid: row.twilio_sid,
    active: row.active,
    assignedTo: row.assigned_to ?? null,
    assignedName: row.assigned_to ? (row.assigned_name ?? null) : null,
    assignedActive: row.assigned_to ? (row.assigned_active ?? null) : null,
    callsToday: Number(row.calls_today ?? 0),
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
  }));
}

export interface AssignableAgent {
  id: string;
  name: string;
  role: "ADMIN" | "AGENT";
}

/** Active agents and admins, the only valid assignment targets. */
export async function listAssignableAgents(ctx: RequestContext | null): Promise<AssignableAgent[]> {
  const admin = requireAdmin(ctx);
  const { data, error } = await admin.supabase
    .from("profiles")
    .select("id, name, email, role, active")
    .eq("active", true)
    .in("role", ["AGENT", "ADMIN"])
    .order("name", { ascending: true })
    .order("email", { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((p) => ({ id: p.id, name: p.name.trim() || p.email, role: p.role }));
}

// ---------------------------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------------------------

export interface PhoneNumberRecord {
  id: string;
  e164: string;
  label: string | null;
  twilioSid: string;
  active: boolean;
  assignedTo: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

type PhoneNumberTableRow = {
  id: string;
  e164: string;
  label: string | null;
  twilio_sid: string;
  active: boolean;
  assigned_to: string | null;
  last_used_at: string | null;
  created_at: string;
};

function toRecord(row: PhoneNumberTableRow): PhoneNumberRecord {
  return {
    id: row.id,
    e164: row.e164,
    label: row.label,
    twilioSid: row.twilio_sid,
    active: row.active,
    assignedTo: row.assigned_to,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

const addPhoneNumberSchema = z.object({
  e164: z.string({ error: PHONE_NUMBER_MESSAGES.invalidNumber }).max(100, PHONE_NUMBER_MESSAGES.invalidNumber),
  label: z
    .string()
    .max(MAX_NUMBER_LABEL_LENGTH, `Keep the label under ${MAX_NUMBER_LABEL_LENGTH} characters.`)
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    }),
});

export type AddPhoneNumberInput = z.input<typeof addPhoneNumberSchema>;

export interface AddPhoneNumberDeps {
  verifier?: NumberVerifier;
}

async function assertNotStored(admin: RequestContext, column: "e164" | "twilio_sid", value: string): Promise<void> {
  const { data, error } = await admin.supabase.from("phone_numbers").select("id").eq(column, value).limit(1);
  if (error) fail(error);
  if ((data ?? []).length > 0) throw new AppError("conflict", PHONE_NUMBER_MESSAGES.duplicate);
}

/**
 * Adds a number that already exists in the Twilio account: looks it up (reject when missing), points its
 * voice handler at TWILIO_TWIML_APP_SID, then inserts it into the pool. Nothing is inserted when any step fails.
 */
export async function addPhoneNumber(
  ctx: RequestContext | null,
  input: unknown,
  deps: AddPhoneNumberDeps = {},
): Promise<PhoneNumberRecord> {
  const admin = requireAdmin(ctx);
  const parsed = addPhoneNumberSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("validation", parsed.error.issues[0]?.message ?? PHONE_NUMBER_MESSAGES.invalidNumber);
  }
  const normalized = normalizePhone(parsed.data.e164);
  if (!normalized.ok || !isE164(normalized.e164)) throw new AppError("validation", PHONE_NUMBER_MESSAGES.invalidNumber);
  const e164 = normalized.e164;

  await assertNotStored(admin, "e164", e164);

  const verifier = deps.verifier ?? resolveNumberVerifier();
  let twilioSid: string;
  switch (verifier.mode) {
    case "unavailable":
      throw new AppError("unavailable", PHONE_NUMBER_MESSAGES.twilioUnconfigured);
    case "mock": {
      const found = mockFindIncomingNumber(e164);
      if (!found) throw new AppError("validation", PHONE_NUMBER_MESSAGES.mockOnly);
      twilioSid = found.sid;
      break;
    }
    case "twilio": {
      let found: TwilioIncomingNumber | null;
      try {
        found = await verifier.rest.findIncomingNumber(e164);
      } catch (error) {
        throw new AppError("unavailable", PHONE_NUMBER_MESSAGES.lookupFailed, { cause: error });
      }
      if (!found) throw new AppError("validation", PHONE_NUMBER_MESSAGES.notInTwilio);
      await assertNotStored(admin, "twilio_sid", found.sid);
      try {
        await verifier.rest.setIncomingNumberVoiceApp(found.sid, verifier.twimlAppSid);
      } catch (error) {
        throw new AppError("unavailable", PHONE_NUMBER_MESSAGES.voiceAppFailed, { cause: error });
      }
      twilioSid = found.sid;
      break;
    }
  }

  const { data, error } = await admin.supabase
    .from("phone_numbers")
    .insert({ e164, twilio_sid: twilioSid, label: parsed.data.label, active: true, assigned_to: null })
    .select(PHONE_NUMBER_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") throw new AppError("conflict", PHONE_NUMBER_MESSAGES.duplicate);
    fail(error);
  }
  return toRecord(data);
}

// ---------------------------------------------------------------------------------------------
// Assignment and active flag
// ---------------------------------------------------------------------------------------------

async function updateNumber(
  admin: RequestContext,
  numberId: string,
  patch: { assigned_to?: string | null; active?: boolean },
): Promise<PhoneNumberRecord> {
  const { data, error } = await admin.supabase
    .from("phone_numbers")
    .update(patch)
    .eq("id", numberId)
    .select(PHONE_NUMBER_COLUMNS);
  if (error) fail(error);
  const row = data?.[0];
  if (!row) throw new AppError("not_found");
  return toRecord(row);
}

/** Assigns the number to an active AGENT or ADMIN. */
export async function assignPhoneNumber(
  ctx: RequestContext | null,
  id: unknown,
  userId: unknown,
): Promise<PhoneNumberRecord> {
  const admin = requireAdmin(ctx);
  const numberId = parseId(id);
  const target = uuidSchema.safeParse(typeof userId === "string" ? userId.trim().toLowerCase() : userId);
  if (!target.success) throw new AppError("validation", PHONE_NUMBER_MESSAGES.chooseAgent);

  const { data: profile, error } = await admin.supabase
    .from("profiles")
    .select("id, role, active")
    .eq("id", target.data)
    .maybeSingle();
  if (error) fail(error);
  if (!profile || !profile.active || (profile.role !== "AGENT" && profile.role !== "ADMIN")) {
    throw new AppError("validation", PHONE_NUMBER_MESSAGES.chooseAgent);
  }
  return updateNumber(admin, numberId, { assigned_to: target.data });
}

/** Back to the shared pool. */
export async function unassignPhoneNumber(ctx: RequestContext | null, id: unknown): Promise<PhoneNumberRecord> {
  const admin = requireAdmin(ctx);
  return updateNumber(admin, parseId(id), { assigned_to: null });
}

const activeSchema = z.boolean();

/** Deactivated numbers are never used as caller ID and unknown callers on them go to admin voicemail (D18). */
export async function setPhoneNumberActive(
  ctx: RequestContext | null,
  id: unknown,
  active: unknown,
): Promise<PhoneNumberRecord> {
  const admin = requireAdmin(ctx);
  const numberId = parseId(id);
  const parsed = activeSchema.safeParse(active);
  if (!parsed.success) throw new AppError("validation");
  return updateNumber(admin, numberId, { active: parsed.data });
}

export function deactivatePhoneNumber(ctx: RequestContext | null, id: unknown): Promise<PhoneNumberRecord> {
  return setPhoneNumberActive(ctx, id, false);
}

export function reactivatePhoneNumber(ctx: RequestContext | null, id: unknown): Promise<PhoneNumberRecord> {
  return setPhoneNumberActive(ctx, id, true);
}
