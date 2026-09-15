/**
 * Promote a user to ADMIN (and re-activate them).
 *
 *   npm run make-admin -- velo@example.com            existing user
 *   npm run make-admin -- velo@example.com --create   create the user if missing (prints a one-time password)
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read from .env.local).
 * Exit codes: 0 success, 1 failure, 2 usage or configuration error.
 */
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "../src/lib/database.types";

const USAGE = "Usage: npm run make-admin -- <email> [--create]";
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_FAILURE,
  ) {
    super(message);
  }
}

type AdminClient = SupabaseClient<Database>;

function loadEnvFallback(): void {
  // `npm run make-admin` already passes --env-file-if-exists=.env.local. This covers direct `npx tsx` runs.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const file = resolve(process.cwd(), ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

function parseCli(argv: string[]): { email: string; create: boolean } {
  let parsed: ReturnType<typeof parseArgs<{ options: { create: { type: "boolean" }; help: { type: "boolean"; short: "h" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { create: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new CliError(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`, EXIT_USAGE);
  }
  if (parsed.values.help) throw new CliError(USAGE, EXIT_OK);
  if (parsed.positionals.length !== 1) throw new CliError(USAGE, EXIT_USAGE);

  const email = z.string().trim().toLowerCase().pipe(z.email()).safeParse(parsed.positionals[0]);
  if (!email.success) throw new CliError(`"${parsed.positionals[0]}" is not a valid email address.\n${USAGE}`, EXIT_USAGE);
  return { email: email.data, create: parsed.values.create === true };
}

function readConfig(): { url: string; serviceRoleKey: string } {
  const schema = z.object({
    NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  });
  const result = schema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ");
    throw new CliError(
      `Missing or invalid ${names}. Set them in .env.local (\`npm run localbase\` prints the local values).`,
      EXIT_USAGE,
    );
  }
  return { url: result.data.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: result.data.SUPABASE_SERVICE_ROLE_KEY };
}

async function findUserByEmail(admin: AdminClient, email: string): Promise<User | null> {
  const perPage = 1000;
  for (let page = 1; page <= 1000; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new CliError(`Could not list users: ${error.message}`);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < perPage || data.nextPage === null) return null;
  }
  return null;
}

const PASSWORD_GROUPS = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%*-_=+?"];

function generatePassword(length = 24): string {
  const alphabet = PASSWORD_GROUPS.join("");
  for (;;) {
    let password = "";
    for (let i = 0; i < length; i += 1) password += alphabet[randomInt(alphabet.length)];
    if (PASSWORD_GROUPS.every((group) => [...password].some((char) => group.includes(char)))) return password;
  }
}

async function createUser(admin: AdminClient, email: string): Promise<User> {
  const password = generatePassword();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new CliError(`Could not create ${email}: ${error?.message ?? "no user returned"}`);
  console.log(`Created user ${email} (${data.user.id}).`);
  console.log(`Temporary password (shown only once, change it in Settings): ${password}`);
  return data.user;
}

async function promote(admin: AdminClient, user: User, email: string): Promise<void> {
  if (user.banned_until && new Date(user.banned_until).getTime() > Date.now()) {
    const { error } = await admin.auth.admin.updateUserById(user.id, { ban_duration: "none" });
    if (error) throw new CliError(`Could not lift the sign-in ban on ${email}: ${error.message}`);
    console.log(`Lifted the sign-in ban on ${email}.`);
  }

  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update({ role: "ADMIN", active: true })
    .eq("id", user.id)
    .select("id")
    .maybeSingle();
  if (updateError) throw new CliError(`Could not update the profile of ${email}: ${updateError.message}`);

  if (!updated) {
    // The on_auth_user_created trigger normally creates the row; this covers users created before the schema.
    const { error: insertError } = await admin
      .from("profiles")
      .insert({ id: user.id, email: user.email ?? email, role: "ADMIN", active: true });
    if (insertError) throw new CliError(`Could not create the profile of ${email}: ${insertError.message}`);
  }
}

async function main(): Promise<number> {
  const { email, create } = parseCli(process.argv.slice(2));
  loadEnvFallback();
  const { url, serviceRoleKey } = readConfig();
  const admin: AdminClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let user = await findUserByEmail(admin, email);
  if (!user) {
    if (!create) throw new CliError(`No user with email ${email}. Re-run with --create to create it.`);
    user = await createUser(admin, email);
  }

  await promote(admin, user, email);
  console.log(`${email} is now an active ADMIN.`);
  return EXIT_OK;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof CliError) {
      (err.exitCode === EXIT_OK ? console.log : console.error)(err.message);
      process.exitCode = err.exitCode;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`make-admin failed: ${message}`);
    process.exitCode = EXIT_FAILURE;
  },
);
