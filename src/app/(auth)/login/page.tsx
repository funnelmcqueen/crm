import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/i18n/metadata";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { safeNextPath } from "@/lib/supabase/auth-redirect";
import { LoginForm } from "./login-form";
import { cookies } from "next/headers";
import { resolveLocale } from "@/lib/i18n/locales";

export async function generateMetadata(): Promise<Metadata> {
  return publicPageMetadata("Sign in", "Anmelden");
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(firstValue(params.next));
  const disabled = firstValue(params.disabled) === "1";
  const locale = resolveLocale((await cookies()).get("crm_locale")?.value);
  const strings = locale === "de"
    ? { disabled: "Konto deaktiviert", message: "Dein Konto wurde deaktiviert. Wende dich an den Administrator, falls dies ein Fehler ist.", privacy: "Datenschutz", terms: "Nutzungsbedingungen" }
    : { disabled: "Account disabled", message: "Your account has been disabled. Contact your admin if this is a mistake.", privacy: "Privacy", terms: "Terms" };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight">
            Funnel <span className="text-primary">McQueen</span>
          </h1>
          <p className="mt-2 text-xs font-bold tracking-[0.3em] text-muted-foreground uppercase">Sales CRM</p>
        </div>

        {disabled ? (
          <Alert variant="destructive" className="mb-6 px-4 py-3">
            <AlertTitle className="font-bold">{strings.disabled}</AlertTitle>
            <AlertDescription>{strings.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-xl border bg-card p-6">
          <LoginForm next={next} />
        </div>

        {/* Discoverable from the sign-in page: Google's consent-screen review fetches both while signed out. */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          <Link href="/privacy" className="hover:underline">
            {strings.privacy}
          </Link>
          <span aria-hidden> · </span>
          <Link href="/terms" className="hover:underline">
            {strings.terms}
          </Link>
        </p>
      </div>
    </main>
  );
}
