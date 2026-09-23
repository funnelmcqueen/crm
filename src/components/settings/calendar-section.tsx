"use client";

// The Settings card for Google Calendar (design §9, §5, §8): connection status, connect/reconnect (a
// redirect, not an action), disconnect behind a confirmation, and the bookable-hours editor. Never renders
// a token, a ciphertext or any Google event detail — CalendarConnectionStatus carries none of those.
import { useEffect, useState, useTransition } from "react";
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
import type { AgentCalendarRow, CalendarConnectionStatus } from "@/server/services/calendar-connection";
import { AgentCalendarsList } from "./agent-calendars-list";
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

/**
 * Reads `?calendar=` off the URL on mount (never during a static/server render), toasts once, then strips
 * it from the address bar with `history.replaceState` so a refresh doesn't re-fire the toast.
 */
function useCalendarQueryNotice(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const value = url.searchParams.get("calendar");
    if (!value) return;
    const notice = CALENDAR_NOTICES[value];
    if (notice) {
      if (notice.kind === "success") toast.success(notice.message);
      else toast.error(notice.message);
    }
    url.searchParams.delete("calendar");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
}

function DisconnectButton() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await disconnectCalendarAction();
      if (result.ok) {
        toast.success("Google Calendar disconnected.");
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });
  }

  return (
    // Controlled, and refuses to close while pending: AlertDialogAction below calls preventDefault() so it
    // can run the action first, which also suppresses Radix's own close-on-click — confirm() above closes
    // it explicitly once the action actually succeeds (matches SetAgentActiveDialog in agent-dialogs.tsx).
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-12" disabled={pending}>
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect Google Calendar?</AlertDialogTitle>
          <AlertDialogDescription>
            Nobody will be able to book meetings until you reconnect, and everyone will need a new calendar afterwards.
            Meetings already on your Google Calendar are not affected.
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
  /** Every active user and whether they have a calendar of their own yet (docs/DEVIATIONS.md D48). */
  agentCalendars: AgentCalendarRow[];
  /** The company's default time zone (`settings.default_timezone`), named in this card's description. */
  timeZone: string;
}

export function CalendarSection({ status, hours, agentCalendars, timeZone }: CalendarSectionProps) {
  useCalendarQueryNotice();

  return (
    <SettingsSection id="calendar" title="Google Calendar" description={`Times are in ${timeZone}.`}>
      <ConnectionStatus status={status} />
      <div className="border-t pt-4">
        <AgentCalendarsList rows={agentCalendars} connected={status.connected && !status.broken} />
      </div>
      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-bold">Bookable hours</h3>
        {status.hoursSet ? null : (
          <p role="alert" className="text-sm font-semibold text-destructive">
            No bookable hours set, so agents cannot book.
          </p>
        )}
        <BookableHoursForm hours={hours} />
      </div>
    </SettingsSection>
  );
}
