# Closer calendar booking — design

**Date:** 2026-09-17
**Status:** approved in brainstorming, awaiting spec review
**Deviation:** `docs/DEVIATIONS.md` D46 (SPEC §15 lists Google Calendar as future work). D46, not D45: D45 is taken
by the between-calls lines on the `pep-talk` branch.

## 1. Summary

Agents book 30-minute meetings with leads into **one closer's Google Calendar** while on the call. The booking
panel offers the closer's open slots, ranks the best three for **the lead's business rhythm**, and phrases them
the way an agent would say them out loud: *"Tomorrow at 5 pm"*, in the lead's local time.

Agents see open slots, full details of the meetings **they** booked, and a plain **Busy** block for everything
else. The closer sees everything natively in Google Calendar and confirms meetings with leads personally.

## 2. Goals and non-goals

**Goals**
- One connected closer calendar; bookable time defined by windows the closer draws in Google Calendar.
- Mid-call booking that lands on the closer's calendar with everything needed to follow up.
- A privacy boundary enforced on the server and covered by a test: no Google event title, description or
  attendee ever reaches an agent's browser.
- Suggested slots ranked by the lead's business type, guessed from the name and correctable.

**Non-goals (v1)**
- Automated texts or emails to the lead. The closer confirms personally.
- Rescheduling or cancelling from the CRM by agents. Reminders of any kind.
- Several closers, pooled availability, or per-agent calendars.
- Learning slot quality from meeting show-up history.
- A settings screen for booking rules (horizon and notice are constants).

## 3. Roles and visibility

| Who | Sees |
|---|---|
| Agent | Open slots; busy time as start/end only; appointments where `booked_by` = self, with lead details |
| Admin (closer) | Everything in Google Calendar; every appointment in the CRM, with the booking agent |

Appointments booked by another agent reach an agent only as anonymous busy time. An appointment stays visible
to the agent who booked it even if the lead is later reassigned (known limitation, §15).

## 4. Google connection

- **Settings → Calendar** (admin only): *Connect Google Calendar* runs the OAuth 2.0 web flow with `state`
  and PKCE. Redirect URI: `{APP_BASE_URL}/api/google/oauth/callback`. After connecting, the admin picks the
  *bookable hours* calendar from a list of their calendars.
- **Scopes:** `https://www.googleapis.com/auth/calendar.events` (read events on both calendars, create meeting
  events) and `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (list calendars for the picker).
- **Busy time** is read with `events.list` on the closer's primary calendar (`singleEvents=true`), counting
  events that are not `cancelled`, not `transparent`, and not declined by the closer. The free/busy endpoint is
  not used, so no extra scope is needed.
- **Disconnect** revokes the token at Google and clears the stored connection. **Reconnecting** replaces the row,
  which clears `broken_at`.
- **Environment (server-only):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`
  (32 bytes, base64), `CALENDAR_DRIVER` (`google` | `mock`; unset resolves to `google` when the three Google
  values are present, else `mock` outside production and *unavailable* in production). `CALENDAR_DRIVER=mock`
  with `NODE_ENV=production` is refused at startup, like the dialer (D24, D35).
- **Token lifetime gotcha:** an OAuth app in Google's *Testing* status issues refresh tokens that expire after
  7 days. Production needs either an *Internal* app (closer on Google Workspace) or a *published* app, which
  Google reviews because `calendar.events` is a sensitive scope. The README setup section must say so.

## 5. Data model

### 5.1 `calendar_connection` (singleton)
| Column | Type | Notes |
|---|---|---|
| `id` | `boolean primary key default true check (id)` | Enforces one row |
| `google_email` | `text not null` | Shown to the admin |
| `refresh_token_ciphertext` | `text not null` | AES-256-GCM, base64 of iv‖tag‖ciphertext |
| `bookable_calendar_id` | `text` | Null until the admin picks one |
| `connected_by` | `uuid not null references profiles` | |
| `connected_at` | `timestamptz not null default now()` | |
| `broken_at` | `timestamptz` | Set when Google answers `invalid_grant` |

RLS enabled with **no policies**; all privileges revoked from `anon` and `authenticated`. Only the service role
reads it. The admin reads status through a definer RPC `get_calendar_status()` → `(connected, google_email,
bookable_calendar_set, broken)`; admin only, else `42501`. Never returns the token.

### 5.2 `appointments`
| Column | Type | Notes |
|---|---|---|
| `id` | `uuid primary key default gen_random_uuid()` | |
| `lead_id` | `uuid not null references leads on delete cascade` | |
| `booked_by` | `uuid not null references profiles on delete restrict` | |
| `starts_at` | `timestamptz not null` | |
| `ends_at` | `timestamptz not null` | `check (ends_at = starts_at + interval '30 minutes')` |
| `status` | `appointment_status not null default 'pending'` | `pending` \| `scheduled` \| `cancelled` |
| `google_event_id` | `text unique` | Null while pending |
| `note` | `text` | `check (char_length(note) <= 500)` |
| `client_request_id` | `uuid not null unique` | Idempotency key per booking attempt |
| `created_at` | `timestamptz not null default now()` | |

**Unique index** `appointments_live_start_key` on `(starts_at) where status in ('pending', 'scheduled')`: every
appointment is exactly 30 minutes on a :00/:30 boundary, so this makes two live bookings of one slot impossible
at the database level, whatever the timing between two agents.

RLS select policy: `booked_by = auth.uid() or public.is_admin()`. No insert, update or delete grants to
`authenticated`. All writes go through **guarded SECURITY DEFINER RPCs** that check the caller themselves, per
the project rule that isolation lives in Postgres:

| RPC | Who | Does |
|---|---|---|
| `begin_appointment(p_lead_id, p_starts_at, p_note, p_client_request_id) → appointments` | active user who can see the lead (admin: any; agent: assigned) | Rate limit `book_appointment` (20/hour, else `P0001 rate_limited`); validates the :00/:30 boundary and note length (`22023`); returns the existing row for a replayed `client_request_id`; deletes the caller's `pending` rows older than 10 minutes; inserts `pending`, mapping a unique-index clash to `P0001 slot_taken` |
| `confirm_appointment(p_id, p_google_event_id) → appointments` | the booker, pending rows only | `pending` → `scheduled` with the event id |
| `abandon_appointment(p_id) → void` | the booker, pending rows only | Deletes the pending row |
| `cancel_appointment(p_id) → void` | admin | `scheduled` → `cancelled` (does not touch Google) |
| `booked_intervals(p_from, p_to) → table(starts_at, ends_at)` | active user | Start/end of every live appointment in range, with no lead or agent, so another agent's fresh booking disappears from the picker before Google is re-read |
| `set_lead_business_type(p_lead_id, p_type) → void` | active user who can see the lead | Sets or clears (`null`) `leads.business_type` |

### 5.3 `leads.business_type`
New enum `business_type`: `restaurant`, `cafe_bakery`, `hotel_motel`, `home_services`, `auto`, `retail`,
`beauty`, `other`. Nullable column on `leads`; null means *infer from the name*. Agents may change only status and
notes through a direct update (`leads_guard`), so corrections go through `set_lead_business_type` (§5.2).

Every new function goes into the `tests/db/grants.test.ts` EXECUTE matrix; the new FKs go into
`tests/db/schema-contract.test.ts`.

## 6. Availability

A pure function in `src/lib/domain/calendar-slots.ts`:

**Inputs:** bookable windows (events on the bookable calendar), busy intervals (§4) merged with
`booked_intervals` (§5.2), `now`, horizon
`BOOKING_HORIZON_DAYS = 14`, notice `BOOKING_NOTICE_MINUTES = 120`, closer timezone (the `connected_by`
profile's timezone when a Google calendar is connected; `settings.default_timezone` with the mock driver).

All intervals are **half-open** `[start, end)`: a slot ending at 10:00 does not overlap a window or busy block
starting at 10:00.

**All-day events:** ignored on the bookable calendar (a window needs times). On the primary calendar, an opaque
all-day event is busy from 00:00 to 24:00 of its date(s) in the closer's timezone.

**A slot is** a 30-minute interval that:
1. starts on `:00` or `:30` in the closer's timezone,
2. lies entirely inside one window (windows are merged first if they touch or overlap),
3. overlaps no busy interval,
4. starts at or after `now + 120 min` and before `now + 14 days`.

**Availability response to an agent** (`AgentAvailability`): `slots: {start, end}[]`, `busy: {start, end}[]`,
`mine: {id, start, end, leadId, businessName}[]` (from `appointments` under RLS), `leadTimeZone`,
`leadTimeZoneIsGuess`, `businessType`, `businessTypeIsGuess`, `suggestions` (§7). The type carries no field
that could hold a Google title, description or attendee.

**Caching:** Google-derived windows and busy intervals (start/end only) are cached in memory for 60 seconds per
server instance. Best effort; correctness comes from the re-check at booking (§9).

**Lead timezone:** `src/lib/domain/lead-timezone.ts` maps a US state (two-letter code or full name,
case-insensitive) to its dominant IANA zone. Country blank or `US`/`USA`/`United States` and a known state →
that zone. Anything else → the agent's timezone with `leadTimeZoneIsGuess = true`, shown as *"their time
zone unknown"*.

## 7. Business rhythm and suggestions

### 7.1 Guessing the type
`src/lib/domain/business-type.ts`. Case-insensitive, whole-word (or whole-phrase) matches on the business
name. The **first type in this order** with a match wins:

| Order | Type | Keywords |
|---|---|---|
| 1 | `hotel_motel` | hotel, motel, inn, lodge, suites, resort, hostel, bed and breakfast, b&b |
| 2 | `restaurant` | restaurant, pizzeria, pizza, grill, bistro, eatery, diner, taqueria, sushi, bbq, steakhouse, tavern, cantina, trattoria |
| 3 | `cafe_bakery` | cafe, café, coffee, bakery, creamery, ice cream, icecream, donut, doughnut, patisserie |
| 4 | `auto` | auto, automotive, tire, tires, collision, body shop, car wash, mechanic, transmission |
| 5 | `home_services` | heating, cooling, hvac, plumbing, plumber, roofing, landscaping, lawn, electric, electrical, pest, cleaning, painting, construction, contractor, remodeling, pool |
| 6 | `beauty` | salon, spa, barber, barbershop, nails, beauty, lash, brow, hair, tattoo |
| 7 | `retail` | store, shop, boutique, market, outlet, supply, mart |
| — | `other` | no match |

Fixtures from real names: *Swan Motel* → `hotel_motel`; *Maria's Pizzeria & Restaurant* → `restaurant`;
*Coco Bakery-Restaurant* → `restaurant` (order 2 beats 3); *Sea Maids Creamery* → `cafe_bakery`;
*Casa V. M. Ybor* → `other`. A stored `leads.business_type` always overrides the guess.

### 7.1a Setting types in bulk
The closer intends to categorize leads explicitly, so the stored type is the normal case and the guess is the
fallback for anything left blank.

- **CSV import:** a new optional *Business type* field in `CRM_IMPORT_FIELDS`, auto-mapped from the headers
  *Business type*, *Category*, *Industry* and *Type*. A value maps to a type when it equals a type's label
  (*Restaurant*, *Café / bakery*, *Hotel / motel*, *Home services*, *Auto*, *Retail*, *Beauty*, *Other*,
  case-insensitive) or contains one of that type's §7.1 keywords (*Pizzeria* → `restaurant`). Anything else
  imports as blank and the original value is kept in the lead's notes as `Business type: {value}`, the way
  import already preserves unmapped columns.
- **Bulk action on All Leads (admin):** *Set business type…* with the eight types plus *Guess from name*
  (clears the column). Backed by `bulk_set_business_type(p_lead_ids uuid[], p_type business_type)`, invoker,
  admin only, `null` clears, same 5,000-id cap and `too_many_leads` error as `bulk_set_lead_source` (D41).

### 7.2 Rhythm profiles (lead's local time, every day)
| Type | Avoid | Best |
|---|---|---|
| `restaurant` | 11:00–14:00, 17:00–21:00 | 14:30–16:30 |
| `cafe_bakery` | 06:30–10:30, 11:30–13:30 | 14:00–16:00 |
| `hotel_motel` | 07:00–11:00, 15:00–18:00 | 11:00–14:30 |
| `home_services` | 08:00–16:00 | 07:00–08:00, 16:30–18:00 |
| `auto` | 08:00–10:00, 16:00–18:00 | 12:30–15:00 |
| `retail` | 12:00–14:00 | 09:30–11:30 |
| `beauty` | 10:00–16:00 | 09:00–10:00, 16:00–17:30 |
| `other` | 12:00–13:00 | 10:00–11:30, 14:00–16:00 |

### 7.3 Scoring
For each slot, in the lead's timezone: **+2** if it lies entirely inside a *best* window; **−3** if it overlaps
any *avoid* window; **−1** if any part falls outside 08:00–19:00. Sort by score descending, then start ascending.
**Suggestions** are the first three slots in that order such that no two start within 60 minutes of each other.
Fewer than three is fine; none is fine (the panel then shows only *All open times*).

## 8. Phrasing

`src/lib/domain/slot-phrase.ts`, computed in the lead's timezone against `now` in the lead's timezone:

| Condition | Phrase |
|---|---|
| Same calendar date | *Today at {time}* |
| Next calendar date | *Tomorrow at {time}* |
| 2–6 days ahead | *{Weekday} at {time}* (e.g. *Thursday at 10 am*) |
| Further | *{Ddd}, {Mmm} {d} at {time}* (e.g. *Mon, Sep 29 at 11 am*) |

`{time}`: `5 pm`, `4:30 pm`, `noon` for 12:00, `midnight` for 00:00; no `:00` on the hour. In the panel the
zone abbreviation follows (*Tomorrow at 5 pm EDT*). When the agent's UTC offset differs from the lead's at that
instant, a second line reads *(6 pm your time)*.

## 9. Booking flow

**Entry points:** a **Book meeting** button in the in-call bar (during in-app calls) and on the lead page (for
`tel:` calls and bookings after hanging up). It opens a side panel; the call keeps running.

**Panel:**
1. Lead name; business type chip (*Restaurant ▾*, changing it saves `leads.business_type`); *Their time: EDT*.
2. **Best for a {type}** — up to three large buttons (§7.3, §8).
3. **All open times** — 14-day strip (days without windows disabled), then that day's slots as buttons, busy
   intervals as grey **Busy** bars, and the agent's own appointments as *Your meeting · {business}*.
4. Choosing a slot shows *Book {phrase} with {business}?*, an optional note for the closer (≤ 500 chars) and
   **Book**.

**Server action `bookAppointment({leadId, start, note, clientRequestId, inCall})`:**
1. `begin_appointment` (§5.2) — access, rate limit, boundary, idempotency, abandoned-row cleanup, and the
   pending insert; a replayed request that is already `scheduled` returns immediately.
2. Re-read windows and busy **bypassing the cache**; if the slot is no longer free, `abandon_appointment` and
   return `conflict` (*"That time was just taken"*). `slot_taken` from step 1 returns the same message.
3. Create the Google event on the primary calendar. On failure, `abandon_appointment` and return `unavailable`.
4. `confirm_appointment` with the event id.
5. If `inCall` is false, move the lead's status to Appointment through the existing status update (no call row).
   If `inCall` is true, the panel (client) dispatches a new dialer action `MEETING_BOOKED`: the live call
   remembers it, and the wrap-up that follows opens with `preselectedOutcome = 'APPOINTMENT'`, so logging the
   outcome applies the status mapping as today.

**Google event content:** title *Meeting: {business}*; description with contact name, phone (E.164 and
formatted), city/state, *Booked by {agent}*, the note, and `{APP_BASE_URL}/leads/{leadId}`; no attendees, so
Google sends nobody an invite.

**After booking:** the panel confirms *Booked: {phrase} {abbr}*; the lead page shows *Next meeting: {phrase}*
to whoever can read that appointment; admins see *Booked by {agent}* and **Mark cancelled**. Marking cancelled
only updates the CRM: the Google event, and so the busy time, stays until the closer deletes it in Google.

## 10. Error handling

| Situation | Agent sees | Admin sees |
|---|---|---|
| Not connected / no bookable calendar picked | *Booking isn't available right now — schedule a follow-up instead*, with the follow-up picker | Settings prompt to connect or pick |
| `invalid_grant` from Google | Same as above | *Reconnect Google Calendar* banner; `broken_at` set |
| Google timeout (8 s) or 5xx on load | *Couldn't load the calendar* + **Retry** | Same |
| Slot taken before booking | *That time was just taken* + refreshed slots | — |
| Google fails while creating the event | *Couldn't book — nothing was saved. Try again.* | — |
| Double submit | The first booking, once | — |

## 11. Security

- OAuth callback requires an admin session and a matching `state` cookie (HttpOnly, SameSite=Lax, 10-minute
  expiry) plus the PKCE verifier; anything else → 403 and nothing stored.
- Refresh token encrypted with AES-256-GCM under `GOOGLE_TOKEN_ENCRYPTION_KEY`; access tokens are held in
  memory only. `npm run check:bundle` gains `GOOGLE_CLIENT_SECRET` and the encryption key.
- Server responses to agents are built from the `AgentAvailability` type only; the privacy test in §13 guards it.
- Google calls happen only in `src/server/google/*` behind an injectable client, like `src/server/twilio/rest.ts`.

## 12. Mock calendar

`CALENDAR_DRIVER=mock` swaps the Google client for an in-memory calendar seeded relative to *now*: bookable
windows on weekdays 10:00–12:00 and 14:00–17:00 (closer's timezone), a few busy blocks with titles such as
*SECRET: dentist* (so the privacy test has something to leak), and created events kept in memory. Used by
`npm run dev:local`, integration tests and Playwright. Refused in production.

## 13. Testing

- **Unit:** slot engine (alignment, window merging, windows crossing midnight, notice, horizon, the
  2026-11-01 US clock change, closer/agent/lead in three different zones); business-type guessing (§7.1
  fixtures, plus whole-word matching so *Innovation Labs* ≠ `inn`, *Spain Imports* ≠ `spa`, *Pizzazz Events* ≠
  `pizza`, *Shopify Pros* ≠ `shop`); import value mapping (labels, keywords, unrecognized → blank); scoring and
  the 60-minute spread rule;
  phrasing table (§8) including *noon*, *midnight* and the second-line rule; lead timezone mapping (codes, full
  names, unknown).
- **Database:** agents select only their own appointments; admin selects all; `authenticated` (including admin)
  cannot select `calendar_connection`; `get_calendar_status` and `cancel_appointment` admin-only; `bulk_set_business_type` admin-only,
  clears with `null`, rejects more than 5,000 ids; grants matrix and schema contract updated.
- **Integration (fake Google client):** `slot_taken` when two bookings race for one start; privacy — a busy event titled *SECRET: dentist* never appears anywhere
  in an agent's serialized availability; booking race → `conflict`; Google failure at step 8 leaves no row;
  replayed `clientRequestId` → one appointment; `invalid_grant` → `broken_at` set and agents get
  *unavailable*; rate limit.
- **End to end (mock driver):** agent A opens Book meeting from a lead, takes the first suggestion, sees the
  confirmation and *Next meeting*; agent B opens the panel and sees that time as plain **Busy** with no lead
  name.

## 14. Milestones and deploy order

1. **Milestone 1 — booking on the mock calendar:** migration (tables, enum, column, RPCs, grants), slot engine,
   business type (guessing, CSV import field, bulk action), scoring, phrasing, lead timezone, mock driver,
   availability and booking services, panel UI, entry points, all tests. Shippable: production without Google shows the *not available* state.
2. **Milestone 2 — Google:** OAuth connect/disconnect, calendar picker, token encryption, Google client
   (`events.list`, `events.insert`, `calendarList.list`), `invalid_grant` handling, status banner, README setup
   section.

**Deploy:** apply the migration → create the Google Cloud project (enable Calendar API; consent screen
*Internal* on Workspace, else *External* and published; Web OAuth client with the redirect URI) → set the
environment variables → redeploy → connect in Settings → pick the bookable calendar → draw windows in it.

## 15. Known limitations

- States spanning two timezones use the dominant zone (Florida panhandle, El Paso).
- In-memory cache is per server instance.
- An appointment stays with the agent who booked it if the lead is reassigned.
- Business type guessing is keyword-based; the correction chip is the fallback.
- Cancelling in Google frees the slot immediately, but the CRM row stays *scheduled* until an admin marks it
  cancelled.

## 16. Docs to update during implementation

`docs/DEVIATIONS.md` (D46 + index row), `docs/ARCHITECTURE.md` (tables, enum, RPCs, env vars, driver rules),
`README.md` (feature bullets, *Google Calendar setup, step by step*), `.env.example` (new variables),
`docs/RUNBOOK.md` (reconnecting a broken calendar).
