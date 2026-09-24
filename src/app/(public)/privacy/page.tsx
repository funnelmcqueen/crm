import type { Metadata } from "next";
import Link from "next/link";

// Public, no session required (isPublicPath). Google requires a reachable privacy policy before an OAuth
// consent screen can be published, and its reviewers check that this page matches what the app actually does
// with Google user data — so the scope list below must stay in step with GOOGLE_SCOPES in
// src/server/google/oauth.ts and with what src/server/calendar/google.ts actually calls.

export const metadata: Metadata = {
  title: "Privacy",
  description: "How the Funnel McQueen CRM handles your data, including Google account data.",
};

const UPDATED = "23 September 2026";
const CONTACT = "2velireci@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <header className="flex flex-col gap-2">
        <Link href="/login" className="text-sm font-semibold text-primary hover:underline">
          Funnel McQueen CRM
        </Link>
        <h1 className="text-3xl font-extrabold tracking-tight">Privacy policy</h1>
        <p className="text-sm text-muted-foreground">Last updated {UPDATED}.</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Who this covers</h2>
        <p className="text-sm leading-relaxed">
          Funnel McQueen CRM is a private, internal tool used by the Funnel McQueen sales team to manage sales leads
          and book meetings. It is not offered to the public and there is no sign-up: accounts are created by an
          administrator. This page explains what the application stores and what it does with data from a connected
          Google account.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Google account data</h2>
        <p className="text-sm leading-relaxed">
          An administrator may connect one Google account so that meetings booked in the CRM appear in Google
          Calendar. Connecting is optional and can be undone at any time. When connected, the application requests
          these permissions and no others:
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
          <li>
            <span className="font-semibold">Your email address</span> (<code>openid</code>,{" "}
            <code>userinfo.email</code>) — shown in the application&rsquo;s settings so you can see which account is
            connected.
          </li>
          <li>
            <span className="font-semibold">Free/busy times</span> (<code>calendar.freebusy</code>) — start and end
            times of busy periods only. This permission returns no event titles, descriptions, locations or guests.
          </li>
          <li>
            <span className="font-semibold">Calendars this application creates</span> (
            <code>calendar.app.created</code>) — permission to create calendars, and to add, change and delete events
            <span className="font-semibold"> only on calendars this application itself created</span>.
          </li>
        </ul>
        <p className="text-sm leading-relaxed">
          The application cannot read the contents of your existing calendars. It is not granted permission to list or
          open events on your primary calendar or on any calendar it did not create, and it never requests one.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">What is stored</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed">
          <li>The email address of the connected Google account.</li>
          <li>
            A refresh token, encrypted with AES-256-GCM before it is written to the database. It is never logged and
            never sent to a browser.
          </li>
          <li>The identifiers of the calendars this application created, one per member of the sales team.</li>
          <li>
            For each meeting booked through the CRM: its start and end time, the identifier of the Google event, and
            the lead it belongs to.
          </li>
        </ul>
        <p className="text-sm leading-relaxed">
          Access tokens are held in server memory only and are never written to the database, a log, a cookie or a
          browser. No content of any calendar event is stored.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">How it is used</h2>
        <p className="text-sm leading-relaxed">
          Google data is used for one purpose: to show which times are free, and to create and cancel meetings booked
          in the CRM. It is not used for advertising, not used to build profiles, not sold, and not shared with anyone
          beyond the service providers that host the application (Vercel) and its database (Supabase). It is never
          transferred to a third party for their own purposes, and it is never used to train artificial intelligence
          or machine learning models.
        </p>
        <p className="text-sm leading-relaxed">
          Funnel McQueen CRM&rsquo;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Removing access</h2>
        <p className="text-sm leading-relaxed">
          An administrator can disconnect the Google account from the application&rsquo;s settings at any time. This
          deletes the stored token and asks Google to revoke it. You can also revoke access yourself at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            className="text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>
          . Calendars and events already created remain in your Google Calendar and are yours to keep or delete.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Other data in the application</h2>
        <p className="text-sm leading-relaxed">
          Besides Google data, the CRM stores the business contact details of sales leads (business name, contact
          name, phone number, email address, website and address), notes and call outcomes recorded by the sales team,
          and each team member&rsquo;s name, email address and settings. Call recordings are not made.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Contact</h2>
        <p className="text-sm leading-relaxed">
          Questions about this policy, or requests to remove data, go to{" "}
          <a href={`mailto:${CONTACT}`} className="text-primary hover:underline">
            {CONTACT}
          </a>
          .
        </p>
      </section>

      <footer className="border-t pt-6 text-sm">
        <Link href="/terms" className="text-primary hover:underline">
          Terms of service
        </Link>
      </footer>
    </main>
  );
}
