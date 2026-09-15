import "server-only";
import { z } from "zod";
import { isUnsafePublicSupabaseKey } from "@/lib/supabase/public-key";

export const DIALER_DRIVERS = ["twilio", "tel", "mock"] as const;
export type DialerDriver = (typeof DIALER_DRIVERS)[number];

export type EnvSource = Readonly<Record<string, string | undefined>>;

const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
] as const;

/** Unset and blank values (e.g. `TWILIO_AUTH_TOKEN=` copied from .env.example) both count as missing. */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const requiredString = z.preprocess(blankToUndefined, z.string().trim().min(1, "is required"));
const optionalString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpOrigin(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
}

const supabaseUrl = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine(isHttpUrl, "must be an http(s) URL")
    .transform((value) => value.replace(/\/+$/, "")),
);

// The public key is inlined into browser bundles: a service_role or secret key there disables RLS for everyone.
const publicSupabaseKey = requiredString.refine(
  (value) => !isUnsafePublicSupabaseKey(value),
  "must be the anon or publishable key, never a service_role or secret key",
);

const publicSupabaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: publicSupabaseKey,
});

const serverEnvSchema = publicSupabaseSchema
  .extend({
    NODE_ENV: z.enum(["development", "production", "test"]).catch("development"),
    SUPABASE_SERVICE_ROLE_KEY: requiredString,
    APP_BASE_URL: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .refine(isHttpOrigin, "must be an http(s) origin with no path, e.g. https://crm.example.com")
        .transform((value) => value.replace(/\/+$/, ""))
        .optional(),
    ),
    DIALER_DRIVER: z.preprocess(
      (value) => (typeof value === "string" ? blankToUndefined(value.trim().toLowerCase()) : value),
      z.enum(DIALER_DRIVERS).optional(),
    ),
    TWILIO_ACCOUNT_SID: optionalString,
    TWILIO_AUTH_TOKEN: optionalString,
    TWILIO_API_KEY_SID: optionalString,
    TWILIO_API_KEY_SECRET: optionalString,
    TWILIO_TWIML_APP_SID: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      ctx.addIssue({ code: "custom", path: ["SUPABASE_SERVICE_ROLE_KEY"], message: "must differ from NEXT_PUBLIC_SUPABASE_ANON_KEY" });
    }
    if (env.DIALER_DRIVER !== "twilio") return;
    for (const key of [...TWILIO_KEYS, "APP_BASE_URL"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "is required when DIALER_DRIVER=twilio" });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export interface PublicSupabaseEnv {
  url: string;
  anonKey: string;
}

/** Lists the offending variable names and rules only. Values are never included. */
function formatEnvError(label: string, error: z.ZodError): Error {
  const problems = error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`);
  return new Error(`${label}: ${problems.join("; ")}`);
}

/** Static property accesses so every bundler (including the proxy build) can see the variables. */
function readProcessEnv(): EnvSource {
  return {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    APP_BASE_URL: process.env.APP_BASE_URL,
    DIALER_DRIVER: process.env.DIALER_DRIVER,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
    TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID,
  };
}

export function parseServerEnv(source: EnvSource): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) throw formatEnvError("Invalid server environment", result.error);
  return result.data;
}

export function parsePublicSupabaseEnv(source: EnvSource): PublicSupabaseEnv {
  const result = publicSupabaseSchema.safeParse(source);
  if (!result.success) throw formatEnvError("Invalid Supabase environment", result.error);
  return { url: result.data.NEXT_PUBLIC_SUPABASE_URL, anonKey: result.data.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

let serverEnvCache: ServerEnv | undefined;
let publicEnvCache: PublicSupabaseEnv | undefined;

/** Parses on first call and caches. Importing this module never throws. */
export function getServerEnv(): ServerEnv {
  serverEnvCache ??= parseServerEnv(readProcessEnv());
  return serverEnvCache;
}

/** Only the public Supabase pair, so login and the proxy keep working when Twilio settings are wrong. */
export function getPublicSupabaseEnv(): PublicSupabaseEnv {
  publicEnvCache ??= parsePublicSupabaseEnv(readProcessEnv());
  return publicEnvCache;
}

export function isTwilioConfigured(env: ServerEnv = getServerEnv()): boolean {
  return TWILIO_KEYS.every((key) => env[key] !== undefined) && env.APP_BASE_URL !== undefined;
}

/**
 * DIALER_DRIVER when set. Otherwise `twilio` when Twilio is fully configured, else `mock` in
 * development/test and `tel` in production (a production app must never silently fake calls).
 */
export function getDialerDriver(env: ServerEnv = getServerEnv()): DialerDriver {
  if (env.DIALER_DRIVER) return env.DIALER_DRIVER;
  if (isTwilioConfigured(env)) return "twilio";
  return env.NODE_ENV === "production" ? "tel" : "mock";
}

export function resetEnvCacheForTests(): void {
  serverEnvCache = undefined;
  publicEnvCache = undefined;
}
