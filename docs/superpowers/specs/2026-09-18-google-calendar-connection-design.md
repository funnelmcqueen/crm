# Google Calendar connection (milestone 2) — design

Milestone 1 (D46) shipped booking against an in-memory mock calendar, refused in production. This milestone
connects the closer's real Google Calendar, which is what makes booking work in production at all.

Everything in milestone 1 stays as it is: the slot engine, the ranking, the phrasing, the panel, the RPCs,
the appointments table, the privacy rule that an agent never sees why a time is busy. This design changes
only where windows and busy times come from, and what happens in Google when a meeting is booked or
cancelled.

## 1. Decisions the owner made (2026-09-18)

| Question | Ruling |
|---|---|
| Google account | A free Gmail account, not Workspace |
| Bookable hours | Set in the CRM, not read from a Google calendar (changes milestone 1's design §4) |
| Meeting contents | Google Meet link, and the lead invited as a guest |
| Lead invitation | Yes — Google emails the lead when we have an address |
| Cancelling in the CRM | Cancels the Google event too, so Google tells the guest |
| Connection broken | Agents told "booking isn't available"; the owner sees a reconnect banner in Settings |

## 2. What the owner must do in Google Cloud

The CRM cannot create these for them, and Claude never handles the values.

1. Create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen as **External**, with their Gmail as the only owner, then **publish**
   it. An app left in *testing* has its refresh tokens expired by Google after seven days, which would mean
   reconnecting every week. Published-but-unverified shows a one-time "Google hasn't verified this app"
   interstitial that the owner clicks past; with a single user this is the right trade.
3. Create an **OAuth client ID** of type *Web application* with redirect URIs
   `https://<app-domain>/api/google/callback` and `http://localhost:3000/api/google/callback`.
4. Set three environment variables (Vercel, and `.env.local` for development):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). All three are
   server-only and must never carry a `NEXT_PUBLIC_` prefix. `CALENDAR_DRIVER=google` then switches the app
   over; with the three variables set and `CALENDAR_DRIVER` unset, the driver resolves to `google`
   automatically, mirroring how `DIALER_DRIVER` resolves from the Twilio variables.

## 3. Scopes — least privilege

The privacy promise ("no event title, description or attendee ever reaches an agent") was kept in milestone
1 by the server discarding what it read. With Google it is kept by never being granted permission to read
those fields at all, which is much stronger. Verified against Google's reference on 2026-09-18:

| Scope | What it permits | Why |
|---|---|---|
| `https://www.googleapis.com/auth/calendar.freebusy` | `freebusy.query`, whose response is a list of busy `start`/`end` pairs per calendar and carries no summary, description or attendee | Read when the closer is busy |
| `https://www.googleapis.com/auth/calendar.app.created` | Create secondary calendars and see, create, change and delete events **on calendars this app created** — authorises `events.insert` and `events.delete` | Write the meetings, and nothing else |
| `openid`, `https://www.googleapis.com/auth/userinfo.email` | The account's email address | Shown in Settings, and used as the primary calendar's id in the free/busy query |

Consequences, both intended:

- Booked meetings live on a **secondary calendar the app creates** on first connect (title "Funnel McQueen
  meetings"), not on the primary calendar. It appears in Google Calendar and on the owner's phone beside
  everything else, and its id is stored in `calendar_connection.app_calendar_id`.
- The app **cannot read a single event** of the primary calendar — only its busy ranges. An agent could not
  be shown a title even by a bug.

Busy time is read from the primary calendar, addressed by the account's email (its calendar id), plus the
app calendar itself. Busy time the owner keeps on *other* secondary calendars is not seen; see §12.

If `events.insert` with a Meet conference or an attendee turns out to be refused under
`calendar.app.created`, the fallback is `https://www.googleapis.com/auth/calendar.events.owned` for writes,
keeping `calendar.freebusy` for reads, recorded in `docs/DEVIATIONS.md` with the refusal message. No
broader scope than that is acceptable.

## 4. Bookable hours in the CRM

A new admin setting replaces milestone 1's "windows come from a bookable calendar".

- Table `public.bookable_hours`: `id uuid`, `weekday smallint` (0 = Sunday … 6 = Saturday),
  `starts_minute int`, `ends_minute int` (minutes from local midnight, `0 <= starts < ends <= 1440`),
  both multiples of 30 so every generated slot keeps the "UTC multiple of 30 minutes" rule, plus a
  constraint that ranges on one weekday may not overlap. RLS on; readable by any active user (the service
  needs it), written only through a guarded RPC.
- `set_bookable_hours(p_rows jsonb)` — `security definer`, admin only, replaces the whole week atomically,
  validates weekday range, minute range, granularity, ordering and overlap, raising `invalid_hours`.
- Hours are interpreted in `settings.default_timezone` (the closer's zone), so a window is "10:00–12:00
  local" on each day and survives daylight-saving changes.
- `calendar_connection.bookable_calendar_id` is replaced by `app_calendar_id` (the secondary calendar the app created, §3) and `get_calendar_status()` returns
  `hours_set boolean` in its place; the column was never populated.

Defaults seeded with the migration: Monday–Friday, 10:00–12:00 and 14:00–17:00 — the same shape the mock
calendar used, so behaviour before and after connecting is recognisable.

## 5. Connecting

- `GET /api/google/start` — admin session required. Builds the Google consent URL with
  `access_type=offline`, `prompt=consent` (so a refresh token is always returned), PKCE, and a random
  `state` stored in an httpOnly, SameSite=Lax, short-lived cookie. Redirects to Google.
- `GET /api/google/callback` — verifies the session is still the same admin and the `state` matches the
  cookie, exchanges the code for tokens, reads the account's email address, encrypts the refresh token with
  AES-256-GCM under `GOOGLE_TOKEN_ENCRYPTION_KEY`, and stores it through
  `connect_calendar(p_email, p_ciphertext, p_app_calendar_id)` (definer, admin only, upserts the singleton and clears
  `broken_at`). Redirects back to Settings with a success or failure flag. Any error state from Google
  (`access_denied`, a mismatched state, a missing refresh token) lands on Settings with a plain message and
  writes nothing.
- `disconnect_calendar()` (definer, admin only) deletes the row. The app also calls Google's token
  revocation endpoint, best effort; a failure there does not block disconnecting.
- Access tokens are obtained from the refresh token per server instance, cached in memory with their
  expiry, and never written to the database, a log, a cookie or the browser.

## 6. Availability with Google

`GoogleCalendarClient` implements the existing `CalendarClient` interface, so the service, slot engine and
panel do not change.

- `readAvailability({ from, to })` builds the windows from `bookable_hours` in the closer's time zone for
  every day in the range, and gets busy times from Google's **free/busy** query for the same range, which
  returns start/end pairs and nothing else. Both go back as bare intervals.
- The existing 60-second availability cache stands, so one panel open is one free/busy call.
- Every Google call gets an 8-second timeout (design §10 of milestone 1 promised this and the interface had
  none) and one retry on a connection error only.
- `booked_intervals` from the CRM is still merged in, so an appointment that Google has not caught up with
  still blocks its slot.

## 7. Creating and cancelling the meeting

- `createMeeting` inserts an event: title and description from `meeting-description.ts` as today, start/end
  in the closer's zone, a **Google Meet** conference (request id derived from the booking's
  `client_request_id`, so a retry cannot create two conferences), and the lead as an **attendee** when the
  lead has an email address, with Google sending the invitation. It returns the event id, which
  `confirm_appointment` already stores.
- Cancelling: `cancelAppointment` marks the row cancelled as it does now, then deletes the Google event and
  lets Google notify the guest. A `404`/`410` from Google (already gone) counts as success. If the delete
  fails for any other reason the CRM row stays cancelled and the failure is logged with the appointment and
  event ids — the calendar can be tidied by hand, and the agent-facing behaviour does not change.
- Nothing watches Google for changes made there. If the owner moves or deletes an event in Google, the CRM
  keeps its own record; the slot stays blocked until the appointment is cancelled in the CRM. This is
  explicit in the deviation entry.

## 8. When it breaks

| Failure | What the agent sees | What the CRM does |
|---|---|---|
| `invalid_grant` (access revoked, password change, token expired) | "Booking isn't available right now." | `mark_calendar_broken()` sets `broken_at`; Settings shows a reconnect banner |
| Timeout, 5xx, quota (`rateLimitExceeded`) | "Booking isn't available right now." (or, mid-booking, "Couldn't book the meeting.") | Logged with a code; nothing marked broken, since it is transient |
| Not connected at all | Same message | Settings shows "Not connected" with the Connect button |

A booking that fails after the event exists already logs the appointment and event ids (milestone 1's final
fix); that log is what the owner reconciles against.

## 9. Settings page

One new admin card, above the company settings:

- **Connection**: status (Connected as `name@gmail.com` / Not connected / Reconnect needed, with when it
  broke), a Connect / Reconnect button, and Disconnect with a confirmation. Never renders a token.
- **Bookable hours**: one row per weekday with its ranges, add and remove a range, times on the half hour,
  shown in the company time zone with the zone named. Saving validates the same rules the RPC enforces and
  reports the RPC's message on failure.

## 10. Testing

- No test ever reaches the network. Google's HTTP surface is stubbed at the fetch layer with recorded
  shapes (token exchange, free/busy, event insert, event delete, and the error bodies for `invalid_grant`,
  a 500 and a quota error).
- Unit: hours → windows including a daylight-saving weekend and a week with no hours set; encryption round
  trip and rejection of a wrong key; Google error classification; free/busy response mapping.
- Database: `bookable_hours` RLS and grants; `set_bookable_hours` validation and atomic replacement;
  `connect_calendar` / `disconnect_calendar` admin-only and `mark_calendar_broken` service-role only (the
  implementation narrowed it: an agent able to call it could take booking offline for everyone); `get_calendar_status`
  still never returns the token.
- Integration: availability and booking through the stubbed Google client, including the invited guest, the
  Meet link, a cancel that deletes the event, and `invalid_grant` marking the connection broken.
- End to end stays on the mock driver, plus one spec for the Settings card with the connection absent.
- `CALENDAR_DRIVER=mock` in production stays refused.

## 11. Documentation

`docs/DEVIATIONS.md` gains **D47. Google Calendar connection** (D45 belongs to the pep-talk branch, D46 to
milestone 1), covering the scopes actually used, hours living in the CRM, the Meet link and the invited
guest, cancellation reaching Google, and what is deliberately not built. `README.md` gains the Google setup
steps from §2 and the new variables in its environment table; `docs/ARCHITECTURE.md` gains the new tables,
RPCs and driver resolution; `docs/RUNBOOK.md` gains "the calendar connection broke" with the reconnect
steps.

## 12. Not built

Several closers or per-agent calendars; rescheduling or cancelling by agents; reminders; watching Google
for changes made there (no push notifications or sync tokens); recurring meetings; anything that reads an
event's title, description or guest list.

Busy time is read from the owner's primary calendar and the app's own calendar only. Time blocked on
another secondary calendar they keep (a shared family calendar, say) is invisible to the slot engine, and
an agent could book over it. Enumerating their calendars would need a broader scope than §3 allows, so the
answer is to keep commitments on the primary calendar. If this bites, the smallest fix is a Settings field
listing extra calendar ids to treat as busy.
