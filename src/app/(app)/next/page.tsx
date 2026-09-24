import { CheckCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { leadFlowHref, parseSkipParam } from "@/lib/dialer/skip-list";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import { requireUserPage } from "@/server/context";
import { nextLead } from "@/server/services/next-lead";

export const metadata: Metadata = {
  title: "Next lead",
};

export default async function NextLeadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireUserPage();
  const { t } = await getServerWorkspace(ctx.profile.primary_locale);
  const copy = t.nextLeadUi;
  const skip = parseSkipParam((await searchParams).skip);
  const lead = await nextLead(ctx, skip);
  if (lead) redirect(leadFlowHref(lead.leadId, skip, lead.reason));

  return (
    <>
      <PageHeader title={copy.nextLead} />
      <EmptyState
        icon={<CheckCheck />}
        title={copy.caughtUp}
        description={
          skip.length > 0
            ? copy.sessionEmpty
            : copy.empty
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/follow-ups" className="inline-flex min-h-12 items-center rounded-xl border px-5 font-bold outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">{copy.reviewFollowUps}</Link>
            <Link href="/follow-ups?tab=skipped" className="inline-flex min-h-12 items-center rounded-xl border px-5 font-bold outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50">{copy.reviewSkipped}</Link>
            <Link
              href="/leads"
              className="inline-flex min-h-12 items-center rounded-xl bg-primary px-5 text-base font-bold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {copy.goToLeads}
            </Link>
            {skip.length > 0 ? (
              <Link
                href="/next"
                className="inline-flex min-h-12 items-center rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {copy.startOver}
              </Link>
            ) : null}
          </div>
        }
      />
    </>
  );
}
