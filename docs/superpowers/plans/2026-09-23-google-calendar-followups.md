# Google Calendar connection: follow-ups after milestone 2

Left deliberately undone when the Google connection (D47) merged, from the task reviews and the
whole-branch review. Nothing here blocks the release. Milestone 1's own list is in
`2026-09-18-closer-calendar-booking-followups.md`; items there that this milestone changed the cost of
are noted below rather than repeated.

## Worth doing when the connection has run for a while

- **A banner that says when the connection broke.** The design asked for "Reconnect needed, with when it
  broke"; `get_calendar_status` returns `broken boolean` only, so the banner cannot say. Add `broken_at`
  to the status row and show it.
- **Saving an empty week** is allowed and now warns in Settings, but nothing stops an admin from wiping
  every bookable hour by accident. A confirmation would be cheap.
- **A rate limit or cache guard on `getAgentAvailability`.** One free/busy call per panel open per server
  instance, cached 60 seconds, with no per-user limit. Google's quota is generous but not infinite, and a
  bored agent opening the panel repeatedly is the obvious way to find the edge.
- **Busy time from the owner's other secondary calendars is invisible** (the granted scopes only reach the
  primary and the app's own calendar), so an agent can book over time blocked on a shared family calendar.
  The smallest fix is a Settings field listing extra calendar ids to treat as busy.

## Test gaps, in rough order of what they would catch

- `KEEP_STATUS_ON_BOOKING` still has no test (milestone 1's list): booking a CLIENT lead must not drag its
  status back to Appointment.
- No test pins "a 429 or 503 is not retried" to a single call. The retry rule is a global constraint and
  currently only the connection-error and 400 cases are covered.
- The `invalid_grant`-during-*booking* branch is untested; only the availability path is covered.
- `src/server/services/calendar-connection.ts` has no unit test of its own, including
  `INVALID_HOURS_FALLBACK_MESSAGE` and `disconnectCalendar`'s revoke-then-RPC order.
- Nothing asserts `accessTokenFor` receives the *decrypted* token rather than the ciphertext; a mix-up
  would surface only as a decrypt failure elsewhere.
- The Disconnect dialog's close-on-success has no real coverage: the unit test only proves it starts
  closed, which the broken version also did. An interaction test needs a DOM-rendering approach that file
  does not use — the `workspace` e2e project is the natural home.
- The two early cookie-clearing branches in the OAuth callback (env resolution and session lookup failing)
  are correct by inspection but have no test forcing them.
- `connect_calendar`'s `invalid_connection` guard and `set_bookable_hours`'s 50-row cap are unexercised.

## Small code and copy debts

- `deleteEvent` repeats `request()`'s parse-and-throw block, because it must accept 404 and 410 as success
  and `request()` cannot express that. A shared `throwIfNotOk` would remove the repeat.
- `extractReason` only understands Google's classic `error.errors[].reason` shape. A gRPC-style 403 body
  would classify as `permanent` — safe (it will not falsely mark the connection broken) but imprecise.
- `set_bookable_hours` parses `p_rows` three times because PGlite has no usable temporary table. Harmless
  at ten rows; revisit if the hours ever grow.
- `cancelGoogleEvent` loads every bookable-hours row just to issue a delete.
- The OAuth callback's settings read discards its error and falls back to `America/New_York` for the app
  calendar's display zone. Cosmetic — every event carries an explicit zone.
- A non-admin who somehow reaches `/api/google/callback` gets a raw JSON 403 mid-navigation rather than a
  redirect. Unreachable in practice.
- Connecting after an explicit **Disconnect** starts a fresh calendar and leaves the old one on the
  account, empty. Reconnecting the same account, the ordinary recovery, reuses it — the two are
  deliberately different, and the RUNBOOK explains the account-switch case.

## Known, documented, and not a bug

- After switching to a different Google account, meetings booked under the previous one keep event ids the
  new token cannot reach: cancelling them logs `cancelMeeting failed` and the old event survives. The
  RUNBOOK says to delete those by hand in the old account.
- A `confirm_appointment` failure after the event exists now deletes the event best-effort and logs both
  ids, so the "orphan meeting" case from milestone 1's list is materially better than it was.
