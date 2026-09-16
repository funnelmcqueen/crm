import { Phone } from "lucide-react";
import type { Metadata } from "next";
import { AddNumberDialog } from "@/components/admin/phone-numbers/add-number-dialog";
import { PhoneNumbersList } from "@/components/admin/phone-numbers/phone-numbers-list";
import { currentTime } from "@/components/common/datetime";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { requireAdminPage } from "@/server/context";
import { listAssignableAgents, listPhoneNumbers, numberVerificationMode } from "@/server/services/phone-numbers";

export const metadata: Metadata = {
  title: "Phone Numbers",
};

export default async function PhoneNumbersPage() {
  const ctx = await requireAdminPage();
  const [numbers, agents] = await Promise.all([listPhoneNumbers(ctx), listAssignableAgents(ctx)]);
  const mode = numberVerificationMode();
  const now = currentTime();

  const active = numbers.filter((n) => n.active);
  const pool = active.filter((n) => !n.assignedTo).length;

  return (
    <>
      <PageHeader
        title="Phone Numbers"
        description={
          numbers.length > 0 ? (
            <>
              <span className="font-extrabold text-foreground tabular-nums">{active.length}</span> active ·{" "}
              <span className="font-extrabold text-foreground tabular-nums">{pool}</span> in the pool
              {mode === "mock" ? " · Mock mode" : null}
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
          title="No numbers yet"
          description="Add a number you already bought in Twilio. Agents without their own number call from the pool."
        />
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Buy and release numbers in Twilio. The CRM only verifies them and points them at the TwiML App. Calls today use
        your timezone.
      </p>
    </>
  );
}
