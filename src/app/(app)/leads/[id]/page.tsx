import { ChevronLeft, Globe, Mail, MapPin, ShieldBan } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookMeetingButton } from "@/components/booking/book-meeting-button";
import { NextMeeting } from "@/components/booking/next-meeting";
import { DateTime, currentTime } from "@/components/common/datetime";
import { StatusBadge } from "@/components/common/status-badge";
import { CallButton } from "@/components/dialer/call-button";
import { CallReadiness } from "@/components/dialer/call-readiness";
import { CallingSetupNotice } from "@/components/dashboard/calling-setup-notice";
import { getDialerDriver, type DialerDriver } from "@/server/env";
import { isCallOutcome } from "@/lib/domain/outcomes";
import { formatNumber } from "@/lib/i18n/format";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { NextLeadControls } from "@/components/dialer/next-lead-controls";
import { AdminLeadPanel } from "@/components/leads/admin-lead-panel";
import { CallHistory } from "@/components/leads/call-history";
import { CallPlaybook } from "@/components/leads/call-playbook";
import { CopyPhoneButton } from "@/components/leads/copy-phone-button";
import { FollowUpPicker } from "@/components/leads/follow-up-picker";
import { LeadNotesForm } from "@/components/leads/lead-notes-form";
import { LeadStatusSelect } from "@/components/leads/lead-status-select";
import { OpenSkipNotice, SkipHistory } from "@/components/leads/lead-skips";
import type { DialableLead } from "@/lib/dialer/types";
import { leadTimeZone } from "@/lib/domain/lead-timezone";
import { websiteHref } from "@/lib/domain/website";
import { requireUserPage } from "@/server/context";
import { getNextMeeting } from "@/server/services/calendar-booking";
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
  const { locale, t } = await getServerWorkspace(ctx.profile.primary_locale);
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const detail = await getLeadDetail(ctx, id);
  if (!detail) notFound();

  const { lead, history } = detail;
  const isAdmin = ctx.profile.role === "ADMIN";
  const [agents, skips, nextMeeting, callerId] = await Promise.all([
    isAdmin ? listAgentsForFilter(ctx).then((all) => all.filter((agent) => agent.active)) : Promise.resolve([]),
    getLeadSkipHistory(ctx, lead.id),
    getNextMeeting(ctx, lead.id),
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
        {isAdmin ? t.leadsPage.allLeads : t.leadsPage.myLeads}
      </Link>

      {flow === "next" ? <NextLeadControls leadId={lead.id} businessName={lead.businessName} /> : null}

      <header className="mb-3 flex flex-col gap-4 rounded-xl border border-primary/25 bg-card p-4 md:flex-row md:items-start md:justify-between md:p-5">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-bold tracking-wide text-primary uppercase">{flow === "next" ? t.leadDetail.currentQueue : t.leadDetail.workspace}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-extrabold tracking-tight break-words md:text-3xl">{lead.businessName}</h1>
            <StatusBadge status={lead.status} />
          </div>
          {lead.contactName ? <p className="mt-1 text-base text-muted-foreground">{lead.contactName}</p> : null}
          {isAdmin && detail.admin ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t.leadDetail.agent}{" "}
              <span className="font-semibold text-foreground">{detail.admin.assignedTo?.name ?? t.leadDetail.unassigned}</span>
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

      <section aria-label={t.leadDetail.beforeCall} className="mb-4 grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-3">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-muted-foreground">{t.leadDetail.latestCall}</h2>
          <p className="mt-1 text-sm font-bold">{lastCall ? (lastCall.outcome && isCallOutcome(lastCall.outcome) ? t.outcomes[lastCall.outcome] : t.leadDetail.outcomeNotLogged) : t.leadDetail.noCalls}</p>
          {lastCall ? <DateTime value={lastCall.createdAt} tz={tz} now={now} locale={locale} className="text-xs text-muted-foreground" /> : null}
          {lastCall?.notes ? <p className="mt-1 line-clamp-2 text-sm break-words">{lastCall.notes}</p> : null}
          {lastCall ? <a href="#lead-history" className="inline-flex min-h-12 items-center rounded text-xs font-semibold underline focus-visible:ring-3 focus-visible:ring-ring/50">{t.leadDetail.viewHistory}</a> : null}
        </div>
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-muted-foreground">{t.leadDetail.nextFollowUp}</h2>
          <p className="mt-1 text-sm font-bold"><DateTime value={lead.nextFollowUpAt} tz={tz} now={now} empty={t.leadDetail.nothingScheduled} locale={locale} /></p>
        </div>
        <details className="min-w-0">
          <summary className="min-h-12 cursor-pointer rounded text-sm font-semibold focus-visible:ring-3 focus-visible:ring-ring/50">{t.leadDetail.previousNotes} {lead.notes ? "" : t.leadDetail.noneYet}</summary>
          <p className="max-h-40 overflow-auto text-sm break-words whitespace-pre-wrap">{lead.notes || t.leadDetail.addContext}</p>
        </details>
      </section>

      <CallPlaybook contactName={lead.contactName} agentName={ctx.profile.name} />

      {lead.status !== "DO_NOT_CONTACT" || nextMeeting ? (
        <div className="mb-4 flex flex-col gap-3">
          {lead.status !== "DO_NOT_CONTACT" ? (
            <div>
              <BookMeetingButton leadId={lead.id} businessName={lead.businessName} />
            </div>
          ) : null}
          {nextMeeting ? (
            <NextMeeting
              meeting={nextMeeting}
              timeZone={leadTimeZone({ state: lead.state, country: lead.country }, tz).timeZone}
              now={new Date(now)}
              isAdmin={isAdmin}
            />
          ) : null}
        </div>
      ) : null}

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
            <span className="font-bold">{t.leadDetail.dnc}</span> {t.leadDetail.callingBlocked}
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start">
        <section aria-labelledby="lead-contact" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:col-start-1 md:row-start-1">
          {sectionTitle(t.leadDetail.contact, "lead-contact")}
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
                  <span className="sr-only"> ({t.leadDetail.opensNewTab})</span>
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
              <dt className="text-xs text-muted-foreground">{t.leadDetail.calls}</dt>
              <dd className="text-xl font-extrabold tabular-nums">{formatNumber(lead.callCount, locale)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t.leadDetail.lastContacted}</dt>
              <dd className="font-semibold">
                <DateTime value={lead.lastContactedAt} tz={tz} now={now} style="date" empty={t.leadDetail.never} locale={locale} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t.leadDetail.source}</dt>
              <dd className="truncate font-semibold">{lead.source ?? "—"}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1">
          <section aria-label={t.leadDetail.statusFollowUp} className="flex flex-col gap-5 rounded-xl border bg-card p-4">
            <LeadStatusSelect leadId={lead.id} status={lead.status} isAdmin={isAdmin} />
            <FollowUpPicker leadId={lead.id} nextFollowUpAt={lead.nextFollowUpAt} tz={tz} now={now} />
          </section>
          <section aria-label={t.leadDetail.notes} className="rounded-xl border bg-card p-4">
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
            {sectionTitle(t.leadDetail.callHistory, "lead-history")}
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatNumber(history.length, locale)} {history.length === 1 ? t.leadDetail.call : t.leadDetail.calls}
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
