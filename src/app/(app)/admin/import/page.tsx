import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/common/page-header";
import { ImportWizard } from "@/components/import/import-wizard";
import { Button } from "@/components/ui/button";
import { requireAdminPage } from "@/server/context";

export const metadata: Metadata = {
  title: "Import leads",
};

export default async function ImportLeadsPage() {
  await requireAdminPage();

  return (
    <>
      <PageHeader
        title="Import leads"
        description="Upload a CSV, map its columns, review duplicates, then assign the new leads."
        actions={
          <Button asChild variant="outline" className="h-12 px-4">
            <Link href="/leads">All Leads</Link>
          </Button>
        }
      />
      <ImportWizard />
    </>
  );
}
