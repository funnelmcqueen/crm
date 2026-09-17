"use client";

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

/** Admin only. Updates the CRM; the event stays in Google Calendar until the closer deletes it there. */
export function CancelAppointmentButton({ appointmentId }: { appointmentId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-12" disabled={pending}>
          Mark cancelled
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark this meeting cancelled?</AlertDialogTitle>
          <AlertDialogDescription>
            This only updates the CRM. The event stays in your Google Calendar, and that time stays busy, until you delete
            it there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12">Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-12"
            onClick={() =>
              startTransition(async () => {
                const result = await cancelAppointmentAction(appointmentId).catch(() => null);
                if (!result) toast.error("The connection dropped before the server answered. Check the lead, then try again.");
                else if (!result.ok) toast.error(result.error.message);
                else toast.success("Meeting marked cancelled.");
              })
            }
          >
            Mark cancelled
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
