# Deviations from docs/SPEC.md

Every intentional difference from the spec, with the reason. Append; never delete history.
Format: `## D<n>. Title`, then **Spec**, **Built**, **Why**.

Nothing here is ever rewritten or removed. When a later entry changes an earlier one, the earlier
entry keeps its original wording and carries a marker pointing at the entry that changed it, so the
record of what was decided when stays readable. Markers used:

- **`> SUPERSEDED BY D30`** — the sentence or bullet immediately below no longer describes the code.
  Read D30 for what is true now; the surrounding entry still stands.
- **amends / supersedes** in a title or body — that entry narrows or replaces part of an earlier one
  (D12 amends D11, D22 amends D6, D23 amends D15, D30 amends parts of D27-D29).

## Index

Grouped by theme, not by number; the entries themselves stay in numeric order below. **When you
append an entry, add a row here too** — an index that silently stops at the last person's work is
worse than no index.

**Environment and platform** — how this runs, not what it does

| | |
|---|---|
| [D1](#d1-tests-run-against-localbase-instead-of-supabase-start) | Tests run against "localbase" (PGlite + a PostgREST/GoTrue subset) instead of `supabase start` |
| [D2](#d2-proxyts-instead-of-middlewarets) | `proxy.ts` instead of `middleware.ts` (the Next.js 16 name for the same feature) |
| [D24](#d24-dialer_drivermock-is-refused-in-production) | `DIALER_DRIVER=mock` is refused in production |
| [D35](#d35-an-invalid-environment-stops-the-server-and-browser-post-routes-answer-503) | An invalid environment stops the server; browser POST routes answer 503 |
| [D38](#d38-checkbundle-fails-when-it-has-nothing-to-search-for) | `check:bundle` fails when it has nothing to search for |

**Emulator-only** — differs on localbase, identical on real Supabase

| | |
|---|---|
| [D10](#d10-localbase-applies-email-changes-immediately-localbase-only) | localbase applies email changes immediately (no SMTP in the Docker-free stack) |
| [D1](#d1-tests-run-against-localbase-instead-of-supabase-start) | (also) no embedded selects; the app uses RPCs, `security_invoker` views or two queries |

**Security** — isolation, least privilege, and closing oracles

| | |
|---|---|
| [D3](#d3-sensitive-calls-columns-hidden-by-column-grants) | Sensitive `calls` columns hidden by column grants, not just row policies |
| [D8](#d8-log_call-refuses-new-tel-calls-on-do_not_contact-leads) | `log_call` refuses new TEL calls on DO_NOT_CONTACT leads |
| [D9](#d9-csv-formula-injection-prefixing-is-stricter-than-listed) | CSV formula-injection prefixing is stricter than the spec lists |
| [D11](#d11-do_not_contact-is-sticky-when-an-outcome-is-logged) | DO_NOT_CONTACT is sticky when an outcome is logged |
| [D12](#d12-only-an-admin-re-opens-a-do_not_contact-lead-amends-d11) | Only an admin re-opens a DO_NOT_CONTACT lead (amends D11) |
| [D13](#d13-the-voicemail-route-reads-the-recording-sid-with-the-service-role) | The voicemail route reads the recording SID with the service role |
| [D14](#d14-rate-limit-policy-is-fixed-in-the-database-outbound-call-creation-limits-itself) | Rate-limit policy is fixed in the database; outbound call creation limits itself |
| [D15](#d15-a-new-in-app-call-replaces-un-started-ones-a-logged-call-no-longer-blocks) | A new in-app call replaces un-started ones; a logged call no longer blocks |
| [D16](#d16-log_call-stores-the-tel-client-id-as-an-idempotency-key-not-as-the-row-id) | `log_call` stores the TEL client id as an idempotency key, not as the row id |
| [D19](#d19-browser-post-routes-check-origin-malformed-call-ids-are-404) | Browser POST routes check `Origin`; malformed ids are 404, not 400 |
| [D20](#d20-only-a-voicemails-owner-marks-it-heard) | Only a voicemail's owner marks it heard |
| [D23](#d23-the-outbound-webhook-checks-the-agents-other-live-calls-with-twilio-amends-d15) | The outbound webhook checks the agent's other live calls with Twilio (amends D15) |
| [D31](#d31-disabling-an-agent-ends-their-auth-sessions-through-a-service-role-rpc-because-auth-has-no-admin-api-for-it) | Disabling an agent ends their Auth sessions, not just their ability to sign in |
| [D32](#d32-a-malformed-id-is-not_found-everywhere-log_call-included) | A malformed id is `not_found` everywhere, `log_call` included (completes D19) |
| [D33](#d33-voicemail-audio-is-never-synthesized-in-production) | Voicemail audio is never synthesized in production |
| [D34](#d34-the-session-cookie-is-secure-in-production) | The session cookie is `Secure` in production |
| [D36](#d36-an-export-rate-limit-bucket) | An `export` rate-limit bucket (extends D14) |

**Product decisions** — behavior the spec left open, or that had to change to stay coherent

| | |
|---|---|
| [D4](#d4-schema-additions) | Schema additions (`device_seen_at`, `remote_e164`, `dedupe_name_key`, `rate_limit_hits`) |
| [D5](#d5-leadsnext_follow_up_at-is-always-derived) | `leads.next_follow_up_at` is always derived from the earliest open follow-up |
| [D6](#d6-log_call-also-closes-out-due-work-on-the-lead) | `log_call` also closes out due work on the lead |
| [D7](#d7-inbound-calls-to-numbers-arrive-at-the-twiml-app-voice-url) | Inbound calls arrive at the TwiML App Voice URL and delegate to the inbound handler |
| [D17](#d17-search-matches-phone-digits-only-for-phone-like-queries) | Search matches phone digits only for phone-like queries |
| [D18](#d18-inbound-routing-ignores-deactivated-numbers-inbound-call-status-comes-from-the-dial-action) | Inbound routing ignores deactivated numbers; inbound status comes from the Dial action |
| [D21](#d21-log_call-bounds-the-follow-up-time) | `log_call` bounds the follow-up time |
| [D22](#d22-log_call-completes-follow-ups-due-before-the-end-of-the-owners-day-amends-d6) | `log_call` completes follow-ups due before the end of the owner's day (amends D6) |
| [D25](#d25-pipeline-column-order-same-column-drops-and-do-not-contact-moves) | Pipeline column order, same-column drops, and Do Not Contact moves |
| [D26](#d26-follow-up-tabs-use-the-viewers-own-day-completed-follow-ups-stay-with-their-user) | Follow-up tabs use the viewer's own day; completed follow-ups stay with their user |
| [D27](#d27-reports-and-phone-numbers-which-rows-what-counts-and-mock-number-verification) | Reports and phone numbers: which rows, what counts, mock number verification — *parts superseded by D30* |
| [D28](#d28-agents-admin-and-settings-drill-down-scope-disable-order-one-time-passwords-audio-choices) | Agents admin and Settings: drill-down scope, disable order, one-time passwords, audio — *parts superseded by D30* |
| [D29](#d29-csv-import-validation-extras-and-csv-export-format) | CSV import validation extras and CSV export format — *parts superseded by D30* |
| [D30](#d30-review-round-2-identically-labelled-numbers-agree-across-screens) | Review round 2: identically labelled numbers agree across screens |
| [D37](#d37-the-import-fallback-bisects-instead-of-walking-and-is-capped) | The import fallback bisects instead of walking, and is capped |
| [D39](#d39-review-round-3-hot-path-cost-the-location-column-and-a-docs-drift-guard) | Review round 3: hot-path cost, the Location column, and a docs drift guard |
| [D40](#d40-admins-can-delete-agents-who-have-no-leads-or-open-follow-ups) | Admins can delete agents who have no leads or open follow-ups |
| [D41](#d41-bulk-lead-actions-on-the-leads-list) | Bulk lead actions on the Leads list |
| [D42](#d42-a-skipped-lead-waits-in-a-skipped-queue) | A skipped lead waits in a Skipped queue instead of coming back |
| [D43](#d43-the-agent-dashboard-is-a-today-workspace-and-one-goal-module-drives-every-target-display) | The agent dashboard is a Today workspace, and one goal module drives every target display |
| [D44](#d44-pipeline-stage-navigation-and-bounded-columns) | Pipeline stage navigation and bounded columns |
| [D46](#d46-closer-calendar-booking) | Closer calendar booking |
| [D47](#d47-google-calendar-connection) | Google Calendar connection |

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
**Status:** stands, except where marked below. D30 (review round 2) changed the report row set and how "Clients" is counted.

**Built:**
> **SUPERSEDED BY D30** (row set only): `admin_report_agents` now *also* lists ADMIN profiles that currently hold CLIENT leads, so the
> Reports "Clients" total equals the admin dashboard's assigned count. The rest of this bullet is unchanged.
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
**Status:** stands, except where marked below. D30 (review round 2) changed the drill-down's timezone.

**Built:**
- `/admin/agents` lists AGENT profiles only (active first). Reassign targets are every active AGENT or ADMIN plus Unassigned. A banner
  lists disabled users (any role) that still have leads, with a Reassign action per user.
> **SUPERSEDED BY D30** (timezone only): the drill-down's Today / 7 days / 30 days are computed in the **target agent's** timezone, not
> the viewing admin's, so one click no longer changes the same agent's numbers while both screens say "Today". Everything else in the
> bullet below — which ids 404, the half-open range, the 400-day cap, the meaning of "Clients", inbound calls in talk time — is unchanged.
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
**Status:** stands, except where marked below. D30 (review round 2) made the result CSV re-importable and made a malformed file an error.

**Built:**
- Import invalid reasons are "Missing business name", "Missing phone" (phone column mapped but empty), "Unusable phone", plus length
  limits checked on both sides (business/contact name 200, raw phone 100, email 320, website 2048, address 300, city 200, state/country 100,
  source 200, notes 10,000, any cell 100,000). A too-long row is invalid instead of failing its whole batch.
- Files are limited to 200 columns besides the 10 MB / 50,000-row limits. Cells beyond the header count are kept (appended to notes as
  "Extra columns" when that toggle is on) and appear in the result CSV as "extra columns".
> **SUPERSEDED BY D30** (round-trip only): the result CSV as described below did not re-import, because formula-injection escaping turned
> every E.164 phone back into "Unusable phone". `buildSkippedRowsCsv` now takes the mapping and exempts the mapped phone column, and the
> import strips one leading escaping apostrophe. What the file *contains* is unchanged.
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

## D31. Disabling an agent ends their Auth sessions, through a service-role RPC because Auth has no admin API for it
**Spec:** §5 "Inactive users get zero rows on every table even with a valid JWT. On disable, also ban the user in
Supabase Auth." §13 "A disabled agent with a still-valid token gets zero rows and cannot get a Twilio token."
**Built:** `setAgentActive` now also revokes the account's Supabase Auth sessions, on both transitions:
- **Disable:** `profiles.active = false` (admin session) → Auth ban → revoke sessions. The ban stops new sign-ins and
  refreshes; revoking also invalidates the access token the agent's browser is holding, because GoTrue's `/auth/v1/user`
  (what `getUser()` calls in `src/proxy.ts` and `src/server/context.ts`) rejects a token whose `session_id` no longer exists.
- **Reactivate:** revoke sessions *first*, while the ban is still in place, then `active = true`, then lift the ban. So a
  cookie or refresh token issued before the disable can never be replayed; the agent signs in again.
The ban alone was not enough. `banned_until` blocks the refresh grant only while it lasts, so lifting it made every
pre-disable refresh token valid again, and `src/proxy.ts` then sent that session straight on to `/dashboard` without
re-authenticating. `tests/integration/agents/session-revocation.test.ts` is the proof: sign in, disable, both halves of
the session stop working, reactivate, the old refresh token *still* fails, a fresh sign-in works.

`@supabase/auth-js` (2.116.0) exposes no admin method for this: `auth.admin.signOut(jwt, scope)` signs out the holder of a
user access token, which an admin server disabling someone else's account never has, and `auth.admin.deleteUser` would
destroy the account and its history. Hosted Supabase Auth has no admin route that signs a user out by id either. So the
service-role-only RPC `revoke_user_sessions(p_user_id)` (`20260915001500_revoke_user_sessions.sql`) deletes the user's
`auth.sessions` rows, which is exactly what Auth's own sign-out-everywhere (`models.Logout`) does. Refresh tokens go with
their sessions (`auth.refresh_tokens.session_id` is ON DELETE CASCADE), and `/auth/v1/user` rejects an access token whose
`session_id` no longer exists. `revokeAuthSessionsWith(service, id)` in `src/server/services/agents.ts` calls it. On
localbase, `auth.sessions` is a view over `localbase.sessions` (`localbase/auth-compat.sql`, applied on every boot).

**Correction (found while reviewing D40):** the first version called `DELETE /auth/v1/admin/users/<id>/sessions`, a route
only localbase implemented. Hosted Supabase Auth has no such route (checked against the router in the supabase/auth source),
so on the live site every revoke failed: disabling an agent still cut them off but always reported an error, and
reactivating always failed and left the agent disabled. localbase no longer serves that route, and
`tests/integration/agents/session-revocation.test.ts` asserts it does not, so the emulator cannot hide a missing hosted route
this way again. Before the fix, production was checked read-only: `postgres`, which owns the app's functions, may delete
from `auth.sessions`, and the refresh-token foreign key cascades.

Failure handling, because silently not revoking is the bug this exists to fix: an RPC error is reported, not passed over.
A failed revoke on **reactivate**
aborts before the ban is lifted (the agent stays disabled, message "Their earlier sessions could not be ended…"); on
**disable** the flag and the ban are already written, so the agent is cut off either way and the admin is told to retry
("The agent was disabled, but their open sessions could not be ended."). Both are idempotent, so the retry is the fix.

**Residual, and true of Supabase generally:** PostgREST validates only a JWT's signature and expiry, so a *stolen* access
token can still read for up to its remaining hour even after revocation. Every app path calls `getUser()` first, which is
what revocation kills, and `is_active_user()` gives a disabled profile zero rows regardless.

**Why:** "Inactive users get zero rows even with a valid JWT" was satisfied only while the ban lasted. Reactivating an agent
silently resurrected every session that existed before they were disabled — including one an attacker had kept — and the
proxy's optimistic redirect sent it to `/dashboard`. A ban is a sign-in control; ending the session is the access control.

**Also in this change (test-only, no behavior):** `playwright.config.ts` gains a fourth project, `journey`, which runs
`e2e/voicemail-callback.spec.ts` after the `desktop` project. Logging that callback completes its lead's follow-ups (D22),
and `pipeline-followups.spec.ts` asserts that same follow-up is still open, so the ordering has to be declared rather than
left to file order. `import` now depends on `['mobile', 'desktop', 'journey']` so it still runs last, and it imports the
five duplicate rows instead of skipping them, which makes the seeded total 45 + 97. `docs/ARCHITECTURE.md` §10 still lists
the projects as "`mobile`, `desktop` and `import`" and needs that sentence updated; this file is the record until it is.
*(That sentence, and the matching ones in the README and `docs/PLAN.md`, were corrected in D39, which also added a test so the
three cannot drift from `playwright.config.ts` again.)*

## D32. A malformed id is `not_found` everywhere, `log_call` included
**Spec:** §1 "return 404 for unauthorized IDs, same as nonexistent". D19 already extends that to malformed ids ("A JSON body that
fails the schema, such as a malformed `leadId`, gets the same 404").
**Built:** `logCall` (`src/server/services/calls.ts`) was the one agent-facing service that answered a malformed id with
`validation` — `logCallInputSchema` declares `leadId: z.uuid({ error: "Invalid lead." })` and the body mapped the ZodError
straight through. It now routes those failures through `logCallInputError`: when **every** failing issue is a format issue on
`leadId`, `callId` or `clientRequestId`, the error is `AppError('not_found')` with the standard "Not found." message, identical to
a foreign or nonexistent id. Everything else stays `validation`: a missing `followUpAt`, a duration outside 0..86400, notes over
5000 characters, an unknown outcome, and the cross-field `superRefine` rules (`callId` together with `clientRequestId`, or
`leadId: null` with no `callId`) — those describe the caller's own form, not our rows.
**Why:** the property isolation depends on already held — a foreign id and a nonexistent one were byte-for-byte identical at both
the service and the RPC layer — so this was never an enumeration hole. What it was is an inconsistent contract: the same mistake
answered `validation` through the `logCall` action and 404 through `/api/calls/outbound`, which D19 already normalized. A client
that switches on `error.code` cannot rely on a rule with one exception, and the exception is the kind of thing that grows back.
`tests/integration/calls/calls-services.test.ts` now pins the three-way equivalence (foreign / nonexistent / malformed) for both
the lead form and the call form, so it cannot.

## D33. Voicemail audio is never synthesized in production
**Spec:** §5 voicemail with playback in the lead's history; §6 the mock driver is for local dev and tests.
**Built:** `handleVoicemail` serves the generated tone (`voicemail-tone.ts`, 8 kHz mono, 1.5 s) only when
`NODE_ENV !== 'production'`. A production deployment with Twilio not configured answers 503 `{ error: 'unavailable' }`, logs
`voicemail_unconfigured`, and the `<audio>` element shows its error state instead of playing a beep. Production **with** Twilio
configured is unchanged, and an inaccessible voicemail is still the same 404 in every mode.
**Why:** D24 refuses `DIALER_DRIVER=mock` in production precisely so the app can never fake calls or voicemail audio, but that
guard covered only the dialer. The media path had no production equivalent, and the README documents the unconfigured production
path as supported (unset `DIALER_DRIVER` resolves to `tel` there). So a real deployment could answer every voicemail with a
440 Hz tone, with nothing in the UI to say so — and because `log_call` sets `handled_at = now()` on a lead's unhandled voicemails
once the agent logs the call, a genuine customer message would be silently marked as dealt with, unheard. Fabricated data that
looks like real data is worse than an error, so the route now errors.

## D34. The session cookie is `Secure` in production
**Spec:** §2 Supabase Auth with RLS; §12 security checklist.
**Built:** `src/lib/supabase/cookie-options.ts` exports `sessionCookieOptions()`, which returns `{ secure: true }` when
`NODE_ENV === 'production'` and `{ secure: false }` otherwise. All four clients that own the session cookie pass it as
`cookieOptions`: the browser client (`lib/supabase/browser.ts`, which is what actually writes the cookie at sign-in), the Server
Component client, the route-handler client and `proxy.ts`.
**Why:** `@supabase/ssr` never sets `Secure` — its `DEFAULT_COOKIE_OPTIONS` is `path`, `sameSite`, `httpOnly` and `maxAge` only —
so the cookie, a base64 blob holding both the access token and the refresh token, was attached to any plaintext `http://` request
for the domain: a stray link, a non-preloaded subdomain, an attacker forcing http on first contact. The refresh token outlives the
access token, so that is the expensive half to lose. It stays off outside production because development and the Playwright suite
run on `http://localhost`. `httpOnly` is not available to us at all: `createBrowserSupabase` has to read the cookie from
JavaScript, which is inherent to `@supabase/ssr`'s design, and 400-day `maxAge` is left as the library sets it.

## D35. An invalid environment stops the server, and browser POST routes answer 503
**Spec:** §12 secrets in env vars only, with a `.env.example`; D24's rationale that a bad environment must fail loudly.
**Built:** two halves of the same problem.
- **Startup.** `src/instrumentation.ts` exports `register()`, Next's boot hook, which calls `getServerEnv()`. `register` runs once
  and must finish before the server accepts requests, so an invalid environment now aborts startup and prints which variables are
  wrong (names and rules only, never values). `src/server/env.ts` stays lazy — importing it still never throws, which is what
  keeps build-time imports safe — so this hook is what makes the promise real. Throwing from the hook turned out **not** to be
  enough, which was measured rather than assumed: Next 16 logs "an error occurred while loading instrumentation hook" and then
  keeps the process up, answering every request with a 500. So `register` exits the process as well (the exit is injected, so the
  unit test can assert the abort without ending the test runner). Verified against a real production build: with
  `DIALER_DRIVER=mock` the process exits and nothing ever listens on the port; with a valid environment `/login` returns 200.
  `next build` does not call the hook, so an invalid environment fails the deploy at boot, not the build.
- **Routes.** `handleVoiceToken`, `handleVoicePresence` and `handleCallsOutbound` resolve the environment through `resolveEnv`,
  inside their error handling, and answer 503 `{ error: 'unavailable' }`. `runTwilioWebhook` already did exactly this and was the
  precedent.
**Why:** README and `.env.example` both claimed that `DIALER_DRIVER=mock` with `NODE_ENV=production` stops the server. It did not.
`next start` printed "Ready", served `/login` with a 200 and redirected `/dashboard` normally; only the routes calling
`getServerEnv()` failed, with `POST /api/voice/token` returning an unhandled 500. A deployment came up green, passed any health
check that hits a page, and broke later and partially on the calling path — the exact silent degradation D24 was written to
prevent. The route half mattered on its own: because the throw preceded `isAllowedOrigin`, a cross-origin request also got a 500,
so the documented CSRF check never ran. No data was exposed either way (the request dies before any query), but a 500 carries no
code the client can act on and contradicts the response contract in ARCHITECTURE §7.

## D36. An `export` rate-limit bucket
**Spec:** §12 "Rate limit on the token endpoint and outbound call creation" — the export is not on that list.
**Built:** `apply_rate_limit` gains an `export` bucket (30 per 10 minutes, per user) and `consume_rate_limit` accepts it;
`handleLeadsExport` consumes one before streaming and answers 429 `{ error: 'rate_limited' }` when the bucket is spent.
`outbound_call` is still refused by `consume_rate_limit`, because `create_outbound_call` enforces it internally (D14).
**Why:** this is more than the spec asks for, so it is recorded here. `/api/leads/export` had no limit and pages through
`export_leads` at up to 1000 rows a page with no cap on pages, so an authenticated agent — or a stolen session — could loop it and
walk their whole book on every pass, and an admin's export covers every lead in the system. It leaks nothing (RLS and the route's
explicit `assigned_to` filter hold), so this is a cost and availability control, not an isolation one. The policy lives in SQL with
the others so it holds across serverless instances and no caller argument can shrink the window. Sign-in throttling is left to
GoTrue, which applies its own. The limit is set well above real use: the export integration suite makes 16 exports as one agent.

## D37. The import fallback bisects instead of walking, and is capped
**Spec:** §9 "Never drop data silently"; import in batches with a per-row result.
**Built:** when the bulk insert of a batch fails for a reason that is not an auth error, `importLeadsBatch` now isolates the bad
rows by halving the batch (`insertPendingByBisect`) rather than retrying all of them one at a time, and spends at most
`MAX_IMPORT_FALLBACK_REQUESTS` (64) round trips. Rows the fallback never reaches are returned as `BATCH_FAILED_REASON`, which the
wizard already treats as retryable. Auth errors still abort immediately, and per-row outcomes are unchanged for every row that is
actually attempted.
**Why:** the fallback was linear, so one row the database rejected (a dedupe collision, or a phone that passes the app's
normalization but trips the `leads` CHECK constraint) turned a single insert into up to `IMPORT_BATCH_SIZE` (500) sequential
PostgREST round trips inside one server action — 10-20 seconds at a realistic 20-40ms each, enough to exceed a serverless function
timeout. An action killed mid-loop reports the whole batch as failed even though many rows committed, which is the "silently
wrong" outcome SPEC 9 is written against. Bisecting costs O(log n) for the realistic case; the cap bounds the pathological one,
where every row fails and a pure bisect would cost more round trips than the walk it replaced.

## D38. `check:bundle` fails when it has nothing to search for
**Spec:** §12 "Grep the production build to confirm no Supabase service-role key or Twilio secret in client bundles".
**Built:** `scripts/check-bundle-secrets.ts` returns exit code 3 when the environment defines none of the secrets the build would
have used, instead of printing "(none)" and exiting 0. `--allow-missing-secrets` accepts that deliberately. A real leak is still
1 and a missing build is still 2, and the leak check runs first, so a service-role JWT is always reported as a leak whatever the
environment holds.
**Why:** the same command exited 0 whether it had searched for three secrets or for nothing, and the two runs were
indistinguishable by exit code. On this Docker-free machine, and on any fresh clone (`.env.local` is gitignored), the empty
environment is the *normal* case, so `npm run build && npm run check:bundle` could record a passing secret check that never looked
for a Twilio secret. The README warned about this in prose; prose does not fail a pipeline.

## D39. Review round 3: hot-path cost, the Location column, and a docs drift guard
**Spec:** §8 Leads list columns; §17 the definition of done.
**Built:** three fixes with no behavior change between them.
- **`get_next_lead` is set-based.** `supabase/migrations/20260915001300_review_fixes_3.sql` recomputes the two lookups — oldest
  unhandled voicemail, earliest open follow-up — as one grouped pass per child table over the caller's candidate leads, joined
  back on, instead of two correlated scalar subqueries attached to every assigned lead before any filtering or the `LIMIT 1`. A
  partial index `calls_open_voicemail_lead_idx` supports it. Same rows, same order, same reason codes: `tests/db/next-lead.test.ts`
  is unchanged and still passes. Measured on 3,000 leads / 6,000 calls in PGlite: ~100ms before, ~11ms after, against a 3ms
  control. These are relative numbers on a WASM build, not hosted-Postgres absolutes.
- **Location is a real desktop column.** `leads-table.tsx` had it behind `hidden min-[1440px]:table-cell`, so the field SPEC 8
  lists was absent at 1280px — the width this suite's own `desktop` project uses. The gate is gone, the duplicate location line
  under the business name with it.
- **The docs cannot drift from the suite.** `tests/unit/docs/docs-drift.test.ts` reads `playwright.config.ts` and
  `e2e/admin-import.spec.ts` and fails when the README, `docs/ARCHITECTURE.md` §10 or `docs/PLAN.md` names fewer projects than
  exist, miscounts them, or cites the wrong number of imported leads. That closes the note left at the end of D31.
- **A wall-clock flake in the number-report test.** `tests/db/numbers-reports.test.ts` guarded its timezone fixture with
  `expect(count(nyWindow)).not.toBe(count(kiWindow))`. The two windows are 24 hours offset by 18, so they overlap by six, and
  their counts coincide for six hours out of every twenty-four — measured at 48 of 192 quarter-hours across a 48-hour sweep. The
  suite passed at 05:57 and failed at 06:26 on the same code, because New York crossed local midnight in between. The guard now
  compares the selected sets rather than their sizes, which is both deterministic and what it meant to assert: equal counts never
  proved the two days selected the same calls. Product behavior and the two assertions either side of it are unchanged.
**Why:** `get_next_lead` runs on every agent dashboard render and every Save & Next, so it sets the felt latency of the core loop,
and its cost grew with leads-per-agent — the one query in the app where that is true. The Location gap was invisible on a large
monitor and present on an ordinary laptop, which is how it survived review. And the stale project list was not merely untidy: a
contributor reading the binding contract would have named a new spec so it matched no `testMatch`, and Playwright reports nothing
about a project that matched no files, so the spec would simply never have run.

## D40. Admins can delete agents who have no leads or open follow-ups
**Spec:** §4 "FKs to profiles use RESTRICT. Disabling an agent never deletes data." §8 lists the Agents actions as create,
disable, reactivate, toggle in-app calling, bulk reassign and view activity, with no delete.
**Built:** At the product owner's request, an admin can delete an **agent** (never an admin, never themselves) from the Agents
page, but only when that agent has **no leads assigned and no open follow-ups**. Otherwise the dialog shows the counts and hands
off to Reassign leads (or, for open follow-ups on leads the agent no longer owns, to the Follow-ups page). Deleting keeps the
profile row and its history: calls and completed follow-ups stay attributed to it, so reports keep the stats, and the name gets a
" (deleted)" suffix. Assigned phone numbers go back to the pool, and `profiles.deleted_at` is set with `active = false`
(`admin_delete_agent`, which locks the profile row so a concurrent assignment cannot slip in). A CHECK constraint keeps a deleted
profile inactive; `profiles_guard` freezes it for every caller, postgres and the service role included (no reactivation, edits or
undelete; the one change still allowed is the email that the Auth email-sync trigger copies in); and `reject_deleted_owner` triggers
stop leads, follow-ups and phone numbers from ever being assigned to it again, and stop a completed follow-up of theirs from being
reopened.

The Supabase Auth login is closed for good by the service, in three steps that can each be repeated: a new random password and a
permanent ban, then every session ended (D31), then the email moved to `deleted-<id>@deleted.invalid` so the real address can be
reused for a new agent. The security steps go first, so an email change Auth refuses never leaves the login open. The email step goes
last because it is what marks the delete finished (the profile email follows the Auth email): until it has run, the agent stays on the
Agents list with a **Delete unfinished** badge and a single **Finish deleting** action, and deleting again finishes it because the
database step is idempotent.

`admin_agent_rows` gains a `deleted` column rather than dropping those rows, so `admin_team_totals` still counts calls a deleted
agent made today, while the app hides deleted agents from every list and picker (Agents, reassign targets, settings, dashboard rows,
and the agent filter on Leads and Pipeline). Reports list a deleted agent only for a range in which they made calls, and
`admin_report_totals` counts agents the same way. A voicemail from an unknown caller that was routed to the agent can still be marked
heard, by an admin, once that agent is deleted. A reactivation that races a delete puts the permanent ban back: `setAgentActive`
re-reads the profile after lifting the ban.

**Known limit:** the database refuses to delete an admin, but an admin can still demote another admin to AGENT and then delete
them. Nothing in the UI does that; it is recorded here rather than blocked.
**Why:** Agents who leave, and accounts created by mistake, should disappear from the CRM and free their email, but deleting their
history would silently rewrite past reports, and removing an agent who still holds leads or pending follow-ups would strand that
work. Requiring the work to be reassigned first leaves nothing orphaned. The Auth user row itself is kept (anonymized and banned)
because `profiles.id` references it with ON DELETE RESTRICT, which is what protects the call history.

## D41. Bulk lead actions on the Leads list
**Spec:** §8 describes the Leads list (search, filters, sort, pagination) and single-lead actions on the lead page. It has no
selection or bulk actions; the only bulk operation is the admin "bulk reassign" of one agent's book (§8 Agents).
**Built:** Every row and card on All Leads / My Leads has a checkbox, and the table header has a page checkbox that is unchecked,
checked, or indeterminate (a dash, never color alone). While anything is selected a sticky toolbar shows the count, **Clear
selection**, **Select all N matching** (the whole filtered result, capped at 5,000), and the actions the caller may take:

| Action | Who | Backed by | Undo |
|---|---|---|---|
| Assign to an agent / Unassign | admin | `bulk_assign_leads` → `reassign_leads` (target check, open follow-ups move) | yes |
| Set status | admin, agent (own leads) | `bulk_set_lead_status` (leads_guard; an agent's Do Not Contact leads are reported as locked, D12) | yes |
| Follow-up (schedule or reschedule) | admin, agent | `bulk_schedule_follow_ups`: the lead page's picker per lead | no |
| Clear follow-ups (completes open ones) | admin, agent | `bulk_complete_follow_ups`: the Follow-ups page's Complete | no |
| Change source | admin | `bulk_set_lead_source` | no |
| Export CSV | admin, agent | `POST /api/leads/export` → `export_selected_leads` (same columns, rate limit and visibility) | — |
| Delete | admin | `bulk_delete_leads`: the lead page's hard delete (SPEC 4) | no |

Every function is SECURITY INVOKER, so RLS and the guard triggers scope a bulk action exactly like the single-lead action; the
admin-only ones also refuse agents with 42501. Results say what changed and why the rest did not ("2 already were To Call; 1
marked Do Not Contact stays as it is"). Undo reverts only leads that still hold the value the bulk action set, and leaves leads
whose previous owner can no longer take leads where they are. Delete, clearing follow-ups and an agent marking leads Do Not Contact
ask for confirmation that states the count and the effect; delete says it cannot be undone.

Selection rules: a selection belongs to the role plus the search and filters. Paging and sorting keep it (it survives a reload of the
same tab through sessionStorage); a different search or filter is a different result set, so the selection is cleared and the page
says so. A successful change clears the selection because the list re-renders with the new values; export keeps it. On All Leads an
admin sees how many leads are unassigned, one click to review them, and there one click to select them all with **Assign** first.

**Not built, because the model has no such thing:** tags, archive, and close/reopen as actions. Closing a lead is a status
(Not Interested / Do Not Contact), which the status action already covers.
**Why:** assigning imported leads one page at a time, or changing status lead by lead, was the slowest part of running the CRM.
Reusing the invoker-rights path means no bulk action can do anything the same user could not do one lead at a time.

## D42. A skipped lead waits in a Skipped queue
**Spec:** §7g "Include a Skip button that moves on without logging." The skip list lived only in the URL, so a skipped lead came back
at the next session, and nobody could see what was skipped or why.
**Built:** `lead_skips` (`20260915001700_skipped_leads.sql`) records who skipped which lead, when, an optional structured reason
(Better to call later, Needs research first, Details look wrong, Not a priority now, Other with a note) and a note. Skip opens that
reason menu; the toast offers Undo. While a skip is open, `get_next_lead` leaves the lead out whatever its bucket. A skip closes when
the lead is called (`last_contacted_at` changes), its status changes, a follow-up is scheduled or rescheduled for the skipper, it is
reassigned to someone else, or the agent resumes it. Skipping again closes the earlier skip first, so there is at most one open skip per
lead per user, and closed skips stay as history.

The queue is the **Skipped** tab on Follow-ups, next to Voicemails, oldest skip first, with **Resume calling** (back into the queue,
opened ready to call), **Follow-up** quick picks, **Status** (including Close as Not Interested), and for admins **Reassign** and
everyone's skips with the agent's name. The lead page shows an open skip with Resume, and a Skip history. The dashboard counts
skipped leads and sends the agent there when nothing else is waiting. RLS matches follow-ups: an agent sees their own skips on
leads assigned to them; an admin sees all. API roles can only read the table; writes go through `skip_lead` (owner only, others get
not_found) and `resume_skipped_lead`, and the closing triggers. If saving a skip fails, the agent still moves on with the lead left
out of that session only, as before.
**Why:** skipping without a trace made leads disappear into the same queue they were skipped from. A reason and a place to come
back to turn "skip" into a decision that can be reviewed.

## D43. The agent dashboard is a Today workspace, and one goal module drives every target display
**Spec:** §8 Agent dashboard: calls against target, connected, interested, appointments, talk time, follow-ups due, unheard
voicemails, and a Next Lead card.
**Built:** everything the spec lists, arranged around what to do next:
- **Next best action**, in this order: start or continue the call queue (with the lead, CALL, Open lead and Skip), complete overdue
  follow-ups the queue cannot offer, review skipped leads, "no leads assigned yet", or "all caught up".
- **Today's goal**: calls against the agent's own target, percent, calls to go, and copy for no calls yet, making progress, goal
  reached, and behind pace (only in the afternoon of an assumed 9:00-17:00 day in the agent's timezone, and only when under 60% of
  an even pace). The copy suggests a per-hour pace; it never compares agents, ranks, or scolds.
- **Consistency**: "Called on N of the last 7 days" with a per-day count, from `get_my_call_days`, which counts the caller's own dials
  by `calls.user_id` with get_my_dashboard's definition (RLS on calls follows the lead's current owner, so it would drop calls on
  reassigned leads). Days, not a streak, so a day off resets nothing.
- **Your numbers today** adds connect rate (connected over dials, as in Reports; "—" before the first dial).
- **Calling setup**: a notice before the agent taps CALL when in-app calling is off (calls open the phone app), not connected in this
  browser, or has no caller ID number (`my_caller_id_available`: yes/no only, the same choice as `claim_caller_id`; agents still read
  no phone numbers). Nothing changes any calling configuration.
- Agents never see unassigned leads, so the unassigned-leads prompt is an admin item. The admin dashboard stays team-focused and gains
  **Needs attention**: unassigned leads (→ Assign), no active phone numbers when the dialer is not phone-only (→ Phone Numbers), and
  skipped leads waiting (→ Skipped).

`profiles.daily_call_target` was already the only stored target, but three screens derived "remaining" and "hit" separately, and a
target of 0 read "3 / 0 calls, 0 remaining" without ever counting as reached. `dailyGoal()` (`src/lib/domain/daily-goal.ts`) is now
the one derivation used by Today, the admin dashboard rows, the Agents list and the progress bar: a target of 0 is "no target".
**Why:** the old dashboard showed numbers; agents asked what to do next. Keeping the motivation personal and non-comparative matches
how the product is used for coaching.

## D44. Pipeline stage navigation and bounded columns
**Spec:** §8 Pipeline: columns, drag to move, "Load more" per column, swipe on mobile with a Move to… fallback.
**Built:** a stage bar above the board lists every column with its count and marks the ones on screen; choosing a stage scrolls
its column into view and moves focus to its heading. Previous/next buttons page the board sideways (disabled at either end). From
768px each column has a bounded height with its cards scrolling inside, so headers and counts stay visible and a long New column
never pushes the board's sideways scrollbar off the screen; columns are 256px wide below 1280px. Drag and drop, keyboard drags and
the Move to… menu are unchanged; phones keep the swipeable, full-height columns.
**Why:** with a few hundred New leads the later stages were off screen and the only way to reach them was a scrollbar below the
longest column.

## D46. Closer calendar booking
**Spec:** §15 lists Google Calendar under "Future-ready, not built".
**Built:** agents book 30-minute meetings with a lead into one closer calendar from the lead page or the in-call bar.
The panel shows open slots inside the closer's bookable windows, plain **Busy** blocks for the rest of those windows
(D47 narrows this: busy time outside the bookable hours never reaches the browser at all), full
details only of meetings the agent booked, and the three best slots for the lead's business type phrased in the lead's
local time ("Tomorrow at 5 pm EDT"). Booking writes go through guarded SECURITY DEFINER RPCs; a unique index on live
start times makes a double booking impossible; failures abandon the pending appointment until the meeting event is created. A booking during
a call preselects Appointment; otherwise the lead moves to Appointment unless it is already further along. Business
type is set in bulk, through CSV import or corrected in the panel, and guessed from the name when blank. This release
runs on an in-memory mock calendar (`CALENDAR_DRIVER=mock`, refused in production); the Google connection is the second
milestone. Design: `docs/superpowers/specs/2026-09-17-closer-calendar-booking-design.md`.
**Why:** the closer confirms meetings personally, agents need to offer concrete times mid-call, and the closer's calendar
details are none of the agents' business.
**Not built:** texts or emails to the lead, rescheduling or cancelling by agents, reminders, several closers. States
spanning two time zones use their larger zone. Marking a meeting cancelled in the CRM leaves the Google event in place
— superseded by D47 below, which deletes the Google event on cancel once a connection exists.

## D47. Google Calendar connection
**Spec:** §15 lists Google Calendar under "Future-ready, not built". D46 shipped booking against an in-memory mock
calendar and named the real Google connection as its second milestone.
**Built:** the closer's real Google Calendar now backs booking (`CALENDAR_DRIVER=google`), through a minimal,
least-privilege OAuth connection (`docs/superpowers/specs/2026-09-18-google-calendar-connection-design.md`):

- **Four scopes, exactly, no broader grant:**

  | Scope | Permits |
  |---|---|
  | `openid`, `https://www.googleapis.com/auth/userinfo.email` | The account's email — shown in Settings, and used as the primary calendar's id for the free/busy query |
  | `https://www.googleapis.com/auth/calendar.freebusy` | `freebusy.query` only: bare busy `start`/`end` pairs per calendar, never a title, description or attendee |
  | `https://www.googleapis.com/auth/calendar.app.created` | Create a secondary calendar, and see/create/change/delete events only **on calendars the app itself created** — authorises `events.insert` and `events.delete` on that calendar, nothing on the primary one |

- **Meetings live on a calendar the app created**, never the closer's primary calendar, because `calendar.app.created`
  is the only write scope granted. The OAuth connect flow (`GET /api/google/callback`,
  `src/server/http/google-oauth.ts`) creates a secondary calendar titled "Funnel McQueen meetings" on first connect
  and stores its id in `calendar_connection.app_calendar_id` in the same write that stores the connection.
  **The calendar client (`src/server/calendar/google.ts`) never creates this calendar itself** — an intentional
  change from the design, which had the client create it lazily on first use: a `connect_calendar` rejection after
  a lazy create would have orphaned the calendar on the closer's account, and `connect_calendar` is admin-only, so a
  lazy create triggered by an agent's own booking session would just raise `forbidden`. A connection stored without
  an app calendar id — a state the connect flow itself never produces — is treated as booking-unavailable rather
  than attempted (`buildGoogleDeps`, `src/server/services/calendar-booking.ts`).
- **Bookable hours live in the CRM**, not read from a Google calendar — a change from D46's original design (its §4
  said "windows come from a bookable calendar"). `public.bookable_hours` (one row per weekday range, minutes from
  local midnight, replaced atomically by the admin-only `set_bookable_hours` RPC) replaces it, interpreted in
  `settings.default_timezone` so a window stays "10:00-12:00 local" across a daylight-saving change.
- **The meeting gets a Google Meet link, and the lead is invited as a guest** when they have an email address;
  Google sends that invitation, not the CRM (`insertEvent`, `src/server/google/api.ts`,
  `conferenceDataVersion=1&sendUpdates=all`).
- **Cancelling in the CRM deletes the Google event too** (`cancelAppointment` → `cancelMeeting`), so Google notifies
  the guest. A 404/410 from Google (already gone) counts as success; any other failure leaves the CRM row cancelled
  and logs the appointment and event ids for manual reconciliation — the calendar can be tidied by hand. This
  supersedes both D46's own "Not built" line above and the comment above `cancel_appointment` in
  `supabase/migrations/20260915001900_calendar_booking.sql` ("CRM only: the event stays in Google Calendar until
  the closer deletes it there") — that migration already ran elsewhere by the time this milestone shipped, so its
  comment could not be edited in place and is stale as of this deviation.
- **The refresh token is stored only as AES-256-GCM ciphertext** (`src/server/google/crypto.ts`,
  `calendar_connection.refresh_token_ciphertext`; no API role, admin included, may select that column — the one
  place that needs the plaintext, disconnecting to revoke it with Google, reads it with the service role). Access
  tokens are obtained per server instance and cached in memory only, never written to the database, a log, a cookie
  or the browser.
- **`unauthorized_client` from Google is a permanent error, not a revoked grant.** Only Google's `invalid_grant`
  reason marks the connection broken (`mark_calendar_broken`, which shows the reconnect banner in Settings);
  `unauthorized_client` (a bad or rotated client id/secret) is classified `permanent` instead (`classify`,
  `src/server/google/api.ts`), because sending the owner through a reconnect would not fix a client-credential
  problem — reconnecting is specifically the remedy for a revoked or expired refresh token.
**Why:** the least-privilege scopes keep milestone 1's privacy promise ("no event title, description or attendee
ever reaches an agent") by never being granted permission to read those fields at all, which is stronger than
milestone 1's server discarding what it read. Reading bookable hours from the CRM instead of a Google calendar
avoids asking the owner to maintain a second, Google-side notion of "bookable" that the app cannot validate.
Misclassifying `unauthorized_client` as a revoked grant would send the owner through a reconnect flow that can
never fix a credentials problem, and would hide the real fix (checking the variables) behind the wrong prompt.

**Not built:** several closers or per-agent calendars; rescheduling or cancelling by agents; reminders; watching
Google for changes made there (no push notifications or sync tokens, so a meeting moved or deleted directly in
Google leaves the CRM's own record in place and the slot stays blocked until it is cancelled in the CRM);
recurring meetings; anything that reads an event's title, description or guest list. **Busy time is read only from
the closer's primary calendar and the app's own calendar** (`readAvailability`, `src/server/calendar/google.ts`) —
time blocked on another secondary calendar the closer keeps (a shared family calendar, say) is invisible to the
slot engine, and an agent could book over it. Enumerating the closer's calendars would need a broader scope than
the four above allow, so the mitigation is to keep commitments on the primary calendar; the smallest fix if this
bites is a Settings field listing extra calendar ids to treat as busy.


## D48. A Google calendar per agent
**Spec:** D46 and D47 were built around one closer: the owner ran every meeting, so every booking landed in one
calendar and only an admin could cancel. The owner confirmed (2026-09-23) they do not attend these meetings —
agents close their own — which makes that shape wrong rather than merely limiting. This supersedes D47's
"Not built: several closers or per-agent calendars" and the "busy time is read from the closer's primary
calendar" paragraph above it.
**Built:** one Google account still, now hosting one secondary calendar per person. No new scopes, no per-agent
OAuth: `calendar.app.created` already permits creating secondary calendars and reading and writing events on
calendars this app created, so the one refresh token reaches every one of them.

- **`profiles.google_calendar_id`** names each person's own calendar. Null means "not provisioned", and booking
  is unavailable to that person with the ordinary "Booking isn't available right now" message
  (`buildGoogleDeps`, `src/server/services/calendar-booking.ts`). It is written only by
  `set_agent_calendar_id` and cleared only by `clear_agent_calendars`, both **service-role only** — the same
  reasoning as `mark_calendar_broken` (D47): an agent's own session must not be able to create calendars on the
  owner's account as a side effect of booking.
- **Provisioning is always admin- or server-initiated:** with the agent's account (`createAgent`, best effort —
  a failure warns and never fails the account), from the Settings card for anyone who predates the connection,
  and at connect time for the admin connecting, who is assigned the calendar created then. That last one is why
  the connect-time calendar is not left empty on the account now that meetings go elsewhere.
- **Two agents may hold the same clock time.** `appointments_live_start_key` is unique on
  `(booked_by, starts_at)` rather than `starts_at` alone, so nobody is in two meetings at once but parallel
  closers are no longer mutually exclusive. `booked_intervals` is scoped to the caller, so another agent's
  meetings neither block a picker nor appear in it, and the availability cache is keyed by owner as well as
  range so one agent is never served another's windows and busy times.
- **An agent cancels their own meeting; an admin still cancels any** (`cancel_appointment`). The Google event is
  deleted from the calendar named by the appointment's `booked_by`, not the caller's — an admin cancelling an
  agent's meeting would otherwise delete against the wrong calendar.
- **Busy time is each agent's own calendar and nothing else.** The owner's primary calendar is no longer read at
  all: they do not attend these meetings, so their dentist appointment must not block an agent. The app now
  reads none of the owner's personal calendar data, which is stronger than D47's position.
- **The agent is an attendee on every meeting**, beside the lead when the lead has an email. Google mails them
  the invitation with the Meet link, which is also how the meeting reaches their own Google Calendar and phone —
  the app never shares a calendar from the owner's account, which would need an ACL scope it does not hold.
- **Reconnecting to an account that cannot be proved to be the same one clears every stored calendar id**
  (`clear_agent_calendars`, called from the OAuth callback). Their old ids name calendars the new token cannot
  reach, and the resulting failures classify as `permanent`, so nothing would mark the connection broken and
  Settings would keep saying "Connected" while every booking failed — the D47 C1 failure, multiplied. Cleared,
  Settings shows plainly who needs a new calendar.

**Why:** separate Google accounts per agent would isolate failures better, but every agent would have to click
through Google's unverified-app consent themselves, and an unverified published app has user caps — a
verification project, for a team of a few. One account with many calendars needs no new consent from anyone and
no new scopes.

**Not built:** per-agent bookable hours (hours remain one company-wide week in the company time zone, though
`profiles.timezone` already exists if that changes) or per-agent time zones; rescheduling; reminders; agents
sharing calendars into their own Google accounts by ACL. **One broken connection still takes booking offline for
everyone**, since the connection is still a singleton — isolating that needs the per-account model above.
**Deleting an agent leaves their calendar on the account**, empty or not; `docs/RUNBOOK.md` says to remove
strays by hand, next to the account-switch case. A failure to store a calendar id after Google created it
likewise strands an empty calendar, and re-provisioning simply makes another.
