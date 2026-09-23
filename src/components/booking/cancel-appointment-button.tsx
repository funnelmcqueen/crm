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

/**
 * Offered to the meeting's own booker and to an admin (D48). Cancelling deletes the Google event too (D47), so
 * Google tells the guests — the copy below said the opposite until D48 and was stale from the moment D47 shipped.
 */
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
            The meeting is removed from Google Calendar too, and Google tells everyone invited. That time frees up again.
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
