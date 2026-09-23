# German Localization Design

## Goal

Let every CRM user work in English or German. An admin assigns each user's primary language; a signed-in user may temporarily switch the current browser without changing that admin-controlled default.

## Scope

Translate the authenticated CRM and login experience: navigation, page headings, dashboards, leads, calls, follow-ups, pipeline, dialer controls, booking, imports, settings, admin tools, forms, dialogs, validation and user-facing errors. Format dates, times and numbers for the active language. Do not translate business names, contacts, lead notes, imported fields, call notes, or other user-entered CRM data.

## Language model

- Supported language codes are `en` and `de`; `en` is the fallback.
- `profiles.primary_locale` stores the admin-controlled primary language and defaults to `en` for every existing and new user.
- Only an admin can alter `primary_locale`, through agent create and edit forms. Agents cannot update it through direct database calls or server actions.
- A `crm_locale` cookie stores an optional browser override chosen with the language switcher. It is HTTP-only, `SameSite=Lax`, scoped to `/`, and lasts one year.
- Locale resolution is: valid `crm_locale` cookie, then authenticated profile `primary_locale`, then `en`.
- Signing out does not need to erase the cookie; it contains only a language code. An admin's updated primary language takes effect on the next browser session without an override, or immediately when the user selects “Use my assigned language” in the switcher.

## Application architecture

- A small server-safe localization module owns the locale union, validation, locale resolution and `Intl` formatting helpers.
- Typed English and German dictionaries use the same message-key shape. UI code obtains copy from a locale provider/hook rather than branching on language strings.
- The app layout resolves the language before rendering, sets `<html lang>`, and supplies a client locale provider for interactive components.
- The language switcher is available in the shell's header/user menu on desktop and mobile. It offers English, Deutsch, and an assigned-language reset.
- Server actions keep stable machine error codes. Presentation maps those codes and Zod/validation copy to localized messages at the closest user-facing layer. Security, authorization and database behavior remain language-independent.
- Existing route paths, query keys, database statuses, CSV headers and API contracts remain stable. The browser's locale changes display copy and formatting only.

## Admin and profile behavior

- Agent creation defaults Primary language to English and submits it with existing agent profile fields.
- Agent editing shows Primary language beside time zone and daily call target.
- Agent listings and activity can display the assigned language where the existing data model makes it useful; it is not a new filter or role capability.
- The profile update guard and generated database types include `primary_locale`. The database trigger permits only admins to change it, matching existing role/target/time-zone protections.

## Responsive and accessibility requirements

- The switcher has a text label and selected-language indicator, is keyboard operable, and has a 48px mobile target.
- German labels may be longer. Tabs, buttons, list actions, tables and dialogs must wrap or reflow instead of clipping; compact mobile controls keep an accessible label.
- Screen reader labels, live errors and empty states are translated together with visible text.

## Verification

- Database tests prove `primary_locale` defaults to `en`, admins can set `en`/`de`, agents cannot change their own or another user's primary language, and invalid values are rejected.
- Unit tests cover locale parsing, cookie/profile/fallback resolution, German date/number formatting and dictionary shape parity.
- UI tests cover switcher interaction, `<html lang>`, agent language selection and representative English/German copy on mobile and desktop.
- Regression tests cover the existing primary call, lead, follow-up, and admin paths under both locales; full typecheck, lint, test and production build run before release.
