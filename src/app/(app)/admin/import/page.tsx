import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
import Link from "next/link";
import { PageHeader } from "@/components/common/page-header";
import { ImportWizard } from "@/components/import/import-wizard";
import { Button } from "@/components/ui/button";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
import { requireAdminPage } from "@/server/context";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Import leads", "Leads importieren");
}

export default async function ImportLeadsPage() {
  const ctx = await requireAdminPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? adminDe : adminEn;

  return (
    <>
      <PageHeader
        title={t["Import leads"]}
        description={t["Upload a CSV, map its columns, review duplicates, then assign the new leads."]}
        actions={
          <Button asChild variant="outline" className="h-12 px-4">
            <Link href="/leads">{t["All Leads"]}</Link>
          </Button>
        }
      />
      <ImportWizard />
    </>
  );
}
