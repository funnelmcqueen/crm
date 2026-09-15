import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/server/supabase/server";

// Only the email-change link lands here. Sign-up, invite and magic-link flows are not offered.
const confirmSchema = z.object({
  token_hash: z.string().min(1).max(1024),
  type: z.literal("email_change"),
});

export async function GET(request: NextRequest) {
  const parsed = confirmSchema.safeParse({
    token_hash: request.nextUrl.searchParams.get("token_hash"),
    type: request.nextUrl.searchParams.get("type"),
  });
  if (!parsed.success) redirect("/settings?email_change=invalid");

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.verifyOtp({ token_hash: parsed.data.token_hash, type: parsed.data.type });

  redirect(error ? "/settings?email_change=failed" : "/settings?email_change=confirmed");
}
