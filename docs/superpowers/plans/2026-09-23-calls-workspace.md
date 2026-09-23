# Calls Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a main-navigation Calls page where agents see their own inbound/outbound history and admins can view and filter the team history.

**Architecture:** Add one server query with row-level access rules derived from the existing request context, then render it through a server page and focused responsive list component. Reuse existing call, voicemail, lead-link, and dialer components; the page introduces no new Twilio workflow or duplicate call storage.

**Tech Stack:** Next.js App Router, TypeScript, Supabase, React, Tailwind/shadcn, Vitest.

## Global Constraints

- Agents see only calls where `calls.user_id` is their own user ID.
- Admins see all calls and may filter by agent through the URL.
- The page has All, Missed, and Voicemail tabs; URL query state controls tab and agent filter.
- Unknown callers remain visible without a lead. Do not create a lead from a call listing.
- Callback uses the existing call button/dialer flow.
- Mobile uses compact cards; desktop uses a table; all controls have 48px targets.
- Add the page to main navigation for all signed-in users.

---

### Task 1: Add call-history query and access tests

**Files:**
- Modify: `src/server/services/calls.ts`
- Modify: `src/server/actions/calls.ts`
- Create: `tests/unit/server/call-history.test.ts`

**Interfaces:**
- Produces: `listCallHistory(ctx, input): Promise<CallHistoryPage>`
- Input: `{ tab: "all" | "missed" | "voicemail"; agentId?: string; page?: number }`

- [ ] **Step 1: Write failing access tests**

```ts
expect(agentResult.rows.every((row) => row.userId === agent.userId)).toBe(true);
expect(adminResult.rows).toHaveLength(2);
expect(missed.rows.map((row) => row.direction)).toContain("INBOUND");
```

- [ ] **Step 2: Run the focused test**

Run: `npm test -- tests/unit/server/call-history.test.ts`
Expected: failure because `listCallHistory` does not exist.

- [ ] **Step 3: Implement the service**

```ts
export type CallHistoryTab = "all" | "missed" | "voicemail";
export async function listCallHistory(ctx: RequestContext | null, input: unknown) {
  const active = requireActive(ctx);
  // Agent query is constrained to active.userId; admin query accepts a validated agentId.
  // Select call direction, state, duration, lead data, remote number, voicemail state, and agent display name.
}
```

Filter missed to inbound rows without an answered/logged outcome and voicemail to rows with voicemail recording metadata. Return normalized rows with `leadId`, `businessName`, `remoteE164`, `userId`, `agentName`, `direction`, `outcome`, `callStatus`, `durationSeconds`, `createdAt`, and voicemail fields.

- [ ] **Step 4: Add a server action**

```ts
export async function listCallHistoryAction(input: unknown) {
  return actionResult(() => listCallHistory(await getRequestContext(), input));
}
```

- [ ] **Step 5: Run focused verification**

Run: `npm test -- tests/unit/server/call-history.test.ts && npm run typecheck`
Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/calls.ts src/server/actions/calls.ts tests/unit/server/call-history.test.ts
git commit -m "feat: add call history query"
```

### Task 2: Add the Calls page and responsive history list

**Files:**
- Create: `src/app/(app)/calls/page.tsx`
- Create: `src/components/calls/call-history-list.tsx`
- Create: `src/components/calls/call-history-filters.tsx`
- Create: `tests/unit/ui/call-history-list.test.tsx`

**Interfaces:**
- Consumes: `listCallHistory(ctx, { tab, agentId, page })`
- Produces: a Calls route at `/calls?tab=all|missed|voicemail&agent=`

- [ ] **Step 1: Write failing UI tests**

```tsx
expect(rendered).toContain("All");
expect(rendered).toContain("Missed");
expect(rendered).toContain("Voicemail");
expect(rendered).toContain("Unknown caller");
expect(rendered).toContain("Call back");
```

Assert lead rows link to `/leads/<leadId>`, agent filter is absent for agents and available to admins, and card/table controls retain `min-h-12`.

- [ ] **Step 2: Run focused test**

Run: `npm test -- tests/unit/ui/call-history-list.test.tsx`
Expected: failure because the Calls components do not exist.

- [ ] **Step 3: Implement URL parsing and page data loading**

```ts
const tab = ["all", "missed", "voicemail"].includes(searchParams.tab ?? "") ? searchParams.tab : "all";
const history = await listCallHistory(ctx, { tab, agentId: searchParams.agent });
```

Use `requireUserPage()`, then pass user role and rows to presentational components. Preserve selected tab/filter in links.

- [ ] **Step 4: Implement the list**

Desktop rows show direction, person/lead, agent for admins, time, result, duration, voicemail state, and existing `CallButton`. Mobile rows show the same information as cards. Display an empty state explaining that matching calls will appear here.

- [ ] **Step 5: Run focused verification**

Run: `npm test -- tests/unit/ui/call-history-list.test.tsx && npm run typecheck`
Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/(app)/calls/page.tsx src/components/calls tests/unit/ui/call-history-list.test.tsx
git commit -m "feat: add calls workspace"
```

### Task 3: Add navigation, verify, merge to main, and deploy

**Files:**
- Modify: `src/components/app-shell/app-shell.tsx` or its existing navigation data source
- Modify: navigation UI tests if one exists

- [ ] **Step 1: Write failing navigation assertion**

```ts
expect(rendered).toContain('href="/calls"');
expect(rendered).toContain("Calls");
```

- [ ] **Step 2: Run the navigation test**

Run: the focused app-shell test command.
Expected: failure because Calls is not in navigation.

- [ ] **Step 3: Add Calls navigation item**

Place Calls beside Leads and Follow-ups. Use the existing responsive navigation pattern so it appears in desktop sidebar and mobile navigation/More menu.

- [ ] **Step 4: Run final checks**

```bash
npm test -- tests/unit/server/call-history.test.ts tests/unit/ui/call-history-list.test.tsx
npm run typecheck
npm run lint
git diff --check
```

- [ ] **Step 5: Commit and merge**

```bash
git add src/components/app-shell
git commit -m "feat: add calls navigation"
git checkout main
git merge pep-talk
git push origin main
```

- [ ] **Step 6: Deploy and verify**

Wait for Vercel's main-branch production deployment. Open `https://crm-xgjz.vercel.app/calls` and confirm the Calls navigation item, All tab, and empty or populated history render without an error.
