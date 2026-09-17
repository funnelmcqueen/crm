import { ChevronLeft, Globe, Mail, MapPin, ShieldBan } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime, currentTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
import { CallButton } from "@/components/dialer/call-button";
import { CallReadiness } from "@/components/dialer/call-readiness";
import { CallingSetupNotice } from "@/components/dashboard/calling-setup-notice";
import { getDialerDriver, type DialerDriver } from "@/server/env";
import { OUTCOME_LABELS } from "@/lib/domain/outcomes";
import { NextLeadControls } from "@/components/dialer/next-lead-controls";
import { AdminLeadPanel } from "@/components/leads/admin-lead-panel";
import { CallHistory } from "@/components/leads/call-history";
import { CopyPhoneButton } from "@/components/leads/copy-phone-button";
import { FollowUpPicker } from "@/components/leads/follow-up-picker";
import { LeadNotesForm } from "@/components/leads/lead-notes-form";
import { LeadStatusSelect } from "@/components/leads/lead-status-select";
import { OpenSkipNotice, SkipHistory } from "@/components/leads/lead-skips";
import type { DialableLead } from "@/lib/dialer/types";
import { websiteHref } from "@/lib/domain/website";
import { requireUserPage } from "@/server/context";
import { getLeadDetail, listAgentsForFilter } from "@/server/services/leads";
import { getLeadSkipHistory } from "@/server/services/skipped-leads";

export const metadata: Metadata = {
  title: "Lead",
};

function sectionTitle(text: string, id?: string) {
  return (
    <h2 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {text}
    </h2>
  );
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const detail = await getLeadDetail(ctx, id);
  if (!detail) notFound();

  const { lead, history } = detail;
  const isAdmin = ctx.profile.role === "ADMIN";
  const [agents, skips, callerId] = await Promise.all([
    isAdmin ? listAgentsForFilter(ctx).then((all) => all.filter((agent) => agent.active)) : Promise.resolve([]),
    getLeadSkipHistory(ctx, lead.id),
    ctx.supabase.rpc("my_caller_id_available"),
  ]);
  const openSkip = skips.find((skip) => skip.resolvedAt === null) ?? null;
  let driver: DialerDriver = "tel";
  try { driver = getDialerDriver(); } catch { /* Same phone fallback as the app shell. */ }
  const lastCall = history[0];
  const tz = ctx.profile.timezone;
  const now = currentTime();
  const flow = Array.isArray(query.flow) ? query.flow[0] : query.flow;
  // An admin reviewing an agent's lead must not clear that agent's unheard voicemails (D20).
  const assignedToId = detail.admin?.assignedTo?.id ?? null;
  const canMarkHeard = !isAdmin || assignedToId === null || assignedToId === ctx.userId;

  const dialable: DialableLead = {
    id: lead.id,
    businessName: lead.businessName,
    contactName: lead.contactName,
    phone: lead.phone,
    status: lead.status,
  };
  const website = websiteHref(lead.website);
  const location = [lead.address, [lead.city, lead.state].filter(Boolean).join(", "), lead.country]
    .filter((part): part is string => !!part && part.trim() !== "")
    .join(" · ");

  return (
    <div className="pb-24 md:pb-0">
      <Link
        href="/leads"
        className="-ml-2 mb-2 inline-flex min-h-12 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden className="size-4" />
        {isAdmin ? "All Leads" : "My Leads"}
      </Link>

      {flow === "next" ? <NextLeadControls leadId={lead.id} businessName={lead.businessName} /> : null}

      <header className="mb-3 flex flex-col gap-4 rounded-xl border border-primary/25 bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-bold tracking-wide text-primary uppercase">{flow === "next" ? "Current lead · Call queue" : "Lead workspace"}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-extrabold tracking-tight break-words md:text-3xl">{lead.businessName}</h1>
            <StatusBadge status={lead.status} />
          </div>
          {lead.contactName ? <p className="mt-1 text-base text-muted-foreground">{lead.contactName}</p> : null}
          {isAdmin && detail.admin ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Agent:{" "}
              <span className="font-semibold text-foreground">{detail.admin.assignedTo?.name ?? "Unassigned"}</span>
            </p>
          ) : null}
        </div>
        <div className="hidden shrink-0 md:block">
          <CallButton lead={dialable} size="lg" className="h-14 min-w-48 text-lg font-extrabold" />
        </div>
      </header>
      <div className="mb-4 space-y-2">
        <CallReadiness phone={lead.phone} />
        {!callerId.error ? <CallingSetupNotice driver={driver} inAppEnabled={ctx.profile.in_app_calling_enabled} callerIdAvailable={callerId.data === true} isAdmin={isAdmin} /> : null}
      </div>

      <section aria-label="Before you call" className="mb-4 grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-3">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-muted-foreground">Latest call</h2>
          <p className="mt-1 text-sm font-bold">{lastCall ? (lastCall.outcome ? OUTCOME_LABELS[lastCall.outcome] : "Outcome not logged") : "No calls yet"}</p>
          {lastCall ? <DateTime value={lastCall.createdAt} tz={tz} now={now} className="text-xs text-muted-foreground" /> : null}
          {lastCall?.notes ? <p className="mt-1 line-clamp-2 text-sm break-words">{lastCall.notes}</p> : null}
          {lastCall ? <a href="#lead-history" className="inline-flex min-h-12 items-center rounded text-xs font-semibold underline focus-visible:ring-3 focus-visible:ring-ring/50">View call history</a> : null}
        </div>
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-muted-foreground">Next follow-up</h2>
          <p className="mt-1 text-sm font-bold"><DateTime value={lead.nextFollowUpAt} tz={tz} now={now} empty="Nothing scheduled" /></p>
        </div>
        <details className="min-w-0">
          <summary className="min-h-12 cursor-pointer rounded text-sm font-semibold focus-visible:ring-3 focus-visible:ring-ring/50">Previous notes {lead.notes ? "" : "· none yet"}</summary>
          <p className="max-h-40 overflow-auto text-sm break-words whitespace-pre-wrap">{lead.notes || "Add useful context in Notes below."}</p>
        </details>
      </section>

      {openSkip ? (
        <OpenSkipNotice
          leadId={lead.id}
          skip={openSkip}
          tz={tz}
          now={now}
          forAgent={isAdmin && assignedToId !== ctx.userId ? (detail.admin?.assignedTo?.name ?? null) : null}
        />
      ) : null}

      {lead.status === "DO_NOT_CONTACT" ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <ShieldBan aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
          <p>
            <span className="font-bold">Do Not Contact.</span> Calling is blocked for this lead.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start">
        <section aria-labelledby="lead-contact" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:col-start-1 md:row-start-1">
          {sectionTitle("Contact", "lead-contact")}
          <div className="flex flex-col gap-1">
            <CopyPhoneButton phone={lead.phone} />
            {lead.email ? (
              <a
                href={`mailto:${lead.email}`}
                className="-mx-2 inline-flex min-h-12 items-center gap-2 rounded-lg px-2 break-all outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Mail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {lead.email}
              </a>
            ) : null}
            {lead.website ? (
              website ? (
                <a
                  href={website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="-mx-2 inline-flex min-h-12 items-center gap-2 rounded-lg px-2 break-all outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  {lead.websiteDomain ?? lead.website}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <p className="inline-flex min-h-12 items-center gap-2 break-all text-muted-foreground">
                  <Globe aria-hidden className="size-4 shrink-0" />
                  {lead.website}
                </p>
              )
            ) : null}
            {location ? (
              <p className="inline-flex min-h-12 items-center gap-2">
                <MapPin aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {location}
              </p>
            ) : null}
          </div>
          <dl className="grid grid-cols-3 gap-3 border-t pt-4 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Calls</dt>
              <dd className="text-xl font-extrabold tabular-nums">{lead.callCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last contacted</dt>
              <dd className="font-semibold">
                <DateTime value={lead.lastContactedAt} tz={tz} now={now} style="date" empty="Never" />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Source</dt>
              <dd className="truncate font-semibold">{lead.source ?? "—"}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1">
          <section aria-label="Lead status and follow-up" className="flex flex-col gap-5 rounded-xl border bg-card p-4">
            <LeadStatusSelect leadId={lead.id} status={lead.status} isAdmin={isAdmin} />
            <FollowUpPicker leadId={lead.id} nextFollowUpAt={lead.nextFollowUpAt} tz={tz} now={now} />
          </section>
          <section aria-label="Notes" className="rounded-xl border bg-card p-4">
            <LeadNotesForm key={lead.id} userId={ctx.userId} leadId={lead.id} notes={lead.notes} />
          </section>
          {isAdmin && detail.admin ? (
            <AdminLeadPanel
              leadId={lead.id}
              businessName={lead.businessName}
              assignedTo={detail.admin.assignedTo}
              agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
              details={{
                businessName: lead.businessName,
                contactName: lead.contactName ?? "",
                phone: lead.phoneRaw && lead.phoneRaw.trim() !== "" ? lead.phoneRaw : lead.phone,
                email: lead.email ?? "",
                website: lead.website ?? "",
                address: lead.address ?? "",
                city: lead.city ?? "",
                state: lead.state ?? "",
                country: lead.country ?? "",
                source: lead.source ?? "",
              }}
            />
          ) : null}
        </div>

        <section aria-labelledby="lead-history" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:col-start-1 md:row-start-2">
          <div className="flex items-baseline justify-between">
            {sectionTitle("Call history", "lead-history")}
            <span className="text-xs text-muted-foreground tabular-nums">
              {history.length} {history.length === 1 ? "call" : "calls"}
            </span>
          </div>
          <CallHistory history={history} tz={tz} now={now} isAdmin={isAdmin} canMarkHeard={canMarkHeard} />
        </section>

        {skips.length > 0 ? (
          <section aria-labelledby="lead-skips" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:col-start-1 md:row-start-3">
            <div className="flex items-baseline justify-between">
              {sectionTitle("Skip history", "lead-skips")}
              <span className="text-xs text-muted-foreground tabular-nums">
                {skips.length} {skips.length === 1 ? "skip" : "skips"}
              </span>
            </div>
            <SkipHistory entries={skips} tz={tz} now={now} />
          </section>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-(--bottom-nav-height) z-30 border-t bg-background px-4 py-3 md:hidden">
        <CallButton lead={dialable} size="lg" className="h-14 w-full text-lg font-extrabold" />
      </div>
    </div>
  );
}
