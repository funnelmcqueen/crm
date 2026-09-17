# Call Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the revised March restaurant callback script in every lead workspace so callers can follow the next step, answer objections, and finish booked calls without leaving the CRM.

**Architecture:** Keep the first release read-only and client-safe. A pure domain module owns the versioned playbook content and the small personalization helper; a server-rendered lead component presents it with native disclosure controls, keeping the lead page fast and usable without JavaScript. The existing lead page supplies contact context. Future campaign assignment and admin editing can replace the module without changing the panel interface.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components, TypeScript strict, Tailwind, Vitest.

## Global Constraints

- Keep the existing RLS, lead schema, RPCs, call outcomes, and dialer flow unchanged.
- Render the script only from client-safe, versioned source data; never expose server-only data.
- Preserve 48px interactive touch targets from SPEC §11.
- All claims in the script must be factual and avoid unsupported guarantees.

---

### Task 1: Define the March restaurant playbook as pure domain data

**Files:**
- Create: `src/lib/domain/call-playbook.ts`
- Test: `tests/unit/domain/call-playbook.test.ts`

**Interfaces:**
- Produces: `MARCH_RESTAURANT_PLAYBOOK`, a frozen playbook with `id`, `version`, `title`, `stages`, `objections`, `bookingHandoff`, and `guardrails`.
- Produces: `playbookGreeting(contactName: string | null): string` for a safe, first-name-only opener.

- [ ] **Step 1: Write the failing test**

```ts
import { MARCH_RESTAURANT_PLAYBOOK, playbookGreeting } from "@/lib/domain/call-playbook";

it("keeps the March callback playbook versioned and gives callers a safe personalized opening", () => {
  expect(MARCH_RESTAURANT_PLAYBOOK.version).toBe("v3");
  expect(MARCH_RESTAURANT_PLAYBOOK.stages.map((stage) => stage.id)).toEqual(["open", "hook", "offer", "ask", "booked"]);
  expect(playbookGreeting("Marco Rossi")).toContain("Marco");
  expect(playbookGreeting(null)).not.toContain("null");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/domain/call-playbook.test.ts`

Expected: failure because `call-playbook` does not exist. If the environment cannot spawn Vitest, record that exact infrastructure limitation and continue the red-green sequence when the runner is available.

- [ ] **Step 3: Write the minimal implementation**

Create the frozen data module. Include the reviewed v3 opening, delivery-platform hook, value statement, two-time booking ask, post-booking questions, booking/no-show handoff, price, website, delivery, busy, location, email, and decline responses. Keep the script's guardrails beside its content.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/domain/call-playbook.test.ts`

Expected: PASS.

### Task 2: Render a compact, accessible Call Playbook panel

**Files:**
- Create: `src/components/leads/call-playbook.tsx`
- Modify: `src/app/(app)/leads/[id]/page.tsx`
- Test: `tests/unit/ui/call-playbook.test.ts`

**Interfaces:**
- Consumes: `MARCH_RESTAURANT_PLAYBOOK` and `playbookGreeting()` from Task 1.
- Produces: `<CallPlaybook contactName={string | null} />`, a server component that needs no browser state.

- [ ] **Step 1: Write the failing test**

```ts
it("makes the five call stages, booking handoff, and objection responses available from the lead page", () => {
  expect(playbook).toContain('aria-label="Call playbook"');
  for (const label of ["Open", "Hook", "Offer", "Ask", "After booking", "Objections", "No-show recovery"]) {
    expect(playbook).toContain(label);
  }
  expect(page).toContain("<CallPlaybook contactName={lead.contactName} />");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/ui/call-playbook.test.ts`

Expected: failure because the component and page integration do not exist.

- [ ] **Step 3: Write the minimal implementation**

Create a server-rendered card immediately after “Before you call.” Show the opening line and five stage cards in order. Use native `<details>` disclosures for stages and objections, with the booking handoff and no-show recovery visible without scrolling through unrelated content. Use `min-h-12` summaries and clear labels; do not add a new dependency or client-side state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/ui/call-playbook.test.ts`

Expected: PASS.

### Task 3: Record scope and verify the feature

**Files:**
- Modify: `docs/DEVIATIONS.md`
- Modify: `docs/superpowers/plans/2026-09-17-call-playbook.md`

**Interfaces:**
- Documents: the initial read-only global playbook and its future replacement seam for campaign assignment and admin editing.

- [ ] **Step 1: Add the deviation note**

Document that campaign assignment and admin editing are deferred intentionally: the initial March callback playbook is a versioned, code-owned panel rendered for every lead workspace, with no new database table or permissions surface.

- [ ] **Step 2: Run focused verification**

Run: `npm run typecheck`, `npm run lint`, `npm run test:unit`, and `npm run build`.

Expected: each command exits 0. If an environment-level `spawn EPERM` prevents a command from starting, retain the complete command output and report it as a verification limitation.

- [ ] **Step 3: Review the diff**

Run: `git diff --check` and `git diff --stat`.

Expected: no whitespace errors; only the playbook, lead page, tests, plan, and deviation documentation change.
