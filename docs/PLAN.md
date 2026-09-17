# Funnel McQueen CRM: Implementation Record

This started as a forecast. It is now a record of what actually happened, kept in the same shape
so the plan and the outcome can be compared. The binding documents are `docs/SPEC.md` (behavior),
`docs/ARCHITECTURE.md` (build contract) and `docs/DEVIATIONS.md` (every intentional difference).

## Environment (inspected 2026-09-15)

| Tool | Status |
|---|---|
| Node 24.18, npm 11.16, pnpm 11.20, git 2.54 | installed |
| Chrome, Edge | installed (Playwright uses `channel: 'chrome'`, no browser download) |
| Docker, WSL, Postgres, Supabase CLI | **not installed** |
| Repo | empty; scaffolded fresh (Next 16.3.5, React 19.2, Tailwind 4, shadcn radix-nova) |

Windows 11 throughout: forward slashes in scripts, no `cross-env` (Node `--env-file-if-exists`),
LF line endings, and `taskkill /T /F` wherever a process tree has to die.

## Key decision: Docker-free local Supabase ("localbase")

`supabase start` needs Docker, which is not available and whose installation changes system
settings. Weakening the tests was not acceptable either, because SPEC 1 makes agent isolation the
one non-negotiable requirement and SPEC 13 requires it to be proven the way an attacker would
attack it. So we run the **same `supabase/migrations/*.sql`** inside **PGlite** (Postgres 18
compiled to WASM), fronted by a small HTTP server implementing the subset of the **PostgREST**
(`/rest/v1`) and **GoTrue** (`/auth/v1`) APIs that supabase-js uses.

This held up. PGlite was verified to enforce `SET ROLE`, RLS, column grants, `security_invoker`
views, pg_trgm and pgcrypto. Every request runs in a transaction as
`SET LOCAL ROLE authenticated|anon|service_role` with `request.jwt.claims` set, exactly as
PostgREST does, so **RLS is enforced by Postgres itself and never by the emulator**.

- Isolation tests use **supabase-js + the anon key + real HS256 JWTs** from `signInWithPassword`.
- A second raw-SQL RLS suite hits PGlite directly, a superset of anything PostgREST can express.
- Setting `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` / `SUPABASE_TEST_SERVICE_ROLE_KEY` runs
  the identical suite against a real `supabase start` or hosted project. Recorded as D1.

Cost of the decision, all logged as deviations: the emulator rejects embedded selects
(`select('*, profiles(name)')`), so the app uses RPCs, `security_invoker` views or two queries
(ARCHITECTURE rule 6); and localbase has no mailer, so an email change applies immediately there
while real Supabase still sends the confirmation link (D10). Neither changes production behavior.

## Stages (each ended with `npm run verify` = typecheck + lint + tests green)

Stages 11 and 12 did run as their own rounds at the end. Mobile-first layout, 48px touch targets
and skeletons were built into each screen as it was written, and then a dedicated polish pass
measured real hit boxes, input font sizes and horizontal overflow at 320, 390, 768 and 1280 px
across every screen for both roles. Three independent audits (isolation, spec conformance,
production readiness) followed, feeding a final fix round and a release gate that walked both
SPEC 17 journeys in a real browser.

1. **Schema, RLS, auth, seed, localbase, isolation tests.** Migrations 000100-000300, the emulator,
   the domain library, the seed, and the DB + API isolation suites. Closed by an adversarial RLS
   review.
2. **Leads list + lead detail.** Server pagination, search, filters and sort, all kept in the URL.
3. **Call logging.** `log_call`, the outcome sheet, Next Lead (Skip, Save & Next), and the dialer
   module with its mock and tel: drivers.
4. **Twilio outbound.** Token route, pre-created call row, signed webhooks, caller ID rotation,
   in-call bar.
5. **Twilio inbound.** Routing, `<Dial><Client>`, voicemail recording plus follow-up, and the
   server-side voicemail streaming route.
6. **Dashboards.** Agent "today" in the agent's own timezone; admin team totals and drill-down.
7. **Follow-ups.** Tabs, complete, reschedule quick picks, voicemails tab.
8. **Pipeline.** dnd-kit with touch, per-column pagination, "Move to…" fallback.
9. **CSV import/export.** papaparse, mapping, preview, duplicate review, split assignment, result
   CSV; RLS-scoped export with formula-injection escaping.
10. **Admin.** Agents (create/disable/ban), phone numbers (Twilio lookup + TwiML App wiring),
    reassignment, reports, settings.
11. **Documentation and deployment.** README (SPEC 16), `.env.example`, deviations consolidation,
    this record.

Stages 2-5 and 6-10 were each built by parallel agents against disjoint file ownership, then
merged and gated.

## Orchestration, as it ran

Contract first (`docs/ARCHITECTURE.md`), then multi-agent workflows per stage group with disjoint
file ownership, a gate agent running `npm run verify`, and adversarial security review of every
RLS, RPC and webhook change.

The review loops were the part that mattered most, and they produced two dedicated migrations:

- **`20260915000400_review_fixes.sql`** (after stages 2-5) rewrote `log_call` and
  `mark_voicemail_heard`. The review found that a client-chosen primary key was an existence
  oracle (D16), that a caller-chosen rate-limit window let an agent prune their own hits (D14),
  that pre-created call rows were invisible to the "one active call" check (D15, later amended by
  D23), and that an admin listening to an agent's voicemail cleared that agent's badge (D20).
- **`20260915001200_review_fixes_2.sql`** (after stages 6-10) made identically labelled numbers
  agree across screens: the agent drill-down now uses the target agent's timezone, "Clients" means
  one thing everywhere, team talk time floors like its rows, and the Voicemails badge counts the
  rows its own tab lists (D30, which supersedes named parts of D27-D29).

Neither round was a matter of taste. Both fixed cases where the UI told the operator something the
database did not support.

## Where it landed

- 18 migrations (000100-001900), the single source of truth for schema, RLS, grants and RPCs.
- `npm run verify` and `npm run test:e2e` are green. Run them for the current counts rather than
  trusting a number written here: the five Playwright projects are `mobile`, `desktop`, `journey`,
  `import` and `workspace`, all on the mock dialer. `tests/unit/docs/docs-drift.test.ts` fails if this file, the
  README or the architecture contract falls behind `playwright.config.ts` again.
- The agent-isolation suite is the release gate, per SPEC 1 and SPEC 17.
- Every intentional difference from the spec is recorded in `docs/DEVIATIONS.md`, indexed by theme,
  with superseded passages marked rather than rewritten.
