"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { LOGIN_PATH, safeNextPath } from "@/lib/supabase/auth-redirect";
import type { ActionFailure } from "@/server/errors";
import { createServerSupabase } from "@/server/supabase/server";

const signInSchema = z.object({
  email: z.string().trim().max(320).pipe(z.email()),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

/** Every credential problem gets the same message so the form never reveals which accounts exist. */
function invalidCredentials(email: string): ActionFailure & { email: string } {
  return { ok: false, error: { code: "unauthorized", message: "Invalid email or password" }, email };
}

/** Form action for useActionState. Redirects on success; returns the failure (with the email to refill) otherwise. */
export async function signIn(
  _previous: (ActionFailure & { email: string }) | null,
  formData: FormData,
): Promise<(ActionFailure & { email: string }) | null> {
  const rawEmail = formData.get("email");
  const echoEmail = typeof rawEmail === "string" ? rawEmail.slice(0, 320) : "";
  const parsed = signInSchema.safeParse({
    email: rawEmail,
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return invalidCredentials(echoEmail);

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) return invalidCredentials(echoEmail);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) {
    await supabase.auth.signOut({ scope: "local" });
    return {
      ok: false,
      error: { code: "unavailable", message: "Sign-in is temporarily unavailable. Please try again." },
      email: echoEmail,
    };
  }
  if (!profile?.active) {
    await supabase.auth.signOut();
    redirect(`${LOGIN_PATH}?disabled=1`);
  }

  redirect(safeNextPath(parsed.data.next));
}

/** Clears the session cookies. The caller then does a full page load of /login so no client state survives. */
export async function signOut(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut({ scope: "local" });
}
