import { CheckCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { leadFlowHref, parseSkipParam } from "@/lib/dialer/skip-list";
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
  const skip = parseSkipParam((await searchParams).skip);
  const lead = await nextLead(ctx, skip);
  if (lead) redirect(leadFlowHref(lead.leadId, skip, lead.reason));

  return (
    <>
      <PageHeader title="Next lead" />
      <EmptyState
        icon={<CheckCheck />}
        title="You're all caught up"
        description={
          skip.length > 0
            ? "No more leads to call right now. Start over to see the leads you skipped."
            : "No leads need a call right now. Check back later or browse your leads."
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link
              href="/leads"
              className="inline-flex min-h-12 items-center rounded-xl bg-primary px-5 text-base font-bold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Go to leads
            </Link>
            {skip.length > 0 ? (
              <Link
                href="/next"
                className="inline-flex min-h-12 items-center rounded-xl border bg-card px-5 text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Start over
              </Link>
            ) : null}
          </div>
        }
      />
    </>
  );
}
