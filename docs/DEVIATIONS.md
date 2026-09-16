# Deviations from docs/SPEC.md

Every intentional difference from the spec, with the reason. Append; never delete history.
Format: `## D<n>. Title`, then **Spec**, **Built**, **Why**.

## D1. Tests run against "localbase" instead of `supabase start`
**Spec:** §13 run against local Supabase (`supabase start`).
**Built:** The same `supabase/migrations` run in PGlite (Postgres 18 WASM), behind a PostgREST/GoTrue-compatible
HTTP emulator (`localbase/`). Tests use supabase-js with the anon key and real JWTs from `signInWithPassword`. Setting
`SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` runs the identical suite against a real stack.
**Why:** Docker, WSL and Postgres are not installed on the build machine, and installing them changes system settings.
RLS is still enforced by real Postgres (`SET LOCAL ROLE authenticated` + `request.jwt.claims`), not by the emulator.

## D2. `proxy.ts` instead of `middleware.ts`
**Spec:** §8 "Protect admin routes in middleware".
**Built:** `src/proxy.ts`, which is the same feature under its Next.js 16 name (`middleware` is deprecated).
**Why:** Next.js 16 renamed the convention.

## D3. Sensitive `calls` columns hidden by column grants
**Spec:** §5 agents SELECT calls rows for their leads.
**Built:** The RLS row policy is as specified. In addition, `authenticated` has no SELECT privilege on `user_id`,
`phone_number_id`, `provider_call_sid` or `voicemail_recording_sid`. The app reads call history, voicemails and stats
through SECURITY DEFINER RPCs that re-check access and expose caller names/caller ID to admins only.
**Why:** §5 requires "the new agent never sees who made earlier calls". A row policy cannot hide a column. Admins also
read those columns through RPCs, not direct table selects.

## D4. Schema additions
- `profiles.device_seen_at`: Twilio Device presence heartbeat, used for "if their Device is registered" (§7c).
- `calls.remote_e164`: the other party's number. Unmatched inbound voicemails need a callback number.
- `leads.dedupe_name_key`: generated business+city key for duplicate checks (§9).
- `rate_limit_hits` table + `consume_rate_limit()` RPC: DB-backed rate limits that work across serverless instances (§12).
- `calls.user_id` is nullable, but only for INBOUND admin-only voicemails (§7c "visible to admin only").

## D5. `leads.next_follow_up_at` is always derived
**Spec:** §3 agents may update next follow-up. §4 a trigger keeps it equal to the earliest open follow-up.
**Built:** Agents set the next follow-up by creating or rescheduling follow-ups. A direct write to the column is
recomputed by the trigger, so the §4 invariant can never be broken.

## D6. `log_call` also closes out due work on the lead
**Built:** Logging an outcome marks that lead's unheard voicemails as handled and completes its follow-ups that are already due.
**Why:** Otherwise §7g Next Lead would keep returning the same lead after the agent calls it ("unless a follow-up is due").

## D7. Inbound calls to numbers arrive at the TwiML App Voice URL
**Spec:** §7c numbers point to the TwiML App, whose Voice URL is `/api/twilio/voice/outbound` (§16), and inbound is handled at `/api/twilio/voice/inbound`.
**Built:** `/outbound` treats a non-`client:` caller as inbound and runs the same handler as `/inbound`. `/inbound` also works when a number is pointed at it directly.

## D8. `log_call` refuses new TEL calls on DO_NOT_CONTACT leads
**Spec:** §6 `log_call` inserts a TEL call row when no Twilio row exists. §6 "DO_NOT_CONTACT leads cannot be dialed. The server blocks it".
**Built:** When `log_call` would insert a new TEL row and the lead is DO_NOT_CONTACT, it raises `P0001 do_not_contact` (HTTP 409).
Re-logging an existing call row (same `p_call_id`, e.g. a retried WRONG_NUMBER save) and logging a pre-created in-app or
inbound row still work on a DO_NOT_CONTACT lead.
**Why:** A new TEL log means the agent dialed a lead the server must block. Idempotent retries must not break.

## D9. CSV formula-injection prefixing is stricter than listed
**Spec:** §10 prefix cells starting with `=`, `-`, `@`, tab or CR with `'`; same for `+` except validated E.164 values in the phone column.
**Built:** `src/lib/domain/csv.ts` does exactly that, and also prefixes cells starting with LF, the full-width forms
`＝ ＋ － ＠`, or any of those characters after leading spaces/NBSP (e.g. `" =cmd"`). Negative numbers such as `-5`
therefore export as `'-5`, as §10 already implies.
**Why:** Some spreadsheet imports trim leading spaces or evaluate full-width operators, which would reopen the injection.

## D10. localbase applies email changes immediately (localbase only)
**Spec:** §15 agents change their email through the Supabase flow (confirmation link).
**Built:** On real Supabase, `PUT /auth/v1/user` with a new email sends a confirmation email and the change applies after
`/auth/confirm` verifies the token. localbase has no mailer, so it applies the new email at once (and syncs
`auth.identities`, which fires `on_auth_user_email_changed`). The app code path is unchanged; only the emulator skips the email step.
**Why:** No SMTP in the Docker-free dev/test environment. Production behavior (hosted Supabase) is unaffected.

## D11. DO_NOT_CONTACT is sticky when an outcome is logged
**Spec:** §6 maps each outcome to a status, with only the no-downgrade rule for APPOINTMENT/PROPOSAL/CLIENT.
**Built:** `outcome_to_status` (SQL) and `outcomeToStatus` (`src/lib/domain/outcomes.ts`) keep a lead at DO_NOT_CONTACT whatever
outcome is logged on it (for example an answered inbound call or a pre-created in-app row). An agent or admin re-opens the lead only
by changing its status explicitly.
**Why:** With the literal mapping, logging No Answer or Voicemail on a DO_NOT_CONTACT lead would move it back to a dialable status
and put it in Next Lead again, silently undoing a compliance decision (§6 "DO_NOT_CONTACT leads cannot be dialed").

## D12. Only an admin re-opens a DO_NOT_CONTACT lead (amends D11)
**Spec:** §3 agents update the status of assigned leads. §6 "DO_NOT_CONTACT leads cannot be dialed".
**Built:** `leads_guard` refuses (`42501`) an agent's status change away from `DO_NOT_CONTACT`. Agents may still set
`DO_NOT_CONTACT`, and may still edit notes on such a lead. Admins can re-open it. D11's "an agent or admin re-opens the
lead" now reads "an admin re-opens the lead".
**Why:** DO_NOT_CONTACT set by an admin (compliance) or by a Wrong Number outcome could otherwise be undone by the agent
with one request and then dialed.

## D13. The voicemail route reads the recording SID with the service role
**Spec:** §2 the service role is used only for admin auth operations and Twilio webhooks. §5 voicemail audio never reaches
the client as a Twilio URL; `/api/voicemail/[callId]` checks access and streams server-side.
**Built:** `get_voicemail_recording(p_call_id, p_user_id)` is executable by `service_role` only and re-checks access for
`p_user_id` (active; admin, owner of the lead, or the agent of an unmatched call). The route verifies the session with
`getUser()` and passes that user id. No API role can read a recording SID (column grant plus no RPC).
**Why:** A recording SID plus the account SID (which the browser sees in its Voice access token) is a Twilio media URL. If
an authenticated RPC returned it, any browser could call that RPC directly and keep the audio after a reassignment.

## D14. Rate-limit policy is fixed in the database; outbound call creation limits itself
**Spec:** §12 rate limit the token endpoint and outbound call creation.
**Built:** `apply_rate_limit(user, bucket)` (internal, no API role) holds each bucket's limit and window: `voice_token`
20 per 10 minutes, `outbound_call` 12 per minute; unknown buckets raise `22023`. `consume_rate_limit(p_bucket)` accepts only
`voice_token` (used by `/api/voice/token`). `create_outbound_call` applies `outbound_call` itself and raises
`P0001 rate_limited` (HTTP 429), so `/api/calls/outbound` does not consume a separate hit.
**Why:** With a caller-chosen window, an agent could call the RPC with a 1-second window and prune their own hits; and a
route-only limit on outbound calls was skipped by calling `create_outbound_call` directly.

## D15. A new in-app call replaces un-started ones; a logged call no longer blocks
**Spec:** §7a "One active call per agent".
**Built:** `create_outbound_call` deletes the caller's pre-created OUTBOUND/IN_APP rows that never reached Twilio (no
provider SID, no status, no outcome) before inserting the new one, so at most one dialable row exists per agent. A call
with a live status (`queued`, `ringing`, `in-progress`, < 2 h old) blocks only while its outcome is not logged. The outbound
webhook claims a row atomically (`update … where provider_call_sid is null and call_status is null`).
**Why:** Pre-created rows have no status until Twilio calls back, so the old check never saw them and any number of rows
could be dialed at once. A lost final status callback must not lock the agent out after they logged the call.

## D16. log_call stores the TEL client id as an idempotency key, not as the row id
**Spec:** §6 `log_call` inserts a TEL call row when no Twilio row exists for the call id.
**Built:** `p_call_id` first matches a call row the caller may log. Otherwise it is the idempotency key of a TEL call on
`p_lead_id` (`calls.client_request_id`, unique per user and lead), and the new row gets a server-generated id, which
`log_call` returns. A row the caller may not log (another agent's call, or their own call on a lead that was reassigned or
deleted) is treated exactly like an unknown id. A retried save must send the same `p_lead_id` (or the returned `call_id`).
Follow-ups are created and due follow-ups completed only on the first log of a call row. In-app talk time comes only
from Twilio; a manual duration applies to TEL calls and is capped at 24 hours. API roles also cannot choose
`follow_ups.id`/`created_at` (column grants).
**Why:** A client-chosen primary key answered "does this id exist?" (duplicate key or not_found versus success), which let an
agent learn about calls and follow-ups on leads they no longer own. Retries duplicated follow-ups, and an agent could
record ten hours of talk time on a 30-second call.

## D17. Search matches phone digits only for phone-like queries
**Spec:** §8 search across business, contact, phone (digit match), email, website, city.
**Built:** `search_leads` applies the digit match only when the query consists of digits, spaces and `+-().` with at least
three digits. Text queries such as "Suite 100" match text columns only.
**Why:** Mixed text queries matched unrelated leads whose phone numbers happened to contain the same digits.

## D18. Inbound routing ignores deactivated numbers; inbound call status comes from the Dial action
**Spec:** §7c "No match, number assigned to an agent → that agent". §7a.6 status callbacks update call status.
**Built:** An unmatched caller reaches the agent only when the dialed number is **active** and assigned to them. A deactivated
number goes to admin-only voicemail. A matched lead still routes to its owner whatever number was dialed. The INBOUND row is
inserted without a `call_status`. `/inbound-dial-complete` records `DialCallStatus`/`DialCallDuration` on it through
`apply_call_status`, and a Twilio retry with the same `CallSid` reuses the row instead of logging the call twice.
**Why:** Admins deactivate a number before handing it to someone else, so stale assignments must not receive unknown callers.
An inbound row created as `ringing` could stay "live" if Twilio never reported its end. That would make the agent "busy" for
inbound routing and block `create_outbound_call` (`call_in_progress`) for up to two hours.

## D19. Browser POST routes check Origin; malformed call ids are 404
**Spec:** §12 Zod validation on every route. §1 unauthorized ids return 404 like nonexistent ones.
**Built:** `/api/voice/token`, `/api/voice/presence` and `/api/calls/outbound` answer 403 when an `Origin` header is present and is
neither `APP_BASE_URL`'s origin nor the request's own origin (CSRF defense for cookie sessions). `/api/calls/outbound` returns 400
only for an empty or non-JSON body. A JSON body that fails the schema, such as a malformed `leadId`, gets the same 404 `{error:'not_found'}` as an
inaccessible or random id. `/api/voicemail/[callId]` also answers 404 for a malformed id and for a stored recording SID that does not match `^RE[0-9a-fA-F]{32}$`.
**Why:** A distinct 400 for some ids and 404 for others is an oracle. Cookie-authenticated POSTs from other sites must not create
calls, heartbeat presence or consume rate limits.

## D20. Only a voicemail's owner marks it heard
**Spec:** §7c unheard voicemail badge; §7g Next Lead puts "unheard voicemails from own leads" first. §3 admins can do everything.
**Built:** `mark_voicemail_heard` still returns true for any voicemail the caller can access, but it sets `handled_at` only when
the caller owns it: the lead is assigned to the caller, or the call is unmatched and routed to the caller. For admins, voicemails
nobody else owns also count (admin-only unmatched calls, unassigned leads). An admin playing an agent's voicemail leaves it unheard.
The lead page passes `canMarkHeard` to the player, so the admin UI keeps showing "Unheard" and does not call the action. Logging a
call on the lead (D6) still handles its voicemails, whoever logs it.
**Why:** `handled_at` is shared. An admin reviewing call quality cleared the agent's badge and removed the callback from the top
of Next Lead before the agent ever heard it.

## D21. `log_call` bounds the follow-up time
**Spec:** §6 the Follow Up outcome asks for a date/time.
**Built:** `p_follow_up_at` must be between `now() - 1 minute` and `now() + 1825 days`, else `22023`. `logCallInputSchema` applies
the same bounds with the message "Pick a follow-up time in the future, within five years." The minute absorbs clock skew between
the device that picked the time and the server.
**Why:** A past follow-up is overdue at once, so Save & Next served the lead that was just logged again as OVERDUE. Year-9999 or
1970 rows also distorted follow-up lists and counts.

## D22. `log_call` completes follow-ups due before the end of the owner's day (amends D6)
**Spec:** §7g Next Lead order includes "follow-ups due today".
**Built:** On the first log of a call row, open follow-ups on that lead with `due_at` before the end of today are completed. "Today"
is in the lead owner's timezone, or the caller's when the lead is unassigned, computed the same way `get_next_lead` computes it.
Previously only follow-ups with `due_at <= now()` were completed. A follow-up created by the same log is inserted afterwards and
stays open. D6's "completes its follow-ups that are already due" now reads "completes its follow-ups due today or earlier".
**Why:** Next Lead serves a follow-up due later today as DUE_TODAY. Calling it left that follow-up open, so the same lead came back
as OVERDUE when its due time passed, and the prospect was called twice for a follow-up that had already been handled.

## D23. The outbound webhook checks the agent's other live calls with Twilio (amends D15)
**Spec:** §7a "One active call per agent".
**Built:** Before claiming a row, `/api/twilio/voice/outbound` looks for other calls of the same user that were created in the last 2 hours,
have a live `call_status` (`queued`, `ringing`, `in-progress`) and have a **logged outcome**. `create_outbound_call` already
refuses while a live call has no outcome. For each one it asks Twilio (`TwilioRest.fetchCallStatus`). If Twilio reports the call
still live, or the lookup fails, it returns failure TwiML. A final status is recorded with `apply_call_status` and no longer blocks.
If Twilio does not know the call, it does not block either.
**Why:** D15 lets a logged call stop blocking `create_outbound_call` so a lost status callback cannot lock the agent out. As a
result, logging an outcome while call 1 was still live (for example from devtools) allowed a second concurrent Twilio call.
Asking Twilio keeps both guarantees.

## D24. `DIALER_DRIVER=mock` is refused in production
**Spec:** §6 the mock driver is for local dev and tests.
**Built:** `parseServerEnv` rejects `DIALER_DRIVER=mock` when `NODE_ENV=production`, so the server environment is invalid and
fails loudly. Unset still falls back to `tel` in production. The e2e suite runs `next dev` and is unaffected.
**Why:** A copied dev `.env` would silently fake calls, log outcomes and talk time for calls that never happened, and replace real
voicemail audio with the test tone.

## D25. Pipeline column order, same-column drops and Do Not Contact moves
**Spec:** §8 Pipeline: NO_ANSWER and VOICEMAIL sit in TO CALL and FOLLOW_UP in CONNECTED with a badge, "Dropping a card sets that column's status", paginate per column.
**Built:** `pipeline_column(p_statuses, p_limit, p_offset, p_assigned_to, p_unassigned)` (SECURITY INVOKER, scoped exactly like `search_leads`) serves 20 cards per
column page, ordered `next_follow_up_at asc nulls last, updated_at desc, id asc`. Dropping a card on the column it already sits in writes nothing, so a No Answer,
Voicemail or Follow Up card keeps its status (and badge) inside To Call or Connected. The "Move to…" menu lists only the other columns (closed columns in a separate
group, even while hidden). To turn No Answer back into To Call, change the status on the lead page. Agents confirm before moving a card to Do Not Contact, and their Do
Not Contact cards cannot be dragged and list no targets (D12; the server still answers 403). Moves do not re-render the page: the board updates optimistically, rolls
back on any error, and "Load more" uses the number of cards shown as its offset and drops duplicates.
**Why:** The spec defines neither the order nor what a drop on the same column means. Rewriting NO_ANSWER to TO_CALL on an accidental drop would silently lose the
badge. A server refresh after each move would reset every column to its first page.

## D26. Follow-up tabs use the viewer's own day; completed follow-ups stay with their user
**Spec:** §8 Follow-ups: tabs Overdue, Today, Upcoming, Completed, Voicemails; CALL, COMPLETE and RESCHEDULE (Tomorrow 9am, In 3 days,
Next week, Custom) "all in the agent's timezone". §5 reassignment moves open follow-ups to the new owner.
**Built:** `list_follow_ups` and `follow_up_tab_counts` (SECURITY INVOKER, RLS-scoped) split Today from Upcoming at the end of today in
the **caller's** profile time zone, so an admin's Today tab uses the admin's day for every agent's rows, and the tab counts always
match the lists. Reschedule quick picks and Custom `datetime-local` values are resolved on the server in the caller's profile time
zone (`rescheduleFollowUpAction(id, { kind: 'quick' | 'custom' })`), not in the browser's zone. Only open follow-ups can be
completed or rescheduled: a completed one is `not_found` (there is no reopen), and a reschedule uses the `log_call` window (D21).
Completed follow-ups keep their `user_id` when a lead is reassigned (existing `leads_move_open_follow_ups` behavior), so after A → B
they appear in neither agent's Completed tab; admins still see them with the original owner's name.
**Why:** An admin has no single "agent timezone" when viewing the whole team, and one boundary per viewer keeps counts and lists
consistent. Server-side resolution means a device with a wrong clock zone cannot schedule in the wrong zone. A completed follow-up is
the previous agent's activity; the follow_ups RLS policy (user and lead owner must both be the caller) keeps it from the new agent.

## D27. Reports and phone numbers: which rows, what counts, and mock number verification
**Spec:** §8 Reports: per agent (dials, connect rate, talk minutes, avg call length, interested, appointments, clients), per number
(dials, answer rate), team totals, date range picker. §7d adding a number looks it up in the Twilio account and sets its voice handler.
**Built:**
- Per-agent rows (`admin_report_agents`) list every AGENT profile, disabled ones included, plus ADMIN profiles only when they made calls
  in the range. Team totals (`admin_report_totals`) are sums of those rows, with connect rate and average call length recomputed from
  the sums. Admin-only unmatched voicemails (`user_id` null) are in no row and no total.
- Connected, interested and appointments count logged outcomes in both directions (an answered callback logged as Connected counts), while
  dials are outbound only, so a connect rate above 100% is possible. Clients are leads currently assigned with status CLIENT, whatever
  the range.
- Ranges are inclusive local dates in the admin's timezone, kept in the URL (`?from=&to=`), default Last 7 days, at most 366 days. The SQL
  functions take the half-open instants and accept up to 366 days plus one hour, so a DST change inside the longest range is not refused.
- Answer rate per number = outbound dials on that number with `call_status = 'completed'` and a positive duration, divided by its dials.
  A rate under 15% over at least 20 dials shows a "Possible spam flag" hint.
- Adding a number when `DIALER_DRIVER` resolves to `mock` (development and tests only, D24) uses a clearly labeled mock lookup: no Twilio
  request, only fictional +1 NXX 555-01xx numbers are accepted, and a deterministic fake `PN…` SID is stored. When Twilio is not configured
  and the driver is not mock, adding is refused. With Twilio, a failed lookup or a failed voice handler update inserts nothing.
- Deactivating a number keeps its assignment (reactivating restores it as it was); unassigning is a separate action.
**Why:** Stats must agree with the dashboards, which use the same shared definitions. Listing disabled agents keeps their historical
calls visible after they leave. Local development has no Twilio account, and a production environment cannot be in mock mode.

## D28. Agents admin and Settings: drill-down scope, disable order, one-time passwords, audio choices
**Spec:** §8 Agents (admin): list, create, disable/reactivate, in-app calling toggle, bulk reassign, view activity. §5 "On disable, also
ban the user in Supabase Auth". §8 Settings: profile, password, daily target, call mode, audio; admin company settings and agent targets.
**Built:**
- `/admin/agents` lists AGENT profiles only (active first). Reassign targets are every active AGENT or ADMIN plus Unassigned. A banner
  lists disabled users (any role) that still have leads, with a Reassign action per user.
- `/admin/agents/[id]` exists only for AGENT profiles; admins, unknown and malformed ids get the regular 404. Ranges are Today, 7 days
  and 30 days as whole local calendar days (including today) in the **viewing admin's** timezone, served by
  `admin_agent_activity(p_user_id, p_from, p_to)` (half-open, at most 400 days). "Clients" is leads currently assigned with status
  CLIENT, not range-bound (same as D27). Talk time and outcomes include the agent's answered inbound calls; dials are outbound only.
- Disable writes `profiles.active = false` with the admin's session first, then bans in Auth (`ban_duration = '876000h'`); reactivate
  writes `active = true`, then `ban_duration = 'none'`. If the Auth call fails, the profile flag is written back and the admin sees an
  error. The ban call is repeated even when the flag already matches, so a half-finished earlier attempt heals. Admins cannot change
  their own active flag (service check plus `profiles_guard`).
- Create agent generates a 20-character random password (all four character classes), shown once in the dialog with Copy. It is
  never stored or logged. If the Auth user is created but saving the target and timezone with the admin session fails, the account is
  kept (it has the company defaults) and the dialog shows a warning instead of deleting the user.
- Change password verifies the current password with a separate non-persisting anon client (then signs that session out) before
  `auth.updateUser({ password })` on the user's own session. Length 10 to 72 (bcrypt limit). Email-change errors never say whether
  another account uses the address. On localbase the change applies immediately (D10).
- Microphone and speaker choices are saved per browser in localStorage (`fmq.audioInput`, `fmq.audioOutput`) and re-applied to the
  in-app driver whenever it becomes ready. "Test speaker" uses the driver's own test when the device is ready, else plays a generated
  0.7 s tone through `HTMLMediaElement.setSinkId` when supported. The Audio section explains itself and hides the selects when in-app
  calling is off for the user or the driver is `tel`.
**Why:** Writing the profile flag first means RLS cuts a disabled user off even if the Auth call is slow, and the rollback keeps the two
from disagreeing. Deleting an Auth user after a partial failure would be a destructive surprise. Audio devices are per machine, so a
server-side setting would be wrong on the agent's other devices.

## D29. CSV import validation extras and CSV export format
**Spec:** §9 preview shows the reason for each invalid row ("missing business name, unusable phone"); the result has a downloadable CSV
of skipped and failed rows. §10 export fields; formula-injection prefixing.
**Built:**
- Import invalid reasons are "Missing business name", "Missing phone" (phone column mapped but empty), "Unusable phone", plus length
  limits checked on both sides (business/contact name 200, raw phone 100, email 320, website 2048, address 300, city 200, state/country 100,
  source 200, notes 10,000, any cell 100,000). A too-long row is invalid instead of failing its whole batch.
- Files are limited to 200 columns besides the 10 MB / 50,000-row limits. Cells beyond the header count are kept (appended to notes as
  "Extra columns" when that toggle is on) and appear in the result CSV as "extra columns".
- The downloadable result CSV holds skipped, **invalid** and failed rows (every row that was not inserted), with the original columns and a
  `reason` column (`import reason` if the file already has `reason`). Counts inserted + skipped + invalid + failed always equal the file row
  count (`summarizeImport` throws otherwise); a planned row with no server result counts as failed.
- The server re-validates every row from its raw cells (`checkImportRow`), and an even split carries the planned total so the server fixes
  each row's agent block from its position. A batch insert error falls back to row-by-row inserts, so one bad row fails alone.
- Export is served by `export_leads` (SECURITY INVOKER, keyset-paged by `(created_at, id)`, same filters as `search_leads`) plus an explicit
  `assigned_to = caller` filter for agents. The file is UTF-8 with BOM and CRLF line endings. Status uses display labels. Dates are ISO 8601
  with the offset of the **viewer's** profile timezone (e.g. `2026-09-15T08:30:00-05:00`); the file name date is also the viewer's local date.
  The admin-only "Assigned agent" column holds the profile name (email when the name is empty), blank for unassigned leads.
**Why:** The spec's reasons are examples; an empty phone and oversized values would otherwise be rejected by the database mid-batch. Invalid
rows are data the admin needs back just as much as skipped ones ("Never drop data silently"). ISO dates with an offset stay unambiguous
in spreadsheets while matching the times the viewer sees in the app.

## D30. Review round 2: identically labelled numbers agree across screens
**Spec:** §8 Admin dashboard, Reports, Agents drill-down and Follow-ups tabs; §7d Phone Numbers; §9 import; §10 export; §11 touch targets.
**Built (these supersede the named parts of D27-D29; everything else in them stands):**
- **Agent drill-down timezone.** `/admin/agents/[id]` computes Today / 7 days / 30 days in the **target agent's** timezone, not the
  viewing admin's (supersedes that part of D28). The agents list, the admin dashboard and the agent's own dashboard already used the
  agent's day, so a single click used to change the same agent's numbers while both screens said "Today".
- **"Clients" has one meaning: leads currently assigned with status CLIENT.** The admin dashboard tile shows that number and puts
  unassigned client leads on a sub-line ("2 unassigned") instead of folding them in. `admin_team_totals` gained `clients_assigned`
  and `clients_unassigned` (`clients_total` stays), and `admin_report_agents` now also lists ADMIN profiles that currently hold CLIENT
  leads, so the Reports total equals the dashboard's assigned count (supersedes the row-set sentence in D27).
- **Team talk time floors like its rows.** `admin_team_totals` gained `talk_seconds_today`, and the dashboard tile (now labelled
  "Talk time") renders `formatTalkTime`, the helper the per-agent rows use. It previously rounded, so with the seeded data the rows
  read 22m + 10m + 0m + 0m under a tile reading 33, and any agent under a minute counted 0 in the rows and 1 in the tile.
- **The Voicemails badge counts the rows its tab lists.** `follow_up_tab_counts` gained `voicemails_total`, read from
  `list_voicemails` itself so the two can never drift; unheard still drives the red styling, the sr-only text ("12 voicemails,
  1 unheard") and the nav badge. The badge used to show unheard only, so it read 0 over a tab still holding every voicemail.
- **A number held by a disabled agent is visible.** `admin_phone_number_rows` gained `assigned_active` (the function is dropped and
  recreated, since a new column changes the return type) and the Phone Numbers page marks the assignee "Disabled agent - number
  unused". The assignment itself is still kept, so reactivating the agent restores their number (D27 unchanged).
- **The import result CSV can be imported again.** `buildSkippedRowsCsv` takes the mapping and passes the mapped phone column as a
  `phoneColumns` exception, and the import strips one leading apostrophe that escapes a formula trigger (`'+1...` -> `+1...`), so the
  "download the rows, fix them, import that file again" loop the wizard prescribes round-trips. Previously every E.164 phone came
  back as "Unusable phone" (supersedes that part of D29). An ordinary leading apostrophe ("'Tis Pizza") is untouched.
- **A malformed CSV is refused, not silently truncated.** `parseImportCsv` inspects papaparse's `errors` and refuses a file with an
  unclosed quote, naming the row. Ragged rows still import (D29 keeps cells beyond the header count).
- **Admin profile lookups are paged.** The export's owner lookup and the leads/pipeline agent filter read `profiles` in explicit
  `.range()` pages; an unpaginated PostgREST response is capped at db-max-rows with no indication, which past 1000 profiles labelled
  real leads "Unknown user" in the export and dropped agents out of the filter.
- **A partial bulk reassign says so.** When a later `reassign_leads` chunk fails, the error now states how many leads were already
  moved ("500 of 600 leads were reassigned before this failed"), because the earlier chunks have committed.
- **Touch targets.** Menu items, select options, the import Skip / Import anyway pair, the reassign status checkboxes and the
  activity range tabs moved from 44px (`min-h-11`) to 48px (`min-h-12`), per SPEC 11. Table headers are not touch targets and stay.
**Why:** Two screens showing different numbers under the same word is a correctness bug in a sales tool: the admin cannot tell which
one is true, and neither screen explains the difference. Each change picks the definition the shared stat definitions already give
("clients per agent = leads currently assigned with status CLIENT", "admin per-agent rows use each agent's own timezone") and makes
every surface use it, rather than relabelling one screen. The import fixes serve SPEC 9's "Never drop data silently": a row the app
itself wrote out must come back in, and a file the parser could not read must be refused instead of quietly losing its tail.
