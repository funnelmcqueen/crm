# Funnel McQueen CRM: Implementation Plan

## Environment (inspected 2026-09-15)

| Tool | Status |
|---|---|
| Node 24.18, npm 11.16, pnpm 11.20, git 2.54 | installed |
| Chrome, Edge | installed (Playwright uses `channel: 'chrome'`, no browser download) |
| Docker, WSL, Postgres, Supabase CLI | **not installed** |
| Repo | empty; scaffolded fresh (Next 16.3.5, React 19.2, Tailwind 4, shadcn radix-nova) |

## Key decision: Docker-free local Supabase ("localbase")

`supabase start` needs Docker, which is not available. Instead of weakening the tests, we run the
**same `supabase/migrations/*.sql`** inside **PGlite** (Postgres 18 compiled to WASM, verified to
enforce `SET ROLE`, RLS, column grants, `security_invoker` views, pg_trgm, pgcrypto), fronted by a
small HTTP server that implements the subset of the **PostgREST** (`/rest/v1`) and **GoTrue**
(`/auth/v1`) APIs that supabase-js uses. Every request runs in a transaction as
`SET LOCAL ROLE authenticated|anon|service_role` with `request.jwt.claims` set, exactly like
PostgREST, so RLS is enforced by Postgres itself and never by the emulator.

- Isolation tests use **supabase-js + anon key + real HS256 JWTs** from `signInWithPassword`.
- Point `SUPABASE_TEST_URL` / keys at a real `supabase start` and the same suite runs there.
- A second raw-SQL RLS suite hits PGlite directly (a superset of anything PostgREST can express).

## Stages (each ends with `npm run verify` = typecheck + lint + tests green)

1. Schema, RLS, auth, seed, localbase, isolation tests (DB + API level), adversarial RLS review
2. Leads list (server pagination/search/filters/sort in URL) + lead detail
3. `log_call` flow, outcome sheet, Next Lead (+Skip, Save & Next), dialer module (mock + tel drivers)
4. Twilio outbound: token route, pre-created call row, signed webhooks, caller ID rotation, in-call bar
5. Twilio inbound: routing, `<Dial><Client>`, voicemail record + follow-up, voicemail streaming route
6. Dashboards (agent today in own timezone, admin team + drill-down)
7. Follow-ups (tabs, complete, reschedule quick picks in agent timezone, voicemails tab)
8. Pipeline (dnd-kit, touch, per-column pagination, Move to… fallback)
9. CSV import (papaparse, mapping, preview, duplicates, split assignment, result CSV) + export
10. Admin: agents (create/disable/ban), phone numbers (Twilio lookup + TwiML App), reassignment, reports
11. Mobile polish (bottom tabs, sticky CALL, 48px targets, skeletons)
12. Full verification: e2e (Playwright, mock dialer), bundle secret grep, README, final isolation audit

## Orchestration

Contract first (`docs/ARCHITECTURE.md`), then multi-agent workflows per stage group with disjoint
file ownership, a gate agent that runs `npm run verify` and fixes, and adversarial security review
of every RLS/RPC/webhook change. Deviations from the spec are logged in `docs/DEVIATIONS.md`.
