"use client";

import { CalendarPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { BOOKING_UNAVAILABLE_MESSAGE, CALENDAR_LOAD_FAILED_MESSAGE } from "@/lib/domain/booking-messages";
import { getAvailabilityAction } from "@/server/actions/calendar-booking";
import { BookingPanel, type BookingLoadState } from "./booking-panel";

export interface BookMeetingButtonProps {
  leadId: string;
  businessName: string;
  /** When set, a plain button with these classes (the in-call bar's look) replaces the default outline button. */
  triggerClassName?: string;
}

export function BookMeetingButton({ leadId, businessName, triggerClassName }: BookMeetingButtonProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BookingLoadState>({ kind: "loading" });
  const [, startTransition] = useTransition();

  function load() {
    setState({ kind: "loading" });
    startTransition(async () => {
      const result = await getAvailabilityAction(leadId).catch(() => null);
      if (!result) setState({ kind: "error", message: CALENDAR_LOAD_FAILED_MESSAGE, unavailable: false });
      // No calendar at all: retrying cannot help, so the panel offers none. A failed load can be retried.
      else if (!result.ok) setState({ kind: "error", message: result.error.message, unavailable: result.error.message === BOOKING_UNAVAILABLE_MESSAGE });
      else setState({ kind: "ready", availability: result.data });
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
    >
      <SheetTrigger asChild>
        {triggerClassName ? (
          <button type="button" aria-label="Book meeting" className={triggerClassName}>
            <CalendarPlus aria-hidden />
            <span className="hidden md:inline">Book meeting</span>
          </button>
        ) : (
          <Button type="button" variant="outline" className="min-h-12 gap-2">
            <CalendarPlus aria-hidden />
            Book meeting
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Book a meeting with {businessName}</SheetTitle>
          <SheetDescription>30 minutes with the closer. Times are shown in the lead&apos;s time zone.</SheetDescription>
        </SheetHeader>
        <BookingPanel leadId={leadId} state={state} onReload={load} onBooked={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
