import type { Metadata } from "next";
import Link from "next/link";

// Public, no session required (isPublicPath). Google requires a reachable terms-of-service link before an OAuth
// consent screen can be published.

export const metadata: Metadata = {
  title: "Terms",
  description: "Terms of service for the Funnel McQueen CRM.",
};

const UPDATED = "23 September 2026";
const CONTACT = "2velireci@gmail.com";

export default function TermsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <Link href="/login" className="text-sm font-semibold text-primary hover:underline">
          Funnel McQueen CRM
        </Link>
        <h1 className="text-3xl font-extrabold tracking-tight">Terms of service</h1>
        <p className="text-sm text-muted-foreground">Last updated {UPDATED}.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Who may use it</h2>
        <p className="text-sm leading-relaxed">
          Funnel McQueen CRM is a private tool for the Funnel McQueen sales team. Accounts are issued by an
          administrator; there is no public sign-up and no charge to users. By signing in you agree to these terms. If
          you do not, do not sign in.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Your account</h2>
        <p className="text-sm leading-relaxed">
          Keep your password to yourself and do not let anyone else use your account. Tell an administrator promptly
          if you think someone else has access to it. An administrator may disable an account at any time, and a
          disabled account loses access immediately.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Acceptable use</h2>
        <p className="text-sm leading-relaxed">
          Use the CRM only for the sales work it exists for. Do not use it to contact people who have asked not to be
          contacted, do not export or copy lead data for any purpose outside that work, and follow the calling and
          marketing rules that apply where you and the lead are located. Do not attempt to reach data belonging to
          other team members, or to circumvent the access rules the application enforces.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Connected Google account</h2>
        <p className="text-sm leading-relaxed">
          An administrator may connect a Google account so that booked meetings appear in Google Calendar. What the
          application accesses and stores is set out in the{" "}
          <Link href="/privacy" className="text-primary hover:underline">
            privacy policy
          </Link>
          . Connecting is optional and can be undone at any time from the application&rsquo;s settings.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Availability and changes</h2>
        <p className="text-sm leading-relaxed">
          The CRM is provided as it is, without warranty of any kind. It may be unavailable, may lose data, and may be
          changed or discontinued at any time without notice. Features that depend on outside services — telephony,
          Google Calendar — can stop working for reasons outside the operator&rsquo;s control. To the fullest extent
          the law allows, the operator is not liable for any loss arising from use of the application.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Contact</h2>
        <p className="text-sm leading-relaxed">
          Questions about these terms go to{" "}
          <a href={`mailto:${CONTACT}`} className="text-primary hover:underline">
            {CONTACT}
          </a>
          .
        </p>
      </section>

      <footer className="border-t pt-6 text-sm">
        <Link href="/privacy" className="text-primary hover:underline">
          Privacy policy
        </Link>
      </footer>
    </main>
  );
}
