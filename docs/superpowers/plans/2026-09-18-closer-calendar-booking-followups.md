# Closer calendar booking: follow-ups after milestone 1

Left deliberately undone when the mock-calendar milestone (D46) merged, from the task reviews and the
whole-branch review. Ordered by what the next person should pick up first. Nothing here blocks the
release that shipped; the two human rulings at the end are settled and are recorded so they are not
re-litigated.

## Take these with Plan 2 (the Google connection)

- **Contract for `readAvailability`.** The re-check in `src/server/services/calendar-booking.ts`
  (`ensureStillFree`) reads a narrow range around the chosen slot and expects the client to return
  windows *unclipped*. The mock does. A Google client that clipped windows to the requested range
  would make every slot at a window edge unbookable. State the expectation in
  `src/server/calendar/types.ts` and test it.
- **Timeout on the calendar read.** The design promises 8 seconds; `CalendarClient` has no timeout and
  the mock never blocks.
- **A guard on `getAgentAvailability`.** One calendar read per panel open per server instance, with a
  60-second cache and no per-user limit. Google quota makes that a real constraint.
- **`invalid_grant` handling.** The design's §10 row (booking unavailable, `broken_at` set) has no code
  behind it yet: every `createMeeting` failure is reported as "Couldn't book the meeting".
- **`CALENDAR_DRIVER=google` fails silently** (`src/server/calendar/client.ts`): it resolves to `null`
  with no log, so a correct setting looks exactly like an absent one. Either reject it in
  `serverEnvSchema` until the driver exists, or log once.
- **Auto-detect the driver.** The design says an unset `CALENDAR_DRIVER` should resolve to `google`
  when the Google credentials are configured, mirroring `isTwilioConfigured` for `DIALER_DRIVER`.
- **`defaultCalendar` swallows a settings read error** and falls back to `America/New_York`. Harmless
  for the mock; with Google the closer's zone decides the real windows.

## Worth fixing soon in the UI

- **The booking sheet covers the in-call bar.** The sheet is modal (`z-50`) and the bar is `z-40`, so
  Mute, Keypad and Hang up cannot be clicked while the panel is open, and clicking where Hang up sits
  just closes the panel. `modal={false}` on the in-call instance is the fix.
- **A remote hang-up unmounts the bar and the open panel**, losing a chosen slot and an unsent note.
  Recoverable from the lead page, but fragile in the main flow.
- **The panel is narrower than intended.** `w-full sm:max-w-lg` on the sheet loses to
  `data-[side=right]:` classes in `src/components/ui/sheet.tsx`, so the panel is 75% wide on a phone and
  at most 24rem on desktop, and a long business name runs under the close button. Either make the
  override win (`data-[side=right]:w-full data-[side=right]:sm:max-w-lg`) or drop the dead classes.
- **"Book meeting" shows while the dialer is `preparing`**, but `inCall` and the `MEETING_BOOKED` action
  exclude that state, so such a booking moves the lead's status and skips the Appointment preselect.
  Either hide the trigger while preparing or treat preparing as in-call.
- **A business-type save error never clears** after a later successful change
  (`src/components/booking/booking-panel.tsx`): add `setMessage("")` on success.
- **No follow-up picker beside "Booking isn't available"** in the in-call panel, which the design's §10
  asks for. The lead page already has one. This is the one place the build is visibly short of the
  design.

## Smaller, when the file is next open

- **The re-check re-applies the 120-minute notice** with a fresh `now`, so an agent who pauses for a
  minute over the earliest offered slot is told "That time was just taken" — a wrong explanation for a
  right refusal. Pass `noticeMinutes: 0` in `ensureStillFree`; the notice was already satisfied when
  the slot was offered and `begin_appointment` still guarantees a future start.
- **The day strip hides up to one day inside the horizon.** `buildBookingDays` lays out 14 calendar
  days from today while `freeSlots` runs to `now + 14 days`, so slots early on day 14 have no button.
  Use `BOOKING_HORIZON_DAYS + 1`, or drive the strip off the distinct `slot.day` values.
- **Merged busy time defeats the panel's own-meeting dedup.** `busy` is merged in the service, so an
  agent's own meeting adjacent to other busy time no longer matches by exact times and shows as a
  merged **Busy** block *and* as their meeting. Cosmetic; nothing leaks.
- **The stale-pending delete is unindexed.** Every booking scans `appointments` for
  `status = 'pending' and created_at < now() - 10 minutes`. Harmless at today's volume; add an index on
  `(status, created_at)` in a later migration if it grows. Note the delete is deliberately global, not
  per-caller, so a dead row cannot hold a slot — `docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md`
  §5.2 still says "the caller's", which is now wrong.
- **`assertTimeZone` guard** on `src/lib/domain/slot-phrase.ts`, which every sibling zone helper in
  `src/lib/domain/time.ts` has.
- **`toLeadRecord({ ...row, business_type: null })`** at `src/server/services/leads.ts:336,569` writes a
  falsehood to satisfy a type; `Omit<LeadRow, "dedupe_name_key" | "business_type">` on the parameter is
  the honest fix.
- **Bulk copy asymmetry:** `describeBusinessTypeResult` omits the "already had it or are no longer
  available" tail when clearing, unlike its sibling for lead source.

## Test gaps worth closing

- **`KEEP_STATUS_ON_BOOKING`** has no test: booking a CLIENT lead must not drag its status back to
  Appointment. This is a business rule with nothing holding it.
- The 60-second availability cache is uncovered — every test injects a calendar, which bypasses it.
- `resolveCalendarClient`, including its `catch → null` branch.
- `statusNeedsAttention: true`, a calendar read failing during the re-check, and `getNextMeeting`'s
  `bookedByName` (including the admin-sees-null case).
- `e2e/workspace-calendar-booking.spec.ts` can pass vacuously when the booked day's button is disabled:
  the slot it asserts is absent is on a day that is not rendered.

## Settled by the project owner — do not reopen

- **A booking replayed while the first attempt is still pending** re-runs the booking (duplicate event,
  or the first attempt's pending row abandoned). A double click is already safe; this needs a dropped
  connection mid-booking. Ruled 2026-09-17: leave as planned.
- **An unrecognised business type in a CSV always lands in the lead's notes**, even with "Append
  unmapped columns to notes" switched off. Ruled 2026-09-17: always keep it.
