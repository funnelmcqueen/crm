# Task 6 — Localization release audit

## Completed
- Localized route metadata, desktop and mobile navigation, unsaved-notes confirmation, skip-lead menu, and admin lead details.
- Replaced remaining hard-coded English user-facing strings in these audited surfaces; CRM data, CSV headers, URLs, and action contracts remain unchanged.

## Validation
- `npm run typecheck` — passed.
- Focused localization UI suite — passed (workspace, admin, operations, language switcher).
- `git diff --check` — passed.
- `npm run build` — passed.

## Release prerequisite
Apply `supabase/migrations/20260923002100_profile_locale.sql` to the production Supabase database before testing assigned-language behavior in production.
