# German Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an English/German CRM with an admin-assigned language for every agent and a browser language switcher.

**Architecture:** Store the admin-controlled `primary_locale` in `profiles`; store the user's optional browser override in a `crm_locale` cookie. A typed i18n runtime resolves cookie → assigned language → English, formats locale-sensitive values, and supplies message dictionaries to server and client UI. Translation namespaces isolate independent screen groups so agents can work without editing the same message files.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind, Supabase/Postgres RLS, Zod, Vitest.

## Global Constraints

- Supported language codes are exactly `en` and `de`; English is the fallback.
- `profiles.primary_locale` is admin-only. An agent may choose an optional browser override but cannot change their stored primary language.
- Keep URLs, route/query parameters, statuses, API schemas, CSV headers and user-entered CRM data unchanged.
- Every user-facing control must work at mobile width with German copy; use existing 48px touch-target conventions.
- Existing agent isolation remains enforced in Postgres and server actions. Translation never changes authorization behavior.
- Do not stage the pre-existing unrelated draft documents in `docs/superpowers`.

---

### Task 1: Profile language persistence and admin controls

**Files:**
- Create: `supabase/migrations/20260923002100_profile_locale.sql`
- Modify: `src/lib/database.types.ts`
- Modify: `src/server/context.ts`
- Modify: `src/server/services/agents.ts`
- Modify: `src/server/actions/agents.ts`
- Modify: `src/components/admin/agents/agent-dialogs.tsx`
- Modify: `tests/db/guards.test.ts`
- Modify: `tests/db/schema-contract.test.ts`
- Modify: `tests/unit/settings/agents-settings-logic.test.ts`

**Interfaces:**
- Produces `Locale = "en" | "de"` database value in `profiles.primary_locale` with default `en`.
- Extends agent create/update payloads with `primaryLocale: Locale` and agent summaries with `primaryLocale: Locale`.
- Consumes the existing profile guard trigger and admin-only agent services.

- [ ] **Step 1: Write the database and service contract tests first.**

```ts
expect(profile.primary_locale).toBe("en");
expect(await userRows(db, agentId, "update public.profiles set primary_locale = 'de' where id = $1", [agentId])).toEqual([]);
expect(await userRows(db, adminId, "update public.profiles set primary_locale = 'de' where id = $1 returning primary_locale", [agentId])).toEqual([
  { primary_locale: "de" },
]);
expect(updateAgentProfileSchema.safeParse({ primaryLocale: "fr" }).success).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm the missing column/schema behavior fails.**

Run: `npm test -- tests/db/guards.test.ts tests/db/schema-contract.test.ts tests/unit/settings/agents-settings-logic.test.ts`

Expected: FAIL because `primary_locale` and `primaryLocale` do not exist.

- [ ] **Step 3: Add the additive migration and generated types.**

```sql
alter table public.profiles add column primary_locale text not null default 'en'
  check (primary_locale in ('en', 'de'));
-- Update the existing profile-update guard so ADMIN may change primary_locale;
-- AGENT updates retain the current name-only restriction.
```

Update profile selects, Zod schemas, service patches and create/edit dialogs. Use an existing `Select` with options `English` (`en`) and `Deutsch` (`de`); default create state to `en`.

- [ ] **Step 4: Run focused tests and regenerate/verify types.**

Run: `npm test -- tests/db/guards.test.ts tests/db/schema-contract.test.ts tests/unit/settings/agents-settings-logic.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Review and commit only Task 1 files.**

Run: `git diff --check`

Commit: `git commit -m feat-profile-language`

### Task 2: Locale runtime, cookie override, and shell switcher

**Files:**
- Create: `src/lib/i18n/locales.ts`
- Create: `src/lib/i18n/format.ts`
- Create: `src/lib/i18n/messages/en/core.ts`
- Create: `src/lib/i18n/messages/de/core.ts`
- Create: `src/components/i18n/locale-provider.tsx`
- Create: `src/components/i18n/language-switcher.tsx`
- Create: `src/server/actions/locale.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Modify: `src/components/app-shell/app-shell.tsx`
- Modify: `src/components/app-shell/user-menu.tsx`
- Test: `tests/unit/i18n/locales.test.ts`
- Test: `tests/unit/i18n/format.test.ts`
- Test: `tests/unit/ui/language-switcher.test.tsx`

**Interfaces:**
- Produces `Locale`, `parseLocale(value)`, `resolveLocale({ cookie, primaryLocale })`, `formatDate`, `formatDateTime`, `formatNumber`, and `useTranslations(namespace)`.
- Produces `setLocaleOverrideAction(locale: Locale | null)`, setting/deleting an HTTP-only `crm_locale` cookie with `path: "/"`, `sameSite: "lax"`, and `maxAge: 31_536_000`.
- Consumes `profile.primary_locale` from `requireUserPage()` and provides active locale to all app-shell children.

- [ ] **Step 1: Write failing runtime and UI tests.**

```ts
expect(resolveLocale({ cookie: "de", primaryLocale: "en" })).toBe("de");
expect(resolveLocale({ cookie: "invalid", primaryLocale: "de" })).toBe("de");
expect(formatNumber("de", 12345.6)).toBe("12.345,6");
expect(renderToStaticMarkup(<LanguageSwitcher assignedLocale="de" />)).toContain("Deutsch");
```

- [ ] **Step 2: Run the tests and confirm imports/modules are absent.**

Run: `npm test -- tests/unit/i18n/locales.test.ts tests/unit/i18n/format.test.ts tests/unit/ui/language-switcher.test.tsx`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement typed dictionaries and provider.**

```ts
export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export function resolveLocale(input: { cookie: unknown; primaryLocale: Locale }): Locale {
  return parseLocale(input.cookie) ?? input.primaryLocale;
}
```

Keep each locale namespace in its own English/German pair. The provider applies `document.documentElement.lang` (`en` or `de`) after hydration. Place the switcher in the account menu with English, Deutsch, and “Use assigned language”; its menu items meet the existing `min-h-12` requirement.

- [ ] **Step 4: Translate the app shell and login first.**

Move shell, user-menu and login strings into the `core` dictionary. Set initial app locale from `resolveLocale({ cookie, primaryLocale: profile.primary_locale })` in the authenticated layout; unauthenticated pages use cookie or English.

- [ ] **Step 5: Run verification and commit Task 2.**

Run: `npm test -- tests/unit/i18n/locales.test.ts tests/unit/i18n/format.test.ts tests/unit/ui/language-switcher.test.tsx && npm run typecheck && npm run lint`

Commit: `git commit -m feat-add-locale-runtime`

### Task 3: Translate calling, leads, calls, and follow-up workflows

**Files:**
- Create: `src/lib/i18n/messages/en/workspace.ts`
- Create: `src/lib/i18n/messages/de/workspace.ts`
- Modify: `src/components/dialer/*.tsx`
- Modify: `src/components/leads/*.tsx`
- Modify: `src/components/leads/bulk/*.tsx`
- Modify: `src/components/calls/*.tsx`
- Modify: `src/components/follow-ups/*.tsx`
- Modify: `src/app/(app)/leads/**/*.tsx`
- Modify: `src/app/(app)/calls/page.tsx`
- Modify: `src/app/(app)/follow-ups/page.tsx`
- Test: `tests/unit/ui/workspace-localization.test.tsx`

**Interfaces:**
- Consumes `useTranslations("workspace")`, `formatDateTime(locale, value, timeZone)` and `formatNumber(locale, value)` from Task 2.
- Produces no new database, route or action interfaces.

- [ ] **Step 1: Write failing representative UI tests.**

```tsx
const german = renderToStaticMarkup(<CallHistoryList locale="de" rows={[row]} />);
expect(german).toContain("Eingehend");
expect(german).toContain("Zurückrufen");
expect(renderToStaticMarkup(<LeadStatusSelect locale="de" />)).toContain("Nicht kontaktieren");
```

- [ ] **Step 2: Run the focused test and confirm locale props/messages are absent.**

Run: `npm test -- tests/unit/ui/workspace-localization.test.tsx tests/unit/ui/call-history-list.test.tsx tests/unit/ui/persistent-keypad.test.tsx`

Expected: FAIL with missing localization props or German copy.

- [ ] **Step 3: Translate the complete core sales workflow.**

Replace visible English in lead list/detail, outcome form, persistent keypad, incoming dialog, wrap-up, calls list, voicemail controls, skipped/follow-up queues and bulk dialogs. Use `Intl` helpers for page counts, dates, durations and time-zone labels. Preserve database status/outcome identifiers; map them only at the rendering boundary.

- [ ] **Step 4: Make German layout-safe.**

At mobile widths, ensure rows and action bars wrap rather than clip; retain icon aria-labels and 48px action targets. Keep phone number and lead link behavior unchanged.

- [ ] **Step 5: Run focused verification and commit Task 3.**

Run: `npm test -- tests/unit/ui/workspace-localization.test.tsx tests/unit/ui/call-history-list.test.tsx tests/unit/ui/persistent-keypad.test.tsx && npm run typecheck`

Commit: `git commit -m feat-translate-sales-workspace`

### Task 4: Translate dashboard, pipeline, booking, and settings

**Files:**
- Create: `src/lib/i18n/messages/en/operations.ts`
- Create: `src/lib/i18n/messages/de/operations.ts`
- Modify: `src/components/dashboard/*.tsx`
- Modify: `src/components/pipeline/*.tsx`
- Modify: `src/components/booking/*.tsx`
- Modify: `src/components/settings/*.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`
- Modify: `src/app/(app)/pipeline/page.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Test: `tests/unit/ui/operations-localization.test.tsx`

**Interfaces:**
- Consumes `useTranslations("operations")` and locale formatters from Task 2.
- Produces translated operational screens without changing calendar, audio, dialer, or settings action payloads.

- [ ] **Step 1: Write failing tests for German operational copy and number/date formatting.**

```tsx
expect(renderToStaticMarkup(<TargetBar locale="de" {...goal} />)).toContain("Anrufe");
expect(renderToStaticMarkup(<BookingPanel locale="de" {...props} />)).toContain("Termin buchen");
expect(formatDateTime("de", "2026-09-23T15:00:00Z", "Europe/Berlin")).toMatch(/23\.09\.2026/);
```

- [ ] **Step 2: Run the tests and confirm they fail before implementation.**

Run: `npm test -- tests/unit/ui/operations-localization.test.tsx`

Expected: FAIL because components do not receive or resolve locale text.

- [ ] **Step 3: Translate every visible operational control.**

Translate dashboard targets/setup notices, pipeline filters and movement actions, booking/cancellation, audio/call mode controls, profile, calendar and company settings. Leave IANA timezone identifiers and Google account emails unmodified; translate surrounding labels and explanations.

- [ ] **Step 4: Verify responsive German rendering and commit Task 4.**

Run: `npm test -- tests/unit/ui/operations-localization.test.tsx tests/unit/settings/calendar-section.test.tsx && npm run typecheck`

Commit: `git commit -m feat-translate-operations`

### Task 5: Translate admin tools, import, reports, and error presentation

**Files:**
- Create: `src/lib/i18n/messages/en/admin.ts`
- Create: `src/lib/i18n/messages/de/admin.ts`
- Create: `src/lib/i18n/error-message.ts`
- Modify: `src/components/admin/**/*.tsx`
- Modify: `src/components/import/*.tsx`
- Modify: `src/app/(app)/admin/**/*.tsx`
- Modify: `src/server/errors.ts`
- Modify: client action error presenters that call `toast.error`
- Test: `tests/unit/i18n/error-message.test.ts`
- Test: `tests/unit/ui/admin-localization.test.tsx`

**Interfaces:**
- Consumes `useTranslations("admin")` and `localizeAppError(locale, code, fallbackMessage)`.
- Produces localized standard error-code copy; server error codes and logs remain unchanged English-safe machine values.

- [ ] **Step 1: Write failing error and admin UI tests.**

```ts
expect(localizeAppError("de", "forbidden", "Forbidden")).toBe("Dafür hast du keine Berechtigung.");
expect(localizeAppError("en", "not_found", "Missing")).toBe("We couldn't find that item.");
```

```tsx
expect(renderToStaticMarkup(<AgentDialogs locale="de" {...props} />)).toContain("Primäre Sprache");
expect(renderToStaticMarkup(<ImportWizard locale="de" {...props} />)).toContain("Datei importieren");
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `npm test -- tests/unit/i18n/error-message.test.ts tests/unit/ui/admin-localization.test.tsx`

Expected: FAIL with missing localizer and untranslated labels.

- [ ] **Step 3: Translate admin and import surfaces.**

Translate agent management, phone numbers, reports, CSV import wizard and report-range controls. Add `primaryLocale` to agent dialogs from Task 1. Map stable `AppError` codes to localized messages; retain server-provided specifics only when they describe the user's input and are safe to display.

- [ ] **Step 4: Run focused verification and commit Task 5.**

Run: `npm test -- tests/unit/i18n/error-message.test.ts tests/unit/ui/admin-localization.test.tsx tests/unit/settings/agents-settings-logic.test.ts && npm run typecheck`

Commit: `git commit -m feat-translate-admin-tools`

### Task 6: End-to-end localization audit and release

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEVIATIONS.md` only if an intentional deviation is necessary
- Modify: `README.md` only if locale setup changes an operator workflow
- Test: `e2e/workspace-localization.spec.ts`

**Interfaces:**
- Consumes all completed localization layers.
- Produces a tested English/German application release from `main`.

- [ ] **Step 1: Write the end-to-end regression test.**

```ts
test("an admin assigns German and an agent can switch and reset their browser language", async ({ page }) => {
  await signInAsAdmin(page);
  await setAgentPrimaryLanguage(page, "Deutsch");
  await signInAsAgent(page);
  await expect(page.getByRole("link", { name: "Leads" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Leads", exact: false })).toContainText("Leads");
  await page.getByRole("button", { name: /account menu/i }).click();
  await page.getByRole("menuitem", { name: "English" }).click();
  await expect(page.getByRole("link", { name: "Leads" })).toBeVisible();
});
```

- [ ] **Step 2: Run it in the appropriate Playwright projects and confirm it fails before final wiring.**

Run: `npm run test:e2e -- workspace-localization.spec.ts`

Expected: FAIL until primary language, switcher and translated shell are complete.

- [ ] **Step 3: Audit all visible routes in English and German.**

Review login, dashboard, leads/detail, calls, follow-ups, pipeline, settings, and each admin route at desktop and phone widths. Fix literal English strings in the audited UI, clipped German labels, and missing aria-label translations. Do not translate CRM record content.

- [ ] **Step 4: Run full release verification.**

Run: `npm run verify && npm run build && git diff --check`

Expected: all commands exit 0.

- [ ] **Step 5: Commit, push `main`, apply the migration, and verify production.**

```bash
git add -- <only localization files>
git commit -m feat-add-german-localization
git push origin main
```

Apply `20260923002100_profile_locale.sql` in Supabase, then verify authenticated English and German sessions at `https://crm-xgjz.vercel.app`.
