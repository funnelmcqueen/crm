# Funnel McQueen CRM

A mobile-first CRM for cold-calling agents. One loop, made fast:

> **open lead → tap CALL → the call runs inside the CRM through Twilio → hang up → log the outcome in 1-2 taps → NEXT LEAD**

Everything else exists to keep that loop moving. The hard requirement underneath it is **agent
isolation**: an agent sees only the leads currently assigned to them and their own activity. Every
other lead, agent, phone number and statistic does not exist as far as they are concerned — in
search, counts, pipeline, follow-ups, exports, call routing, voicemail and API responses alike.
That is enforced in Postgres with row-level security, column grants and guarded RPCs, not by hiding
things in the UI.

- **Product spec:** [`docs/SPEC.md`](docs/SPEC.md)
- **Build contract:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Every intentional difference from the spec:** [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md), indexed by theme
- **What actually got built, stage by stage:** [`docs/PLAN.md`](docs/PLAN.md)
- **Day-2 operations:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)

---

## Contents

1. [Stack](#stack)
2. [Features by role](#features-by-role)
3. [Local setup (no Docker)](#local-setup-no-docker)
4. [npm scripts](#npm-scripts)
5. [What localbase is](#what-localbase-is)
6. [Real Supabase setup](#real-supabase-setup)
7. [Deploying to Vercel](#deploying-to-vercel)
8. [Twilio setup, step by step](#twilio-setup-step-by-step)
9. [Running webhooks locally through a tunnel](#running-webhooks-locally-through-a-tunnel)
10. [Switching DIALER_DRIVER](#switching-dialer_driver)
11. [Testing and verification](#testing-and-verification)
12. [Security notes](#security-notes)
13. [Troubleshooting](#troubleshooting)

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3 (App Router, React 19, TypeScript strict) |
| Styling | Tailwind 4 + shadcn/ui, dark-only on charcoal |
| Database / auth | Supabase (Postgres, GoTrue, RLS) |
| Telephony | Twilio Programmable Voice — `@twilio/voice-sdk` in the browser, `twilio` Node lib on the server |
| Validation | Zod on every server action, route handler and RPC input |
| Hosting | Vercel |
| Tests | Vitest (unit / db / integration) + Playwright |

Next.js 16 notes that bite if you come from 15: `src/proxy.ts` replaces `middleware.ts` (Node
runtime only), `cookies()` / `headers()` / `params` / `searchParams` are async only, and `next lint`
is gone in favour of `eslint`. Read `node_modules/next/dist/docs/` before reaching for an API you
are unsure about.

## Features by role

**Agent**

- Dashboard: calls today against the daily target, connected / interested / appointments, talk
  time, follow-ups due, unheard voicemails, and a NEXT LEAD card with a big CALL button. "Today" is
  the agent's own timezone. No team data anywhere.
- My Leads: server-paginated list (25/page) with debounced search across business, contact, phone
  digits, email, website and city; status and source filters; sort; all kept in the URL.
- Lead detail: call button (sticky at the bottom on mobile), status, notes, follow-up picker, and
  the full call history with a voicemail player.
- Calling: in-app through Twilio on desktop, the native dialer on iPhone, with an in-call bar
  (timer, mute, DTMF keypad, hang up). Incoming callbacks ring wherever the agent is in the app.
- Outcome logging in one or two taps, with the status mapping applied server-side in a single
  transaction, then Save & Next.
- Pipeline: drag or "Move to…" between columns, per-column pagination, touch-friendly.
- Follow-ups: Overdue / Today / Upcoming / Completed / Voicemails, with Call, Complete and
  Reschedule quick picks resolved in the agent's timezone.
- Export their own leads to CSV; edit their own name, password and call-mode preference; pick a
  microphone and speaker.

**Admin** — everything above across the whole team, plus:

- Team dashboard: totals and per-agent rows (calls today vs target), each linking to a drill-down
  of that agent's leads, calls and stats.
- All Leads, including unassigned; create, reassign and hard-delete leads.
- Agents: create (one-time password shown once), disable (also banned in Supabase Auth) and
  reactivate, toggle in-app calling, set targets and timezones, bulk-reassign, and a banner when
  leads are still held by disabled agents.
- Phone Numbers: add an already-purchased Twilio number (the CRM looks it up and points its voice
  handler at the TwiML App), assign to an agent or leave it in the shared pool, deactivate.
- Reports: date range, per agent (dials, connect rate, talk minutes, average call length,
  interested, appointments, clients), per number (dials, answer rate — how you spot a number being
  flagged as spam), and team totals.
- CSV import: upload, map columns, preview with duplicate and invalid-row review, split across
  agents, and a downloadable CSV of every row that was not inserted.
- Settings: company name, default target and timezone, voicemail greeting.

Public signup is disabled. Admins create agents; the first admin is promoted from the command line
(see [Real Supabase setup](#real-supabase-setup)).

---

## Local setup (no Docker)

You need Node ≥ 20.9 (developed on 24) and npm. You do **not** need Docker, WSL, Postgres, the
Supabase CLI or a Twilio account.

```bash
npm install
```

### The one-command path

```bash
npm run dev:local
```

This boots a persistent localbase (data in `.localbase/`, gitignored), seeds it on first run if the
database is empty, and starts `next dev` already wired to it with `DIALER_DRIVER=mock`. Open
<http://localhost:3000> and sign in with any account from the [dev logins](#dev-logins) table.
Pass through arguments with `--`, e.g. `npm run dev:local -- --port 3001`.

### The explicit path

Useful when you want the database and the app in separate terminals, or a `.env.local` you control.

**1. Start the database.** In terminal one:

```bash
npm run localbase
```

It applies `localbase/bootstrap.sql` and then every file in `supabase/migrations/` in order, and
prints a ready-to-paste env block:

```
[localbase] applied bootstrap.sql
[localbase] applied migration 20260915000100_core_schema.sql
... (12 migrations)
[localbase] listening on http://127.0.0.1:54321

localbase is running (data: .../.localbase/data)
  API URL:          http://127.0.0.1:54321
  REST:             http://127.0.0.1:54321/rest/v1
  Auth:             http://127.0.0.1:54321/auth/v1
  anon key:         eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  JWT secret:       super-secret-jwt-token-with-at-least-32-characters-long

Paste into .env.local:

NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
APP_BASE_URL=http://localhost:3000
DIALER_DRIVER=mock

Press Ctrl+C to stop.
```

Flags: `--port N`, `--data-dir DIR`, `--memory` (nothing is persisted), `--seed` (seed right after
migrating), `--reset` (delete the data directory first). The keys are the well-known Supabase local
demo keys, the same ones `supabase start` issues, and they only work against a local stack.

**2. Create `.env.local`.** `cp .env.example .env.local`, then paste the block above over the
Supabase lines. `.env.example` documents every variable; `.env*` is gitignored apart from the
template itself.

**3. Seed it.** In terminal two:

```bash
npm run db:seed
```

Running it against a database that already has data changes nothing and just reports the totals:

```
already seeded
Database was already seeded; nothing changed. Current totals:
  users 5 · phone numbers 3 · leads 45 · calls 58 · follow-ups 15 open / 4 completed · voicemails 2
```

A fresh seed writes the same shape: 5 users, 3 Twilio numbers (two assigned, one pooled), 45 leads
(40 spread across the agents, 5 unassigned), call history in both directions, two voicemails, and
follow-ups including overdue ones. All phone numbers are in the reserved fictional
`+1 NXX 555-01xx` range. The seed refuses any host other than localhost/127.0.0.1 unless you set
`SEED_ALLOW_REMOTE=1`, because it creates an ADMIN account with a published password.

**4. Start the app.**

```bash
npm run dev
```

### Dev logins

Password for every account: **`McQueen-dev-2026`**

| Email | Name | Role | Timezone | Daily target | Status |
|---|---|---|---|---|---|
| `admin@funnelmcqueen.test` | Velo Admin | ADMIN | America/New_York | 50 | active |
| `alex@funnelmcqueen.test` | Alex Rivera | AGENT | America/New_York | 50 | active |
| `blair@funnelmcqueen.test` | Blair Chen | AGENT | America/Chicago | 60 | active |
| `casey@funnelmcqueen.test` | Casey Morgan | AGENT | America/Los_Angeles | 40 | active |
| `dana@funnelmcqueen.test` | Dana Brooks | AGENT | America/New_York | 50 | **disabled (banned)** |

Dana exists to prove that a disabled agent with a still-valid token gets zero rows and cannot get a
Twilio token. Signing in as Dana is supposed to fail.

---

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | `next dev`. Expects Supabase settings in `.env.local`. |
| `npm run dev:local` | Persistent localbase + seed on first run + `next dev` wired to it (`DIALER_DRIVER=mock`). Needs no `.env.local`. Extra args go to `next dev`. |
| `npm run build` | `next build`. Production build; also the Vercel build command. |
| `npm run start` | `next start` against an existing build. |
| `npm run lint` | `eslint . --max-warnings=0`. Also enforces the telephony import boundaries (only `src/lib/dialer/drivers/twilio.ts` may import `@twilio/voice-sdk`; only `src/server/twilio/**`, `scripts/**` and `tests/**` may import the `twilio` Node lib) and keeps `server-only` out of client code. |
| `npm run typecheck` | `tsc --noEmit`, strict. |
| `npm test` | All Vitest projects. |
| `npm run test:unit` | `tests/unit/**` — pure domain logic: phone normalization, duplicate detection, outcome→status mapping, Next Lead ordering, CSV escaping, dial-mode resolution. No database. |
| `npm run test:db` | `tests/db/**` — PGlite in-process, raw SQL as `authenticated`: RLS policies, column grants, trigger guards, RPC semantics. |
| `npm run test:integration` | `tests/integration/**`, `tests/routes/**`, `tests/localbase/**` — supabase-js over HTTP against a localbase the setup starts and seeds, exactly as a browser would talk to it. Includes the isolation suites, the Twilio webhook suites and the emulator's own translation tests. |
| `npm run verify` | `typecheck && lint && test`. The gate every stage had to pass. |
| `npm run test:e2e` | `playwright test` (Chrome via `channel: 'chrome'`, no browser download). Starts its own in-memory seeded localbase on 54370 and `next dev` on 3170 with the mock dialer. |
| `npm run localbase` | Start the Docker-free Supabase emulator. Flags above. |
| `npm run localbase:reset` | Same, but deletes `.localbase/data` first and re-applies every migration from scratch. Prints `[localbase] deleted <path>` before booting. |
| `npm run db:seed` | Seed the database at `NEXT_PUBLIC_SUPABASE_URL` using `SUPABASE_SERVICE_ROLE_KEY`. Idempotent: it detects an existing seed and changes nothing. Works against localbase, `supabase start` and hosted Supabase alike. |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` by introspecting a throwaway in-memory database built from `supabase/migrations/`. Run it after every migration and commit the result. |
| `npm run make-admin -- <email> [--create]` | Promote a user to an active ADMIN. See below. |
| `npm run samples:csv` | Regenerate `samples/leads.csv` (100 rows, deliberately including duplicates and invalid rows for import testing). Deterministic. |
| `npm run check:bundle` | Scan the built client bundles for a Supabase service-role JWT or any Twilio secret present in the environment. Run it after `npm run build`, with the same environment the build used. |

---

## What localbase is

`supabase start` needs Docker. This project was built on a machine without Docker, WSL, Postgres or
the Supabase CLI, and weakening the isolation tests was not an option — agent isolation is the one
non-negotiable requirement, and proving it means attacking the database the way an attacker would.

So `localbase/` runs **the real `supabase/migrations/*.sql`** inside **PGlite** (Postgres 18
compiled to WebAssembly), behind a small HTTP server that implements the subset of the
**PostgREST** (`/rest/v1`) and **GoTrue** (`/auth/v1`) APIs that supabase-js uses. Every request
runs in a transaction as `SET LOCAL ROLE authenticated | anon | service_role` with
`request.jwt.claims` set, exactly the way PostgREST does it.

The consequence that matters: **RLS is enforced by Postgres itself, never by the emulator.** The
isolation tests sign in with `signInWithPassword`, get real HS256 JWTs, and talk to the API with
the anon key — the same path a browser or a hostile devtools console takes. A second suite
(`tests/db/**`) drives PGlite directly with raw SQL, which is a superset of anything PostgREST can
express. This is recorded as deviation D1.

Two emulator-only differences are documented rather than papered over: embedded selects
(`select('*, profiles(name)')`) are rejected, so the app uses RPCs, `security_invoker` views or two
queries (ARCHITECTURE rule 6); and localbase has no mailer, so an email change applies immediately
there while real Supabase still sends the confirmation link (D10).

### Running the same suite against a real local Supabase

If you do have Docker:

```bash
supabase start          # applies supabase/migrations, prints the URL and keys
npm run db:seed         # with NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pointed at it

SUPABASE_TEST_URL=http://127.0.0.1:54321 \
SUPABASE_TEST_ANON_KEY=<anon key> \
SUPABASE_TEST_SERVICE_ROLE_KEY=<service_role key> \
npm run test:integration
```

All three variables must be set together — setting only some is an error rather than a silent
fallback. The target stack must already be migrated and seeded; the test setup will not seed a
stack it does not own. `SUPABASE_TEST_JWT_SECRET` (from `supabase status`) additionally enables the
tests that mint their own JWTs. Nothing else changes: the same suite, the same assertions.

---

## Real Supabase setup

1. **Create a project** at <https://supabase.com/dashboard>. Note the region and the database
   password.

2. **Link the CLI and push the migrations.**

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   `supabase/migrations/` is the single source of truth for schema, RLS, grants and RPCs, and the
   migrations are ordinary SQL — if you would rather not use the CLI, run the files in filename
   order in the SQL editor instead. Do not hand-edit the schema afterwards: the next `db push`
   would fight you, and `tests/db/grants.test.ts` asserts the exact EXECUTE matrix for every
   function.

3. **Keep public signup disabled.** `supabase/config.toml` sets `enable_signup = false` for local
   use, but that file does not govern a hosted project. In the dashboard, go to
   **Authentication → Sign In / Providers → Email** and make sure sign-ups are disabled, then
   confirm it by trying to sign up: you should get `signup_disabled`. This is load-bearing. Admins
   create agents; nobody creates themselves.

4. **Seed it (development projects only, optional).**

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
   SEED_ALLOW_REMOTE=1 \
   npm run db:seed
   ```

   `SEED_ALLOW_REMOTE=1` is required because the seed creates accounts with a password published in
   this README, including an ADMIN. Never do this to a production project.

5. **Promote the first admin.** With `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
   `.env.local` (the script reads that file automatically):

   ```bash
   npm run make-admin -- velo@example.com
   ```

   That promotes an existing user to an active ADMIN, and lifts a sign-in ban if one is in place.
   If the user does not exist yet:

   ```bash
   npm run make-admin -- velo@example.com --create
   ```

   `--create` creates the account, prints a 24-character temporary password **once** (change it in
   Settings), and promotes it. With no arguments the script prints its usage and exits 2:

   ```
   Usage: npm run make-admin -- <email> [--create]
   ```

   Exit codes: 0 success, 1 failure, 2 usage or configuration error.

---

## Deploying to Vercel

1. **Connect the repository** at <https://vercel.com/new>. Vercel detects Next.js; the build
   command is `npm run build` and the output directory is the default. No `vercel.json` is needed —
   this project does not ship one, and adding one would only override defaults that are already
   correct.

2. **Set the environment variables** in Project Settings → Environment Variables, for every
   environment you deploy (Production, Preview, Development).

| Name | Example | Exposure | Required |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://abcdefgh.supabase.co` | public (browser) | yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIs…` | public (browser) | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOiJIUzI1NiIs…` | **server only** | yes |
| `APP_BASE_URL` | `https://crm.example.com` | server only | yes in practice; required when `DIALER_DRIVER=twilio` |
| `DIALER_DRIVER` | `twilio` | server only | no (see [below](#switching-dialer_driver)) |
| `TWILIO_ACCOUNT_SID` | `AC00000000000000000000000000000000` | **server only** | required with `twilio` |
| `TWILIO_AUTH_TOKEN` | `your_auth_token` | **server only** | required with `twilio` |
| `TWILIO_API_KEY_SID` | `SK00000000000000000000000000000000` | **server only** | required with `twilio` |
| `TWILIO_API_KEY_SECRET` | `your_api_key_secret` | **server only** | required with `twilio` |
| `TWILIO_TWIML_APP_SID` | `AP00000000000000000000000000000000` | **server only** | required with `twilio` |

   Only the two `NEXT_PUBLIC_` values may reach the browser. Everything else is read exclusively by
   `src/server/env.ts`, which is marked `import 'server-only'`. Never rename a secret to
   `NEXT_PUBLIC_*` to "make it work" — that inlines it into the client bundle, and
   `npm run check:bundle` exists to catch exactly that.

3. **Set `APP_BASE_URL` to the deployed origin** — scheme and host, no path, no trailing slash. It
   is validated. This is not cosmetic: Twilio signature validation reconstructs the signed URL from
   `APP_BASE_URL` + path, and Vercel's proxy rewrites the `Host` header, so the value cannot be
   inferred from the incoming request. If `APP_BASE_URL` and the URL Twilio calls disagree by so
   much as a trailing slash, every webhook returns 403.

   Preview deployments get their own URL. Either give each preview its own `APP_BASE_URL` and
   TwiML App, or accept that Twilio webhooks only work against Production.

4. **Deploy**, then finish the Twilio wiring:
   - Point the TwiML App's **Voice Request URL** at `https://<your-domain>/api/twilio/voice/outbound`
     (POST) and its **Status Callback URL** at `https://<your-domain>/api/twilio/voice/status`.
   - In the CRM, **Admin → Phone Numbers → Add number** for each purchased number; the server looks
     it up in your Twilio account and repoints its voice handler at the TwiML App.
   - Place one test call and one test callback before handing the app to agents.

5. **After each production build**, confirm nothing leaked:

   ```bash
   npm run build && npm run check:bundle
   ```

---

## Twilio setup, step by step

Twilio reorganises its Console from time to time. **The navigation below was confirmed against
Twilio's documentation on 2026-09-16**; if a menu has moved, the resource names (API key, TwiML
App, Trust Hub, usage trigger) have not, and the docs linked at each step are the authority.

Do these in order. Each step ends with the environment variable it produces.

### 1. Account SID and auth token

From the Console home page, **Account info** shows your **Account SID** and **Auth Token**.

> `TWILIO_ACCOUNT_SID=AC…`
> `TWILIO_AUTH_TOKEN=…`

The auth token signs every webhook Twilio sends you, and this app validates every one of them
against it. Treat it as the most sensitive value in the deployment. It is deliberately *not* used
to place calls — that is the API key's job, so the token can be rotated without touching call
routing.

### 2. Create a Standard API key

**Console → Settings → Account settings → API keys & auth tokens**, choose your region, then
**Create API key**. Give it a name, choose the **Standard** key type, and click Next. The secret is
shown exactly once: copy it, tick **Got it!**, and finish.
([docs](https://www.twilio.com/docs/iam/api-keys/keys-in-console))

> `TWILIO_API_KEY_SID=SK…`
> `TWILIO_API_KEY_SECRET=…`

The app uses this key to mint short-lived Voice access tokens for the browser (identity = the
agent's user id, TTL 1 hour) and to fetch voicemail media. If the secret is lost, create a new key
and delete the old one — it cannot be recovered.

### 3. Create a TwiML App

**Console → Voice → Manage → TwiML Apps → Create new TwiML App.** Give it a friendly name (e.g.
"Funnel McQueen CRM") and, under Voice Configuration, set:

| Field | Value |
|---|---|
| Request URL | `{APP_BASE_URL}/api/twilio/voice/outbound` |
| Request method | **HTTP POST** |
| Status Callback URL | `{APP_BASE_URL}/api/twilio/voice/status` |
| Status Callback method | **HTTP POST** |

Save, reopen the app, and copy its SID.

> `TWILIO_TWIML_APP_SID=AP…`

Use the `https` URL. Some browsers block microphone access on pages reached over plain http.

One TwiML App handles both directions. Outbound calls from the browser arrive at the Request URL
with a `client:` caller; inbound calls to your numbers arrive at the same URL with a real phone
number as the caller, and the handler routes them to the inbound flow (deviation D7). You do not
need a second app or a second URL.

### 4. Buy numbers

**Console → Phone Numbers → Manage → Buy a number.** Filter for the **Voice** capability, pick
numbers in the area codes your prospects recognise, and buy them. Do not configure their voice
webhooks by hand — step 5 does that for you. The CRM deliberately cannot buy or release numbers;
that stays a Twilio Console decision.

Buying local numbers in some countries requires supporting identity documents, which Twilio asks
for during checkout.

### 5. Add each number in the CRM

In the CRM: **Admin → Phone Numbers → Add number.** Enter the number in E.164 (`+14155551234`).
The server looks it up in your Twilio account, rejects it if it is not there, stores its
`twilio_sid`, and **sets that number's voice handler to your TwiML App** through the API. If either
the lookup or the handler update fails, nothing is inserted — you never end up with a number in the
CRM that Twilio does not route.

### 6. Assign numbers, or leave them in the pool

On the same page, assign a number to an agent or leave it unassigned (the shared pool). This drives
both directions:

- **Outbound caller ID:** the agent's own number if they have one, otherwise the least recently
  used active pool number, rotated so the pool wears evenly.
- **Inbound routing:** a call from a number that matches a lead goes to that lead's owner. An
  unrecognised caller reaches the agent the dialled number is assigned to, provided the number is
  still active. Anything else goes to admin-only voicemail.

Deactivating a number keeps its assignment (so reactivating restores it) but takes it out of both
rotations.

### 7. Trust Hub: business profile and STIR/SHAKEN

Do this before you start dialling at volume. Without it, carriers increasingly label unsigned
outbound calls as "Spam Likely" and your answer rates collapse.

1. **Console → Account → Trust Hub → Customer profiles** (older accounts: Trust Hub → Business
   profile). Create a **Primary Business Profile** with your legal entity details and submit it for
   vetting.
2. Assign your purchased numbers to the approved business profile: open the profile, find
   **Assigned phone numbers**, and use **Assign more numbers**.
3. **Trust Hub → Registrations → SHAKEN/STIR:** create the SHAKEN/STIR trust product, submit it for
   vetting, and assign the same numbers to it.
4. Optionally add **Voice Integrity**, which monitors and remediates spam labelling on top of the
   attestation.

Vetting typically takes 24-48 hours. Once approved, outbound calls are signed with full
attestation. ([docs](https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir/shakenstir-onboarding/shakenstir-onboarding-in-the-twilio-console))

This produces no environment variable. It is still the difference between a dialler that works and
one that does not.

### 8. Set a usage trigger for spend

**Console → Billing and Usage → Usage and Spend → Usage Triggers tab → Create Usage Trigger.**
Pick a category (total price, or voice minutes), a threshold, a recurrence (daily / monthly /
yearly), and an email or webhook to notify.
([docs](https://www.twilio.com/docs/voice/guides/track-usage-costs-health))

Create at least two: a daily one at roughly 1.5× a normal day's spend, which catches a runaway
loop within the hour, and a monthly one near your budget. A compromised token or a retry storm is
much cheaper to discover from an alert than from an invoice.

### 9. Harden voicemail media

**Console → Voice → Settings → General**, find **Enforce HTTP Auth on Media URLs**, select
**Enable**, and save. Recording media then requires HTTP Basic Auth — an API key SID as the
username and its secret as the password — instead of being fetchable by anyone who has the URL.
([docs](https://support.twilio.com/hc/en-us/articles/15827821586843-Prevent-unauthorized-access-to-your-Programmable-Voice-Media-with-HTTP-Basic-Auth))

This app already fetches recordings with API-key basic auth, server-side, so enabling the setting
requires no code change. It closes the gap in the other direction: a recording SID that leaks by
any other route stops being enough to hear the audio. See [Security notes](#security-notes) for how
voicemail reaches the browser.

### Summary

After all nine steps:

```bash
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
TWILIO_API_KEY_SID=SK…
TWILIO_API_KEY_SECRET=…
TWILIO_TWIML_APP_SID=AP…
APP_BASE_URL=https://crm.example.com
DIALER_DRIVER=twilio
```

---

## Running webhooks locally through a tunnel

Twilio has to reach your machine, so a tunnel is the only way to exercise real inbound calls,
status callbacks and voicemail recording in development.

```bash
ngrok http 3000
# or
cloudflared tunnel --url http://localhost:3000
```

Then:

1. Put the tunnel's public URL in `.env.local` as `APP_BASE_URL`, with no trailing slash:
   `APP_BASE_URL=https://abc123.ngrok-free.app`
2. **Restart the app.** `APP_BASE_URL` is read and cached on the server; editing `.env.local` while
   `next dev` is running is not enough.
3. Point the TwiML App's Voice Request URL at `https://abc123.ngrok-free.app/api/twilio/voice/outbound`
   and its Status Callback at `…/api/twilio/voice/status`.

**The signature check uses `APP_BASE_URL` exactly.** Every `/api/twilio/*` route rebuilds the
signed URL as `APP_BASE_URL + pathname + search` and compares it against `X-Twilio-Signature`. A
mismatch of any kind — http vs https, a stale tunnel URL, a trailing slash — produces a 403 with no
explanation, by design. If every webhook suddenly 403s, this is almost always why.

A free ngrok URL changes every restart, so expect to repeat steps 1-3. Use a reserved domain, or a
named cloudflared tunnel, if you do this often.

---

## Switching `DIALER_DRIVER`

All dialling goes through `src/lib/dialer`, so the UI never imports Twilio directly and the driver
is a single environment variable.

| Value | Behaviour |
|---|---|
| `twilio` | In-app calling through Twilio Voice: the browser registers a Device, CALL connects it, and the in-call bar gives you mute, a DTMF keypad and hang up. The default on desktop. Requires all five `TWILIO_*` variables and `APP_BASE_URL`. |
| `tel` | Renders `<a href="tel:+1…">` and hands off to the device's dialer. When the page becomes visible again, the outcome sheet opens. Duration is manual and optional. This is the fallback path, and the automatic choice on iOS, where a browser call drops the moment the screen locks. |
| `mock` | Simulates ringing (1.2s), connect and hangup with no Twilio account, and serves a generated tone in place of voicemail audio. For local development and the Playwright suite. |

Leave it unset and it resolves itself: `twilio` when Twilio is fully configured, otherwise `mock` in
development and test, and `tel` in production — a production app must never silently fake calls.

**`mock` is refused in production.** `DIALER_DRIVER=mock` together with `NODE_ENV=production` is an
invalid environment and the server does not serve a single request: `src/instrumentation.ts`
validates the environment in Next's `register()` hook and **exits the process** when it is invalid,
after logging which variable is wrong. You will see Next print "Ready" and then exit — the port never
accepts a connection, so a misconfigured deployment cannot go live (deviations D24 and D35). A copied
dev `.env` would otherwise log outcomes and talk time for calls that never happened, and replace real
voicemail with a test tone.

**Voicemail audio is never faked in production.** The generated tone stands in for Twilio media only
outside production. A production deployment without Twilio configured answers
`GET /api/voicemail/[callId]` with 503 instead of a beep, so nobody can mistake a synthetic tone for
a customer's message (deviation D33).

Agents can also override the mode per device in Settings (Auto / Always in-app / Always phone),
within what the driver allows.

---

## Testing and verification

```bash
npm run verify     # typecheck + lint + every Vitest project
npm run test:e2e   # Playwright
```

`npm run verify` runs `tsc --noEmit` in strict mode, ESLint with `--max-warnings=0` (including the
telephony import boundaries), and all three Vitest projects:

- **unit** — pure, isomorphic domain logic with no database: phone normalization, duplicate
  detection, the outcome→status mapping including the no-downgrade and sticky-DO_NOT_CONTACT rules,
  Next Lead ordering, caller-ID pool rotation, CSV escaping, import mapping, dial-mode resolution.
- **db** — PGlite in-process, raw SQL executed as `authenticated` with real JWT claims: every RLS
  policy, the column grants, the trigger guards, the EXECUTE matrix for every function, and RPC
  semantics (including that `log_call` never double-counts).
- **integration** — supabase-js over HTTP against a seeded localbase, the way a browser talks to
  Supabase.

**The agent-isolation suite is the release gate.** It is not a section of the test run, it is the
reason for it. It asserts that agent A cannot read B's lead by id, cannot surface it through search
or `ilike`, cannot see B's data in any count, view, aggregate or RPC, cannot read B's calls, notes,
voicemails or follow-ups, cannot stream B's voicemail, cannot update or delete B's lead, cannot
change `assigned_to` on any lead including their own, cannot create a call or follow-up on B's
lead, cannot get the outbound webhook to dial B's lead, cannot dial a DO_NOT_CONTACT lead, cannot
read `phone_numbers` or any other profile, cannot change their own role / active flag / target /
in-app calling flag, cannot export B's leads, and cannot call an admin RPC. It also covers a
disabled agent with a still-valid token getting zero rows, and reassignment moving access —
including inbound callbacks — from A to B completely. **If that suite is red, the release does not
ship**, whatever else is green.

The **Twilio webhook suite** (`tests/routes/**`) signs requests with the `twilio` library and a test
auth token, then checks that unsigned and wrongly-signed requests get 403, that a mismatched
`AccountSid` is rejected, that status callbacks are idempotent under Twilio's retries, that the
outbound TwiML contains the right lead number and caller ID, and that inbound routing sends a
matched lead to its owner, an unmatched caller on an assigned number to that agent, and everything
else to voicemail with a follow-up created.

**Playwright** runs against Chrome (`channel: 'chrome'`, no browser download) with the mock dialer,
starting its own in-memory seeded localbase on 54370 and `next dev` on 3170. Four projects: `mobile`
(iPhone viewport and UA, so the dialer resolves to `tel:`), `desktop` (in-call bar → hang up →
outcome sheet → Save & Next), `journey` (the voicemail callback flow, which depends on `desktop` so
it runs after it), and an `import` project that runs last because it inserts 97 leads into the
shared database. `tests/unit/docs/docs-drift.test.ts` checks this paragraph against
`playwright.config.ts` and `e2e/admin-import.spec.ts`, so it cannot quietly fall behind again.

**Bundle check:**

```bash
npm run build && npm run check:bundle
```

It scans the built client files for a Supabase service-role JWT and for every secret value present
in the environment, and it tells you which secrets it actually looked for:

```
check:bundle: OK, 85 client files contain no service_role JWT or secret (SUPABASE_SERVICE_ROLE_KEY)
```

Run it with the same environment the build used. If the environment holds none of the secrets the
build would have used, the scan has nothing to search for and **fails with exit code 3** rather than
reporting a clean result it never earned — a pipeline should not be able to record a passing secret
check that never looked for a Twilio secret (deviation D38). Accept that deliberately with a flag:

```bash
npm run check:bundle -- --allow-missing-secrets
```

Exit codes: `0` clean, `1` a secret reached a client file, `2` no build output, `3` nothing to
search for.

---

## Security notes

**Isolation lives in Postgres.** RLS is enabled on every table and denies by default. Every query
from app code runs with the user's session (anon key + user JWT), so RLS applies. Helper functions
`is_admin()` and `is_active_user()` are `SECURITY DEFINER`, `STABLE`, with `search_path = ''`, so an
inactive user gets zero rows on every table even with a valid JWT.

**Column grants, not just row policies.** A row policy cannot hide a column, and the spec requires
that a reassigned lead's history never reveals who made the earlier calls. So `authenticated` has
no SELECT privilege on `calls.user_id`, `phone_number_id`, `provider_call_sid` or
`voicemail_recording_sid` at all. The app reads them through `SECURITY DEFINER` RPCs that re-check
access and expose caller names and caller ID to admins only (D3). Never `select('*')` on `calls` —
it will be rejected.

**Service-role boundaries.** The service role bypasses RLS, so it is used in exactly three places:
Supabase Auth admin operations (create and ban users), Twilio webhooks (which have no user
session), and the voicemail route's recording-SID lookup, which happens only after `getUser()` has
verified the session and which passes that verified user id into an RPC that re-checks access
(D13). Everything else uses the caller's session. It is grep-able: `createAdminClient(`.

**Unauthorized equals nonexistent.** An id the caller cannot access returns 404 `{error:'not_found'}`
with the same body and the same path as a genuinely missing id. A malformed id returns 404 too,
because a 400 for some ids and a 404 for others is an oracle (D19). That holds on every
agent-reachable entry point, `logCall` included: a `leadId` or `callId` that is not a uuid answers
exactly like one belonging to another agent (D32). Genuine form errors — a missing follow-up time, a
duration out of range — are still 400.

**Twilio signature validation** on every `/api/twilio/*` route, against `TWILIO_AUTH_TOKEN` and the
exact `APP_BASE_URL` + path, plus a check that the request's `AccountSid` matches
`TWILIO_ACCOUNT_SID`. Failures return a bare 403. Webhooks trust nothing except signed Twilio
parameters and the database — the browser sends only a call id, never a phone number or a lead id
the server has not verified. Failures are logged with phone numbers masked (`+1******0123`).

**Rate limits** live in the database, so they hold across serverless instances: 20 Voice tokens per
10 minutes, 12 outbound call creations per minute, and 30 CSV exports per 10 minutes, per user. The
policy is fixed in SQL and the internal function is callable by no API role, so a caller cannot
choose their own window or prune their own hits (D14). `create_outbound_call` applies its own limit,
so calling the RPC directly does not skip it. The export limit (D36) is about cost rather than
isolation: every export pages the caller's whole book, and an admin's covers every lead in the
system. Sign-in throttling is left to GoTrue.

**CSRF.** The cookie-authenticated POST routes (`/api/voice/token`, `/api/voice/presence`,
`/api/calls/outbound`) reject a request whose `Origin` header is present and is neither
`APP_BASE_URL`'s origin nor the request's own (D19).

**CSV formula injection.** Exported cells beginning with `=`, `-`, `+`, `@`, tab, CR or LF are
prefixed with `'`, as are the full-width forms (`＝ ＋ － ＠`) and any of those characters after
leading spaces or non-breaking spaces. Validated E.164 values in the phone column are exempt from
the `+` rule so numbers stay usable (D9), and the import strips one such escaping apostrophe back
off, so the "download the failed rows, fix them, re-import" loop round-trips (D30).

**Voicemail audio never reaches the browser as a Twilio URL.** `/api/voicemail/[callId]` verifies
the session, looks the recording SID up server-side, fetches the media from Twilio with API-key
basic auth, and streams it back with `Cache-Control: private, no-store`. Enabling **Enforce HTTP
Auth on Media URLs** in the Twilio Console (step 9 above) is the matching control on Twilio's side.
In production the generated tone is never substituted for real media: without Twilio configured the
route answers 503, so a synthetic beep can never be mistaken for a customer's message (D33).

**The session cookie is `Secure` in production.** It holds both the access token and the refresh
token, and `@supabase/ssr` sets no `Secure` flag of its own, so every client that owns the cookie —
the browser client, the Server Component client, the route-handler client and the proxy — passes
`cookieOptions: sessionCookieOptions()` (D34). Without it the browser would attach the session to
any plaintext `http://` request for the domain. It stays off outside production so `http://localhost`
keeps working. `httpOnly` cannot be set: the browser client has to read the cookie.

**Headers.** `Permissions-Policy: microphone=(self), camera=(), geolocation=()` (in-app calling
needs the microphone, and only on our own origin), plus `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.

**Secrets** are read only in `src/server/env.ts`, which is marked `import 'server-only'` and
validates everything with Zod. No secret is ever prefixed `NEXT_PUBLIC_`, and `npm run check:bundle`
proves it against the actual build output.

---

## Troubleshooting

**A port is already in use.** localbase defaults to 54321 and the app to 3000. Both can move:
`npm run localbase -- --port 54399`, `npm run dev -- --port 3001`, `npm run dev:local -- --port 3001`
(the latter also honours `LOCALBASE_PORT`). If a previous run is wedged on Windows, signals do not
reach a process tree — kill it with `taskkill /pid <pid> /T /F`.

**The database looks wrong, or a migration changed.** localbase tracks applied migrations in
`localbase.schema_migrations` and never re-runs or rewrites one. Editing an already-applied
migration therefore has no effect until you start over:

```bash
npm run localbase:reset
```

That deletes `.localbase/data`, re-applies every migration from scratch, and prints
`[localbase] deleted <path>` as it does. Then `npm run db:seed` again. Any local data is gone, which
is the point.

**Types are out of date after a schema change.**

```bash
npm run db:types
```

It rebuilds the schema in a throwaway in-memory database and rewrites `src/lib/database.types.ts`.
Commit the result with the migration. If typecheck complains about a column or RPC you just added,
this is the step you skipped.

**Twilio webhooks all return 403.** `APP_BASE_URL` does not match the URL Twilio is calling. Compare
them character for character, including scheme and trailing slash, restart the app after changing
it, and remember that a free ngrok URL changes on every restart. See
[the tunnel section](#running-webhooks-locally-through-a-tunnel).

**The server refuses to start and names a variable.** `src/instrumentation.ts` validates the
environment in Next's startup hook, so an invalid combination stops the server instead of failing
later on one route at a time (D35). The message names the offending variables, never their values.
The usual causes: a missing `SUPABASE_SERVICE_ROLE_KEY`, an `APP_BASE_URL` with a path or trailing
slash, `DIALER_DRIVER=twilio` without all five Twilio variables, or `DIALER_DRIVER=mock` with
`NODE_ENV=production` (D24). Fix the variable and start again; there is nothing to clean up.

**Signing in as `dana@funnelmcqueen.test` fails.** Correct. Dana is the seeded disabled agent, both
flagged inactive and banned in Auth.

**Windows.** Developed on Windows 11 with Git Bash and PowerShell. Use forward slashes in scripts,
keep LF line endings (`.gitattributes` enforces it), and note that npm scripts use Node's
`--env-file-if-exists` rather than `cross-env`, so there is no extra dependency to install. Scripts
that spawn `next` do so through `node node_modules/next/dist/bin/next` rather than the `.cmd` shim,
which avoids needing a shell and gives `taskkill` a pid it can walk.
