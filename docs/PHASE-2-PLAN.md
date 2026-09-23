# Phase 2: calling workflow

Continue the approved Phase 2 handoff on top of Phase 1 (now committed as `ce68ce3`). Keep existing APIs, RLS, provider configuration, call outcomes, and skip behavior.

- [x] Protect lead-note drafts during navigation and failed saves. Recover drafts for the same user and lead in the same tab; clear them on save/sign-out. Test recovery, failure, and navigation cancellation.
- [x] Preserve outcome drafts and interrupted wrap-up across reloads, scoped to user and call, with a 12-hour expiry and server access validation before restoring in-app calls. Keep existing idempotency keys. Warn before closing a live call or unsaved outcome.
- [x] Make current lead, calling mode, last note/call, and next follow-up easy to scan. Explain missing numbers and fallback. Keep the existing desktop/mobile call controls and keyboard shortcuts.
- [x] Confirm successful logging and continue through the existing Next Lead route. Offer Follow-ups and Skipped when the queue is empty; never auto-dial.
- [ ] Run typecheck, lint, unit/database/integration tests, desktop/mobile call journeys, and new failure/recovery browser coverage. Document limitations and stop before Phase 3.

Implementation stays in the existing `phase-1-lead-workspace` branch at the user's requested checkout. No commits or deployment of the user's existing changes.

Verification: native-loader/thread-worker Vitest completed 2,017 unit/database tests (25 existing skips), and 12 calling-service integration tests. The final focused draft/recovery run passed 12 tests. Final TypeScript and root-checkout lint passed; lint excludes the independent `.worktrees/calendar-booking` checkout, which otherwise causes six unrelated import-rule errors. Playwright tests were extended for desktop outcome recovery, failed saves, lead-note navigation and mobile TEL recovery, but cannot launch in this environment (`spawn EPERM`). Browser layout, navigation and interaction verification remains outstanding; do not begin Phase 3 or deploy based on these automated results alone.
