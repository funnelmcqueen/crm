# Funnel McQueen CRM: Runbook

Day-2 operations. Setup lives in [`README.md`](../README.md); this file is what you reach for when
something is already running and needs to change or has gone wrong.

Rule of thumb for everything below: **the database is the authority.** If the UI and the database
disagree, the database is right and the UI has a bug. Never "fix" an isolation problem by hiding
something in the UI.

---

## Access and accounts

### Add an agent

Admin → Agents → Create. Name, email, daily target, timezone. A 20-character one-time password is
shown once in the dialog with a Copy button; it is never stored or logged. If you lose it before
the agent signs in, disable the account and create a new one, or have them use the Supabase password
reset flow.

### Disable an agent (they left, or a device was lost)

Admin → Agents → the row's menu → Disable. This writes `profiles.active = false` with the admin's
session **first**, then bans the user in Supabase Auth. That order matters: RLS cuts the user off
the moment the flag flips, even if the Auth call is slow. If the Auth call fails, the flag is
written back and you see an error — retry, because a half-finished attempt heals on the next try.

A disabled agent with a still-valid JWT gets zero rows on every table and cannot get a Twilio token.
Their data is not deleted; foreign keys to `profiles` are `RESTRICT` on purpose.

**Then reassign their leads.** The Agents page shows a banner listing disabled users who still hold
leads, with a Reassign action. Until you do this, those leads are invisible to everyone but admins,
and inbound calls from them go to admin-only voicemail.

### Promote an admin from the command line

```bash
npm run make-admin -- someone@example.com
```

Works on an existing user, and lifts a sign-in ban if one is in place. Add `--create` to create the
account first (prints a temporary password once). Needs `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, which it reads from `.env.local`.

This is the break-glass path when nobody can sign in as an admin. It is the only way to create the
first admin, because public signup is disabled.

---

## Telephony

### A number is being flagged as spam

Symptom: Admin → Reports → per-number table shows an answer rate under ~15% over at least 20 dials.
The page marks this as a "Possible spam flag" hint.

1. Check Trust Hub first. An unsigned number will keep getting labelled no matter how you rotate.
   Console → Account → Trust Hub: the business profile must be approved and the number assigned to
   both it and the SHAKEN/STIR trust product (README, Twilio step 7).
2. Deactivate the number in the CRM (Admin → Phone Numbers → Deactivate). It leaves both the
   outbound caller-ID rotation and inbound routing immediately, but keeps its assignment, so
   reactivating restores exactly what it was.
3. Buy a replacement, add it in the CRM, assign it to the same agent.
4. Consider whether call volume per number is the real cause. One number carrying a whole team's
   dials is the usual reason a pool number burns out.

### Rotate the Twilio auth token

The auth token validates every incoming webhook. Rotating it breaks every webhook until the
deployment has the new value.

1. Create the new token in the Twilio Console (both are valid during the overlap).
2. Update `TWILIO_AUTH_TOKEN` in Vercel → Project Settings → Environment Variables.
3. Redeploy. Environment changes do not reach running instances.
4. Place one outbound and one inbound test call.
5. Only then promote the new token and retire the old one in Twilio.

Rotating the **API key** (`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`) is lower risk: create a
new Standard key, update both variables, redeploy, verify a call connects and a voicemail plays,
then delete the old key.

### Every webhook returns 403

`APP_BASE_URL` does not match the URL Twilio is calling, character for character. Compare scheme,
host, port and trailing slash. Check the TwiML App's Voice Request URL and Status Callback URL in
the Console against the deployed origin. Restart or redeploy after changing `APP_BASE_URL` — it is
read and cached at startup.

This is by far the most common Twilio problem, and it is silent by design: the 403 never explains
itself, because explaining it to an attacker would be worse.

### Calls will not connect at all

Work down this list:

1. Is `DIALER_DRIVER` set to `twilio`, and are all five `TWILIO_*` variables present? A missing one
   makes the environment invalid and the server says which.
2. Does the agent have `in_app_calling_enabled`? Admin → Agents shows it; the token endpoint
   refuses without it.
3. Is the agent active? An inactive agent gets no token.
4. Has the agent hit the rate limit (20 tokens per 10 minutes, 12 outbound calls per minute)? They
   see a 429; the limit is per user and clears on its own.
5. Is there an active number to use as caller ID? No assigned number and an empty pool produces
   failure TwiML with no explanation.
6. Check Twilio's own call logs in the Console. If Twilio never received the call, the problem is
   on the browser side (microphone permission, Device registration); if it did, the TwiML response
   tells you which check failed.

### Spend spike

Twilio's usage triggers (README, Twilio step 8) should catch this first. When one fires:

1. Console → Monitor → Logs → Calls, sorted by time. Look for one identity making many calls.
2. Admin → Reports with a tight date range shows the same thing per agent and per number.
3. If it is a compromised session rather than a busy day: disable the agent (cuts them off at RLS
   immediately), then rotate the auth token and API key.
4. The rate limits cap the damage at 12 outbound calls per minute per user, by design.

---

## Calendar

### The calendar connection broke

Symptom: an agent tries to book a meeting and sees "Booking isn't available right now. Schedule a
follow-up instead." Admin → Settings → Google Calendar shows a red banner — "The connection to Google
broke. Reconnect to keep booking meetings." — instead of "Connected as name@gmail.com".

This happens when Google revokes the refresh token: the owner changed their Google password, removed the
app's access from their Google Account, or (the usual cause) the OAuth consent screen was left in
*Testing* and Google expired the token after seven days (README, Google Calendar setup, step 2). The
server only learns this the next time it tries to read availability or book a meeting — Google returns
`invalid_grant`, `mark_calendar_broken()` sets `calendar_connection.broken_at`, and every agent sees
booking as unavailable until it is fixed. A timeout, a 5xx or a Google rate limit is logged but does
**not** set `broken_at` — that is treated as transient, not a revoked grant, and clears itself on the next
successful call.

**Fix:** Admin → Settings → Google Calendar → **Reconnect**, sign in as the same Gmail account, and
approve the consent screen again.

If Google refuses to complete the reconnect (an error page from Google, or Settings shows the toast
"Couldn't connect Google Calendar. Try again." after redirecting back):

1. Check all three variables are set and match what is in Google Cloud Console: `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`. A client secret rotated in the Console without
   updating `GOOGLE_CLIENT_SECRET` here looks the same from the outside (Google reports
   `unauthorized_client`), but the server does **not** treat that as a revoked grant — reconnecting will
   not fix a wrong client secret; update the variable and redeploy instead.
2. Confirm the OAuth consent screen is **Published**, not stuck in Testing (README, Google Calendar
   setup, step 2).
3. Confirm both redirect URIs are still registered on the OAuth client, the deployed one included
   (`https://<app-domain>/api/google/callback`).

### Settings says Connected, but booking is unavailable and nothing is marked broken

Symptom: Admin → Settings → Google Calendar shows "Connected as name@gmail.com" with no red banner, but
every agent sees "Booking isn't available right now." and `get_calendar_status` reports `broken: false`.

Check `GOOGLE_TOKEN_ENCRYPTION_KEY`. This happens when the stored refresh token can no longer be
decrypted with the key currently deployed — it was rotated, differs between environments, or is missing or
malformed. A decrypt failure is treated the same as a revoked grant (it marks the connection broken too),
so seeing this symptom on an up-to-date deploy most likely means the key itself changed out from under an
otherwise-working connection.

**Fix:** restore the correct `GOOGLE_TOKEN_ENCRYPTION_KEY`, or, if it was rotated on purpose, Admin →
Settings → Google Calendar → **Reconnect** — this re-encrypts the refresh token under whichever key is
current.

---

## Data

### Reassign leads

Admin → Agents → Reassign (bulk, filtered by status), or Admin → Leads for a single lead. Behind it
is the `reassign_leads` RPC, in one transaction:

- `assigned_to` changes, and open follow-ups move to the new owner.
- Call history travels with the lead, so the new agent has context — but never sees who made the
  earlier calls (column grants, D3).
- Completed follow-ups keep their original owner; they are the previous agent's activity (D26).
- The previous agent loses **all** access immediately, including inbound callbacks from that lead.
- Stats stay with whoever made the calls (`calls.user_id`), so reports do not rewrite history.

A bulk reassign runs in chunks. If a later chunk fails, the error says how many leads had already
moved, because the earlier chunks are committed (D30). Re-run with the remainder.

### Import a lead list

Admin → Leads → Import. Upload, map columns, review the preview (ready / possible duplicates /
invalid, with a reason per invalid row), choose assignment (one agent, an even split, or leave
unassigned), confirm.

Nothing is dropped silently. The result screen offers a CSV of every row that was not inserted —
skipped, invalid and failed — with the original columns plus a `reason` column. Fix those rows in
that file and import it again; it is built to round-trip (D30).

Duplicate detection (normalized phone, normalized website domain, or business name + city) only
ever warns. It never merges or deletes.

### Restore or roll back

There is no delete-safety net in the app: an admin lead deletion is a hard delete, confirmed in the
dialog, and it cascades to that lead's calls and follow-ups. Recovery means a database restore.

- Hosted Supabase: Dashboard → Database → Backups. Know your project's retention before you need it.
- Restore to a new project, verify, then repoint `NEXT_PUBLIC_SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` and redeploy.

---

## Schema changes

1. Add a new timestamped file to `supabase/migrations/`. Never edit an applied migration — localbase
   tracks what it has run in `localbase.schema_migrations` and will not re-run it, and `supabase db
   push` will not either.
2. Every function sets `search_path = ''` and fully qualifies names. Every new function must be
   added to the EXECUTE matrix in `tests/db/grants.test.ts`, and revoked from `public` and `anon`.
3. Every new table must enable RLS. Supabase grants tables to `authenticated` by default, so a table
   without RLS is a table everyone can read.
4. `npm run db:types`, commit the regenerated `src/lib/database.types.ts` with the migration.
5. `npm run verify`. Locally, `npm run localbase:reset` to re-apply from scratch, then
   `npm run db:seed`.
6. Deploy the migration before the code that depends on it.

---

## Release checklist

```bash
npm run verify          # typecheck + lint + unit/db/integration
npm run test:e2e        # Playwright, mock dialer
npm run build && npm run check:bundle
```

- **The agent-isolation suite is the gate.** If it is red, nothing ships, whatever else is green.
- `check:bundle` must be run with the same environment the build used; it reports which secrets it
  actually searched for, and a clean result with no secrets set proves less than it appears to.
- After deploying, confirm `APP_BASE_URL` matches the deployed origin and place one test call in
  each direction.
- Confirm `DIALER_DRIVER` is not `mock` — in production the server refuses to start with it (D24),
  which is the intended failure, but it is better to catch it before the deploy.
