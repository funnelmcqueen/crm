"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelAppointmentAction } from "@/server/actions/calendar-booking";

/**
 * Offered to the meeting's own booker and to an admin (D48). Cancelling deletes the Google event too (D47), so
 * Google tells the guests — the copy below said the opposite until D48 and was stale from the moment D47 shipped.
 */
export function CancelAppointmentButton({ appointmentId }: { appointmentId: string }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-12" disabled={pending}>
          {t.markCancelled}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.markCancelledQuestion}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.cancelDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12">{t.keepIt}</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-12"
            onClick={() =>
              startTransition(async () => {
                const result = await cancelAppointmentAction(appointmentId).catch(() => null);
                if (!result) toast.error(t.connectionDropped);
                else if (!result.ok) toast.error(getAppErrorMessage(result.error.code, locale, result.error.message));
                else toast.success(t.meetingCancelled);
              })
            }
          >
            {t.markCancelled}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
