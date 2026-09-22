"use client";

// The Settings card for Google Calendar (design §9, §5, §8): connection status, connect/reconnect (a
// redirect, not an action), disconnect behind a confirmation, and the bookable-hours editor. Never renders
// a token, a ciphertext or any Google event detail — CalendarConnectionStatus carries none of those.
import { useEffect, useTransition } from "react";
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
import type { BookableRange } from "@/lib/domain/bookable-hours";
import { disconnectCalendarAction } from "@/server/actions/calendar-connection";
import type { CalendarConnectionStatus } from "@/server/services/calendar-connection";
import { BookableHoursForm } from "./bookable-hours-form";
import { SettingsSection } from "./settings-section";

/** GET /api/google/start: an admin-only redirect to Google's consent screen, never an action. */
const GOOGLE_START_HREF = "/api/google/start";

// Set by the /api/google/callback redirect (Task 6). Copy is exact, per the brief.
const CALENDAR_NOTICES: Record<string, { message: string; kind: "success" | "error" }> = {
  connected: { message: "Google Calendar connected.", kind: "success" },
  denied: { message: "Google sign-in was cancelled.", kind: "error" },
  error: { message: "Couldn't connect Google Calendar. Try again.", kind: "error" },
};

/** Reads `?calendar=` off the URL on mount (never during a static/server render) and toasts once. */
function useCalendarQueryNotice(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const value = new URLSearchParams(window.location.search).get("calendar");
    if (!value) return;
    const notice = CALENDAR_NOTICES[value];
    if (!notice) return;
    if (notice.kind === "success") toast.success(notice.message);
    else toast.error(notice.message);
  }, []);
}

function DisconnectButton() {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await disconnectCalendarAction();
      if (result.ok) toast.success("Google Calendar disconnected.");
      else toast.error(result.error.message);
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-12" disabled={pending}>
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents won&rsquo;t be able to book meetings until you reconnect. Meetings already on your Google Calendar are
            not affected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-12" disabled={pending}>
            Keep it
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-12 font-bold"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {pending ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConnectionStatus({ status }: { status: CalendarConnectionStatus }) {
  if (!status.connected) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold">Not connected</p>
        <Button asChild className="min-h-12 font-bold">
          <a href={GOOGLE_START_HREF}>Connect Google Calendar</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {status.broken ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm font-semibold text-destructive">
            The connection to Google broke. Reconnect to keep booking meetings.
          </p>
          <Button asChild variant="destructive" className="min-h-12 font-bold">
            <a href={GOOGLE_START_HREF}>Reconnect</a>
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          Connected as <span className="font-semibold">{status.googleEmail}</span>
        </p>
        <DisconnectButton />
      </div>
    </div>
  );
}

export interface CalendarSectionProps {
  status: CalendarConnectionStatus;
  hours: BookableRange[];
  /** The company's default time zone (`settings.default_timezone`), named in this card's description. */
  timeZone: string;
}

export function CalendarSection({ status, hours, timeZone }: CalendarSectionProps) {
  useCalendarQueryNotice();

  return (
    <SettingsSection id="calendar" title="Google Calendar" description={`Times are in ${timeZone}.`}>
      <ConnectionStatus status={status} />
      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-bold">Bookable hours</h3>
        <BookableHoursForm hours={hours} />
      </div>
    </SettingsSection>
  );
}
