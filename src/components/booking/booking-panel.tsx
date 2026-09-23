"use client";

import { Loader2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useDialer } from "@/components/dialer/dialer-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CALENDAR_LOAD_FAILED_MESSAGE, STATUS_NOT_UPDATED_MESSAGE } from "@/lib/domain/booking-messages";
import { BUSINESS_TYPES, BUSINESS_TYPE_BEST_FOR, BUSINESS_TYPE_LABELS, isBusinessType } from "@/lib/domain/business-type";
import { cn } from "@/lib/utils";
import { bookAppointmentAction, setLeadBusinessTypeAction } from "@/server/actions/calendar-booking";
import type { AgentAvailability, SlotView } from "@/server/services/calendar-booking";
import { buildBookingDays } from "./booking-model";

export type BookingLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; unavailable: boolean }
  | { kind: "ready"; availability: AgentAvailability };

export interface BookingPanelProps {
  leadId: string;
  state: BookingLoadState;
  onReload(): void;
  onBooked(): void;
}

function SlotButton({ slot, suggested, onChoose }: { slot: SlotView; suggested: boolean; onChoose(slot: SlotView): void }) {
  return (
    <Button
      type="button"
      variant={suggested ? "default" : "outline"}
      data-slot-start={slot.start}
      data-suggestion={suggested ? "" : undefined}
      className={cn("h-auto min-h-12 flex-col items-start gap-0 whitespace-normal py-2 text-left", suggested && "w-full")}
      onClick={() => onChoose(slot)}
    >
      <span className="font-bold">
        {suggested ? `${slot.phrase} ${slot.zone}` : slot.phrase.replace(/^.* at /, "")}
      </span>
      {slot.yourTime ? <span className="text-xs font-normal opacity-80">{slot.yourTime}</span> : null}
    </Button>
  );
}

export function BookingPanel({ leadId, state, onReload, onBooked }: BookingPanelProps) {
  const dialer = useDialer();
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<SlotView | null>(null);
  const [requestId, setRequestId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [booking, startBooking] = useTransition();
  const [saving, startSaving] = useTransition();

  const availability = state.kind === "ready" ? state.availability : null;
  const days = useMemo(() => (availability ? buildBookingDays(availability) : []), [availability]);

  if (state.kind === "loading") {
    return (
      <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Loading the calendar…
      </p>
    );
  }

  if (state.kind === "error" || !availability) {
    return (
      <div role="alert" className="flex flex-col gap-3 p-4 text-sm">
        <p>{state.kind === "error" ? state.message : CALENDAR_LOAD_FAILED_MESSAGE}</p>
        {state.kind === "error" && state.unavailable ? null : (
          <Button type="button" variant="outline" className="min-h-12 self-start" onClick={onReload}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const live = dialer?.state;
  const inCall =
    !!live &&
    (live.kind === "ringing" || live.kind === "in-call" || live.kind === "tel-pending") &&
    live.subject.leadId === leadId;
  const selectedDay = days.find((day) => day.key === dayKey) ?? days.find((day) => day.hasSlots) ?? days[0];

  function choose(slot: SlotView) {
    setChosen(slot);
    setRequestId(crypto.randomUUID());
    setMessage("");
  }

  function changeType(value: string) {
    if (!isBusinessType(value)) return;
    startSaving(async () => {
      const result = await setLeadBusinessTypeAction(leadId, value).catch(() => null);
      if (!result || !result.ok) {
        setMessage(result ? result.error.message : "The connection dropped. Try again.");
        return;
      }
      onReload();
    });
  }

  function book() {
    if (!chosen) return;
    const slot = chosen;
    startBooking(async () => {
      const result = await bookAppointmentAction({ leadId, start: slot.start, note: note.trim() === "" ? null : note, clientRequestId: requestId, inCall }).catch(() => null);
      if (!result) {
        setMessage("The connection dropped before the server answered. Try again; it will not book twice.");
        return;
      }
      if (!result.ok) {
        setMessage(result.error.message);
        if (result.error.code === "conflict") {
          setChosen(null);
          onReload();
        }
        return;
      }
      toast.success(`Booked: ${result.data.phrase} ${result.data.zone}`);
      if (result.data.statusNeedsAttention) toast.warning(STATUS_NOT_UPDATED_MESSAGE);
      if (inCall) dialer?.markMeetingBooked(leadId);
      onBooked();
    });
  }

  return (
    <div className="flex flex-col gap-5 p-4" data-time-zone={availability.leadTimeZone}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`booking-type-${leadId}`}>Business type</Label>
        <Select value={availability.businessType} onValueChange={changeType} disabled={saving}>
          <SelectTrigger id={`booking-type-${leadId}`} className="min-h-12 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BUSINESS_TYPES.map((type) => (
              <SelectItem key={type} value={type} className="min-h-12">
                {BUSINESS_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {availability.businessTypeIsGuess ? "Guessed from the name. " : ""}
          Their time: {availability.zone}
          {availability.leadTimeZoneIsGuess ? " (their time zone is unknown, so this is yours)" : ""}
        </p>
      </div>

      {availability.suggestions.length > 0 ? (
        <section aria-labelledby={`booking-best-${leadId}`} className="flex flex-col gap-2">
          <h3 id={`booking-best-${leadId}`} className="text-sm font-bold">
            Best for {BUSINESS_TYPE_BEST_FOR[availability.businessType]}
          </h3>
          {availability.suggestions.map((slot) => (
            <SlotButton key={slot.start} slot={slot} suggested onChoose={choose} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby={`booking-all-${leadId}`} className="flex flex-col gap-3">
        <h3 id={`booking-all-${leadId}`} className="text-sm font-bold">
          All open times
        </h3>
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Days">
          {days.map((day) => (
            <Button
              key={day.key}
              type="button"
              variant={day.key === selectedDay?.key ? "default" : "outline"}
              aria-pressed={day.key === selectedDay?.key}
              disabled={!day.hasSlots}
              data-day={day.key}
              className="min-h-12 shrink-0"
              onClick={() => setDayKey(day.key)}
            >
              {day.label}
            </Button>
          ))}
        </div>
        {selectedDay && selectedDay.entries.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {selectedDay.entries.map((entry) => (
              <li key={`${entry.kind}-${entry.start}`}>
                {entry.kind === "slot" ? (
                  <SlotButton slot={entry.slot} suggested={false} onChoose={choose} />
                ) : entry.kind === "busy" ? (
                  <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <span className="font-semibold">Busy</span> {entry.label}
                  </p>
                ) : (
                  <p className="rounded-lg border px-3 py-2 text-sm">
                    <span className="font-semibold">Your meeting</span> {entry.label}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No open times on this day.</p>
        )}
      </section>

      {chosen ? (
        <section aria-label="Confirm the meeting" className="flex flex-col gap-3 rounded-xl border p-4">
          <p className="font-bold">
            Book {chosen.phrase} {chosen.zone} with {availability.businessName}?
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`booking-note-${leadId}`}>Note on the meeting (optional)</Label>
            <Textarea id={`booking-note-${leadId}`} value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="min-h-12" disabled={booking} onClick={book}>
              {booking ? "Booking…" : "Book"}
            </Button>
            <Button type="button" variant="outline" className="min-h-12" disabled={booking} onClick={() => setChosen(null)}>
              Pick another time
            </Button>
          </div>
        </section>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </div>
  );
}
