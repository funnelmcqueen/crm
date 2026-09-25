import { Phone } from "lucide-react";
import type { Metadata } from "next";
import { appPageMetadata } from "@/lib/i18n/metadata";
import { AddNumberDialog } from "@/components/admin/phone-numbers/add-number-dialog";
import { PhoneNumbersList } from "@/components/admin/phone-numbers/phone-numbers-list";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { getServerWorkspace } from "@/lib/i18n/server-workspace";
import adminEn from "@/lib/i18n/messages/en/admin";
import adminDe from "@/lib/i18n/messages/de/admin";
import { requireAdminPage } from "@/server/context";
import { listAssignableAgents, listPhoneNumbers, numberVerificationMode } from "@/server/services/phone-numbers";

export async function generateMetadata(): Promise<Metadata> {
  return appPageMetadata("Phone Numbers", "Telefonnummern");
}

export default async function PhoneNumbersPage() {
  const ctx = await requireAdminPage();
  const { locale } = await getServerWorkspace(ctx.profile.primary_locale);
  const t = locale === "de" ? adminDe : adminEn;
  const [numbers, agents] = await Promise.all([listPhoneNumbers(ctx), listAssignableAgents(ctx)]);
  const mode = numberVerificationMode();
  const now = currentTime();

  const active = numbers.filter((n) => n.active);
  const pool = active.filter((n) => !n.assignedTo).length;

  return (
    <>
      <PageHeader
        title={t["Phone Numbers"]}
        description={
          numbers.length > 0 ? (
            <>
              <span className="font-extrabold text-foreground tabular-nums">{active.length}</span> {t["active"]} ·{" "}
              <span className="font-extrabold text-foreground tabular-nums">{pool}</span> {t["in the pool"]}
              {mode === "mock" ? ` · ${t["Mock mode"]}` : null}
            </>
          ) : null
        }
        actions={<AddNumberDialog mode={mode} />}
      />

      {numbers.length > 0 ? (
        <PhoneNumbersList rows={numbers} agents={agents} tz={ctx.profile.timezone} now={now} />
      ) : (
        <EmptyState
          icon={<Phone />}
          title={t["No numbers yet"]}
          description={t["Add a number you already bought in Twilio. Agents without their own number call from the pool."]}
        />
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        {t["Buy and release numbers in Twilio. The CRM only verifies them and points them at the TwiML App. Calls today use your timezone."]}
      </p>
    </>
  );
}
