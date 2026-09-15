# Funnel McQueen CRM: Build Spec

Build a production-quality, mobile-first CRM for cold-calling agents. Real app, not a mockup.

Core loop: open lead → tap CALL → call runs inside the CRM through Twilio → call ends → log outcome in 1–2 taps → NEXT LEAD.

Speed and simplicity win over features.

---

## 0. Process

1. Inspect the repo. Report what's installed. Don't overwrite working code.
2. Write a short implementation plan.
3. Build in stages. Each stage ends with typecheck, lint, and tests passing:
   1. Schema, RLS, auth, seed data, isolation tests
   2. Leads list + lead detail
   3. Call logging, Next Lead, dialer module (mock + tel:)
   4. Twilio outbound calling
   5. Twilio inbound callbacks + voicemail
   6. Dashboards + daily targets
   7. Follow-ups
   8. Pipeline
   9. CSV import/export
   10. Admin: agents, phone numbers, assignment, reports
   11. Mobile polish
   12. Full verification

The project is not done until every isolation test passes.

---

## 1. Non-negotiable: agent isolation

An agent sees only leads currently assigned to them and their own activity. To an agent, every other lead, agent, phone number, and statistic does not exist. That includes search, counts, pipeline, follow-ups, stats, exports, suggestions, call routing, voicemails, API responses, and error messages (return 404 for unauthorized IDs, same as nonexistent).

Enforce this in Postgres with RLS and in every server route. Frontend hiding does not count. Guessed IDs, edited payloads, URL changes, direct supabase-js calls from dev tools, and forged Twilio webhooks must all fail.

---

## 2. Stack

- Next.js (App Router), TypeScript strict, Tailwind, shadcn/ui
- Supabase: Postgres, Auth, RLS
- Twilio Programmable Voice: `@twilio/voice-sdk` in the browser, `twilio` Node library on the server
- Vercel
- Zod for all input validation

Server-only secrets (`import 'server-only'`): Supabase service-role key and all Twilio credentials. The service role is used only for:
- Admin auth operations (create/disable users)
- Twilio webhooks, which have no user session

Every other query runs with the user's session so RLS applies.

---

## 3. Roles

**ADMIN:** full access to everything.

**AGENT** can:
- Read and update assigned leads (status, notes, next follow-up only)
- Call assigned leads and log calls
- Receive callbacks and voicemails for their own leads and number
- Manage their own follow-ups
- View own pipeline and stats
- Export own leads
- Edit own name

**AGENT** cannot: create, delete, or reassign leads; see unassigned leads; see any other user; see or manage phone numbers; change own role, active flag, or daily target; dial a number that isn't one of their leads; access admin routes.

Public signup is disabled. Admin creates agents. Provide a documented script to promote the first admin by email, e.g. `npm run make-admin -- velo@example.com`.

---

## 4. Database

Use Postgres enums: `user_role`, `lead_status`, `call_outcome`, `call_direction`, `call_mode`.

**profiles** (1:1 with auth.users)
id, email, name, role, active, daily_call_target (default 50), timezone (default 'America/New_York'), in_app_calling_enabled (default true), created_at

**settings** (single row)
company_name, default_daily_target, default_timezone, voicemail_greeting

**leads**
id, created_at, updated_at (trigger), business_name, contact_name, phone (normalized E.164), phone_raw, email, website, website_domain (normalized, for duplicate checks), address, city, state, country, source, status (default NEW), notes, assigned_to (FK profiles, nullable = unassigned), last_contacted_at, next_follow_up_at, call_count (default 0)

**phone_numbers** (Twilio numbers)
id, e164 (unique), twilio_sid (unique), label, active, assigned_to (FK profiles, nullable = shared pool), last_used_at, created_at

**calls**
id, created_at, lead_id (nullable, for unmatched inbound only), user_id, direction (OUTBOUND | INBOUND), mode (IN_APP | TEL), phone_number_id (nullable), provider_call_sid (unique, nullable), call_status (nullable: queued, ringing, in-progress, completed, busy, no-answer, failed, canceled), outcome (nullable until logged), notes, duration_seconds (nullable), voicemail_recording_sid (nullable), voicemail_duration_seconds (nullable), handled_at (nullable)

**follow_ups**
id, lead_id, user_id, created_at, due_at, completed_at, note

Rules:
- A trigger keeps `leads.next_follow_up_at` equal to the earliest open follow-up.
- FKs to profiles use RESTRICT. Disabling an agent never deletes data.
- Admin lead deletion is a hard delete with confirmation; cascades to calls and follow-ups.

Indexes:
- leads: (assigned_to, status), (assigned_to, next_follow_up_at), (assigned_to, last_contacted_at), phone, website_domain
- pg_trgm GIN indexes on business_name, contact_name, email, website, city
- calls: (user_id, created_at), (lead_id, created_at), provider_call_sid
- follow_ups: (user_id, due_at) WHERE completed_at IS NULL
- phone_numbers: assigned_to

---

## 5. RLS

Enable RLS on every table. Deny by default.

Helper functions `is_admin()` and `is_active_user()`: SECURITY DEFINER, STABLE, `SET search_path = ''`, look up profiles by `auth.uid()`. Inactive users get zero rows on every table even with a valid JWT. On disable, also ban the user in Supabase Auth.

**profiles:** agent reads own row only, updates name only. RLS can't restrict columns, so enforce column limits with a trigger or column grants.

**leads:** agent SELECT/UPDATE where `assigned_to = auth.uid()`. A trigger rejects agent changes to any column except status, notes, next_follow_up_at. No agent INSERT or DELETE.

**calls:** agent SELECT where the lead is currently assigned to them, OR (`lead_id IS NULL` AND `user_id = auth.uid()`). Agents may set outcome and notes only, and only through the `log_call` RPC. No direct agent INSERT, UPDATE, or DELETE.

**follow_ups:** agent access where `user_id = auth.uid()` AND the lead is assigned to them. Agents cannot create follow-ups on leads they don't own.

**phone_numbers:** admin only. Agents have no access; the server resolves caller ID.

**settings:** everyone reads company_name. Admin writes.

**Admin:** full access on all tables.

Gotchas you must handle:
- Views bypass RLS unless created with `security_invoker = true`. Set it on every view.
- Every SECURITY DEFINER function checks `auth.uid()` / `is_admin()` itself.
- Dashboard counts and stats come from RLS-respecting queries or RPCs scoped to the caller.
- Voicemail audio never goes to the client as a Twilio URL. Serve it through `/api/voicemail/[callId]`, which checks access via RLS and then streams the audio from Twilio server-side.

**Reassignment** (admin only, RPC `reassign_leads(lead_ids, to_user_id)`):
- Updates assigned_to and moves open follow-ups to the new owner.
- Call history travels with the lead so the new agent has context (date, outcome, note, voicemails), but the new agent never sees who made earlier calls.
- The previous agent loses all access to the lead, including callbacks.
- Stats stay with whoever made the calls (`calls.user_id`).

---

## 6. Statuses and outcomes

Statuses: NEW, TO_CALL, NO_ANSWER, VOICEMAIL, CONNECTED, INTERESTED, FOLLOW_UP, APPOINTMENT, PROPOSAL, CLIENT, NOT_INTERESTED, DO_NOT_CONTACT

Outcome → resulting status:
- No Answer → NO_ANSWER
- Voicemail → VOICEMAIL
- Connected → CONNECTED
- Interested → INTERESTED
- Follow Up → FOLLOW_UP (prompt for a follow-up date with quick picks)
- Appointment → APPOINTMENT
- Not Interested → NOT_INTERESTED
- Wrong Number → DO_NOT_CONTACT (note auto-prefixed "Wrong number")

Never downgrade: No Answer or Voicemail on a lead at APPOINTMENT, PROPOSAL, or CLIENT keeps its current status.

"Connected" in stats = any outcome except No Answer, Voicemail, Wrong Number.

DO_NOT_CONTACT leads cannot be dialed. The server blocks it and the UI disables CALL.

**`log_call` RPC** (one transaction):
- Verify ownership (or admin).
- If a Twilio call row exists for this call (by id), set outcome and notes on it. Otherwise insert a TEL call row.
- `call_count = call_count + 1` (once per call row, never twice).
- `last_contacted_at = now()`.
- Apply status mapping.
- Optionally create a follow-up.

No read-modify-write from the client.

---

## 7. Calling

All dialing goes through a `dialer` module with three drivers:
- **twilio:** default on desktop
- **tel:** fallback
- **mock:** local dev and tests; simulates ringing, connect, and hangup with no Twilio account

`DIALER_DRIVER` env var sets the default. The UI never imports Twilio directly.

### 7a. Outbound (Twilio, in-app)

1. Agent taps CALL.
2. Client requests `POST /api/voice/token`. The server checks session, active status, and `in_app_calling_enabled`, rate-limits the request, then issues a Twilio Access Token (VoiceGrant for the TwiML App, identity = user id, TTL 1h, refresh on `tokenWillExpire`).
3. The server pre-creates a `calls` row (OUTBOUND, IN_APP, outcome null) through a server route that verifies lead ownership and returns the call id.
4. Client calls `device.connect({ params: { callId } })`. Send ONLY the call id, never a phone number or lead id the server hasn't verified.
5. Twilio hits `POST /api/twilio/voice/outbound`. The server:
   - Validates the `X-Twilio-Signature` header against `APP_BASE_URL` + path. Use the exact public URL; Vercel proxies change the host.
   - Loads the call row and its lead with the service role.
   - Confirms the Twilio identity matches `calls.user_id`, the lead is still assigned to that user, the user is active, and the lead is not DO_NOT_CONTACT.
   - Picks caller ID: the agent's assigned number, else the least recently used active pool number (update `last_used_at`).
   - Returns TwiML `<Dial callerId=... timeout="30" action="/api/twilio/voice/dial-complete"><Number statusCallback=... statusCallbackEvent="initiated ringing answered completed">{lead phone}</Number></Dial>`.
   - If any check fails, returns `<Say>` with a short error, then `<Hangup/>`. Never reveal why.
6. `POST /api/twilio/voice/status` (signature-validated) updates provider_call_sid, call_status, duration_seconds. Make it idempotent; Twilio may retry.
7. When the call disconnects, the outcome sheet opens automatically. Pre-select No Answer on busy / no-answer / failed. One tap confirms.

**In-call bar** (sticky): lead name, timer, mute, keypad (DTMF for IVRs), hang up.
- Before the first call each session, request mic permission and show a clear error if denied.
- Show Twilio Device connection warnings in plain language: "Poor connection", "Microphone not found".
- One active call per agent. CALL buttons disable during a call.
- Send `Permissions-Policy: microphone=(self)`.

### 7b. tel: fallback

Plain `<a href="tel:+1...">`. Auto mode uses tel: when:
- the device is iOS (browser calls drop when the screen locks)
- the Twilio Device fails to register
- in-app calling is disabled for the agent

When the page becomes visible again after tapping, open the outcome sheet. Duration stays manual and optional.

The agent can override the mode in Settings: Auto / Always in-app / Always phone.

### 7c. Inbound callbacks

Every Twilio number points to the TwiML App. `POST /api/twilio/voice/inbound` (signature-validated):

1. Match the caller's number to a lead by normalized phone.
2. Route:
   - Matched lead with an owner → that owner.
   - No match, number assigned to an agent → that agent.
   - Otherwise → voicemail, visible to admin only.
   If two leads share the phone, route to the owner of the most recently contacted one.
3. If the target agent is active and their Device is registered, `<Dial><Client>` to them with a 20s timeout. The incoming call UI shows business, contact, and status for their own lead, or "Unknown caller" when unmatched. Accept / Decline.
4. On no answer, decline, offline, or busy: play `settings.voicemail_greeting` with `<Say>`, then `<Record maxLength="120" playBeep="true">`. Save the recording SID on an INBOUND call row, and create a follow-up due now for the owner.
5. Log every inbound call as a calls row (INBOUND) with lead_id when matched.

Show an unread voicemail badge in navigation, scoped by RLS. Answered inbound calls open the outcome sheet like outbound ones.

Do not reveal to a caller or to any agent which agent owns another lead.

### 7d. Phone numbers (admin)

Admin page listing: number, label, assigned agent or "Pool", active, calls today, last used.

Add a number:
- Admin enters an E.164 number already purchased in Twilio.
- The server looks it up in the Twilio account (reject if not found), stores twilio_sid, and sets the number's voice handler to the TwiML App via the API.

Actions: assign, unassign (back to pool), deactivate. Do not buy or release numbers from the CRM.

### 7e. Webhook security

- Every `/api/twilio/*` route validates the signature with `TWILIO_AUTH_TOKEN` and returns 403 on failure.
- Reject requests whose AccountSid doesn't match `TWILIO_ACCOUNT_SID`.
- Webhooks never trust any value except the signed Twilio params and the database.
- Log failures without logging phone numbers in plain text.

### 7f. Env vars (server-only)

TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID, APP_BASE_URL, DIALER_DRIVER

Local dev: document running webhooks through ngrok or cloudflared, with APP_BASE_URL set to the tunnel URL and the TwiML App pointed at it.

### 7g. Next Lead

RPC `get_next_lead()`, agent's own leads only.

Exclude CLIENT, NOT_INTERESTED, DO_NOT_CONTACT, and leads called in the last 4 hours unless a follow-up is due. Order:
1. Unheard voicemails from own leads
2. Overdue follow-ups, oldest first
3. Follow-ups due today
4. NEW / TO_CALL, oldest created first
5. NO_ANSWER / VOICEMAIL, least recently contacted, then fewest calls

Include a Skip button that moves on without logging. "Save & Next" loads the next lead with CALL ready, but never auto-dials.

---

## 8. Screens

**Navigation**
- Agent: Dashboard, My Leads, Pipeline, Follow-ups, Settings
- Admin: Dashboard, All Leads, Pipeline, Follow-ups, Agents, Phone Numbers, Reports, Settings
- Mobile: bottom tab bar. Desktop: sidebar.
- Protect admin routes in middleware AND in every server action, on top of RLS.
- The Twilio Device registers once in the app shell while the agent is logged in, so callbacks ring on any page.

**Agent dashboard**
TODAY: 37 / 50 calls, 13 remaining. Connected, interested, appointments, talk time. Follow-ups due. Unheard voicemails. NEXT LEAD card (business, contact, phone, big CALL).
"Today" uses the agent's timezone. No team data anywhere.

**Admin dashboard**
Team totals: leads, calls today, connected, interested, appointments, clients, talk minutes. Per-agent rows with calls today vs target. Tap an agent to drill into their leads, calls, and stats.

**Leads list**
- Server-side pagination (25 per page). Never load all leads.
- Search debounced 300ms across business, contact, phone (digit match), email, website, city.
- Filters: status, source. Admin also: agent, unassigned.
- Sort: business, last contacted, next follow-up, call count, created.
- Keep search/filter/sort/page in the URL.
- Desktop table, mobile cards. Show business, contact, phone, location, status, last contacted, next follow-up, call count.

**Lead detail**
Business, contact, phone, email, website, location. Large CALL button, sticky at the bottom on mobile. Status dropdown, editable notes, next follow-up picker.

Call history, newest first: date, direction icon, outcome, duration, note, voicemail player.

Admin also sees: assigned agent, caller names in history, caller ID number used, reassign, delete.

**Pipeline**
- Columns: NEW, TO CALL, CONNECTED, INTERESTED, APPOINTMENT, PROPOSAL, CLIENT.
- NO_ANSWER and VOICEMAIL cards sit in TO CALL with a badge. FOLLOW_UP sits in CONNECTED with a badge.
- NOT_INTERESTED and DO_NOT_CONTACT hidden behind a "Show closed" toggle.
- Dropping a card sets that column's status.
- Paginate per column ("Load more").
- Use dnd-kit with touch support. On mobile, columns swipe horizontally and each card has a "Move to…" menu as a fallback to dragging.

**Follow-ups**
Tabs: Overdue, Today, Upcoming, Completed, Voicemails. Row: business, contact, phone, due date, note.
Actions: CALL, COMPLETE, RESCHEDULE (Tomorrow 9am, In 3 days, Next week, Custom), all in the agent's timezone.

**Agents (admin)**
Table: name, email, active, leads, calls today, talk time today, appointments today, assigned number.
Actions: create (name, email, target, timezone), disable, reactivate, toggle in-app calling, bulk reassign, view activity.
Show a warning banner when leads are still assigned to disabled agents.

**Phone Numbers (admin):** see 7d.

**Reports (admin)**
Date range picker. Per agent: dials, connect rate, talk minutes, avg call length, interested, appointments, clients. Per number: dials, answer rate (use this to spot numbers flagged as spam). Team totals. Simple tables.

**Settings**
- Agent: name, email change (Supabase flow), password, daily target (read-only), call mode, microphone/speaker selection with a test.
- Admin: company name, default target, default timezone, voicemail greeting, per-agent targets.

---

## 9. CSV import (admin)

1. Upload. Parse in browser with papaparse; insert server-side in batches of 500.
2. Mapping screen: CSV column → CRM field, auto-guess matches. Toggle: append unmapped columns to notes.
3. Preview: "100 ready · 3 possible duplicates · 2 invalid". Show the reason for each invalid row (missing business name, unusable phone).
4. Duplicates: skip or import anyway, per row or in bulk.
5. Assignment: all to one agent, even split across selected agents (e.g. 34/33/33), or leave unassigned.
6. Confirm → result summary with a downloadable CSV of skipped and failed rows.

Never drop data silently.

**Duplicate detection:** normalized phone, normalized website domain, or business name (case/punctuation-insensitive) + city. Check against the database and within the file. Warn only. Never auto-merge or delete.

---

## 10. CSV export

Server route using the user's session, so RLS scopes it. Also filter explicitly by owner for agents.

Fields: business, contact, phone, email, website, location, status, notes, last contacted, next follow-up, call count. Assigned agent column for admin only.

Prevent CSV formula injection: prefix any cell starting with `=`, `-`, `@`, tab, or CR with `'`. Same for `+`, except validated E.164 values in the phone column.

---

## 11. Design

Brand colors:
- Racing Red #E10600: primary actions, CALL, active call bar
- Gold #F4B400: sparingly (target hit, highlights)
- Charcoal #1A1A1A: base

Dark-first UI on charcoal. Premium, bold, serious sales tool.

- One strong sans typeface (Inter or Geist), heavy weights for numbers
- Touch targets ≥ 48px
- Primary action always obvious and thumb-reachable
- Skeleton loaders, transitions under 150ms
- No gradients, glows, decorative animation, oversized stat cards, or generic AI-dashboard look

---

## 12. Security checklist

- Zod validation on every server action and route
- Auth + role check inside every server action, not only middleware
- Twilio signature validation on every webhook
- Rate limit on the token endpoint and outbound call creation
- Grep the production build to confirm no Supabase service-role key or Twilio secret in client bundles
- Secrets in env vars only; provide `.env.example`

---

## 13. Tests (mandatory)

Run against local Supabase (`supabase start`) with real JWTs for seeded users, using supabase-js with the anon key, exactly as a browser attacker would. Vitest.

**Agent A cannot:**
- Read Agent B's lead by ID
- Find B's lead through search / ilike
- See B's data in counts, views, aggregates, or RPCs
- Read B's calls, notes, voicemails, or follow-ups
- Stream B's voicemail through `/api/voicemail/[callId]`
- Update or delete B's lead
- Change assigned_to on any lead, including their own
- Insert a call or follow-up on B's lead
- Create an outbound call for B's lead
- Get the outbound webhook to dial B's lead (identity mismatch)
- Dial a DO_NOT_CONTACT lead
- Read phone_numbers
- Read B's profile or any other profile
- Change own role, active flag, target, or in-app calling flag
- Export B's leads through the export route
- Call admin RPCs

**Also verify:**
- A disabled agent with a still-valid token gets zero rows and cannot get a Twilio token
- After reassignment A → B, A loses access, B gains the lead plus history, and inbound callbacks from that lead route to B
- Inbound calls from B's lead never ring A, even on a shared pool number

**Twilio webhooks** (generate valid signatures with the twilio library and a test auth token):
- Unsigned or wrong-signature requests → 403
- Wrong AccountSid → rejected
- Status callback is idempotent under retries
- Outbound TwiML contains the correct lead number and caller ID
- Inbound routing: matched lead → owner; unmatched on assigned number → that agent; otherwise → voicemail; offline agent → voicemail + follow-up created

**Admin can:** read, modify, assign, reassign, delete, manage numbers, view all stats, export all.

**Unit tests:** phone normalization, duplicate detection, outcome → status mapping (including no-downgrade), Next Lead ordering, caller ID pool rotation, `log_call` never double-counts.

**Playwright e2e** with the mock dialer:
- Mobile viewport: login → Next Lead → CALL uses tel: href → log outcome → lands on next lead.
- Desktop: CALL → in-call bar → hang up → outcome sheet → Save & Next.

---

## 14. Seed data

- 1 admin, 3 active agents, 1 disabled agent (dev passwords documented in README)
- 40 fictional leads spread across agents + 5 unassigned
- Phone numbers only in the reserved fictional range 555-0100 to 555-0199
- 3 fictional Twilio numbers: 2 assigned to agents, 1 in the pool
- Mixed statuses, call history (outbound and inbound), a couple of voicemail rows, follow-ups (some overdue)
- `samples/leads.csv` with 100 rows, including a few duplicates and invalid rows for import testing

---

## 15. Future-ready, not built

Keep all telephony behind the `dialer` module and phone handling centralized, so these can be added later:
- Call recording and AI call summaries
- SMS, WhatsApp, email
- Power dialer / auto-dial
- AI enrichment, lead scoring, automations
- Google Calendar
- Teams / workspaces
- Forwarding callbacks to an agent's mobile

Do not build any of those. Also no outbound call recording, AI voice agents, payments, invoicing, accounting, team chat, or complex permissions.

---

## 16. README must include

- Local setup
- Supabase setup
- Vercel deploy with env vars
- Twilio setup, step by step:
  - Create an API key
  - Create a TwiML App with Voice URL `{APP_BASE_URL}/api/twilio/voice/outbound`
  - Buy numbers
  - Add numbers in the CRM
  - Complete Trust Hub business profile + STIR/SHAKEN
  - Set a usage alert in Twilio
- Running webhooks locally through a tunnel
- How to switch DIALER_DRIVER

---

## 17. Definition of done

**Admin:** logs in, creates agents, adds Twilio numbers and assigns them, imports the 100-row CSV with mapping and duplicate review, splits leads across agents, sees all leads and activity including talk time, drills into one agent, reassigns leads, exports everything.

**Agent:** logs in, sees only own leads, searches, opens a lead, taps CALL and talks inside the CRM on desktop (native dialer on iPhone), hangs up and logs the outcome in 1–2 taps, receives a callback from a lead with the lead card shown, listens to a voicemail, adds a note, schedules a follow-up, moves the lead in the pipeline, sees own stats, exports own leads, hits Save & Next.

**Checks:** typecheck, lint, and all tests green, isolation and webhook tests above all.

**Final report:** what was built, how to run locally, how to deploy, env vars, and every deviation from this spec.
