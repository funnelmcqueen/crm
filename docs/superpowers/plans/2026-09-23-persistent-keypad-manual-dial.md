# Persistent Keypad and Manual Dial Implementation Plan

> **For the implementing agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Add a persistent Keypad button for every signed-in CRM user. It must call an entered number, retain in-call DTMF, and log manual calls without creating a lead.

**Architecture:** Preserve the lead-only outbound endpoint and all of its authorization. Add a separate manual call endpoint and database RPC that normalizes a manually entered number and writes an outbound `calls` row with no lead. In-app manual calls use the existing Twilio device and webhook lifecycle. Phone-mode calls create a row before opening `tel:`; the return outcome is saved against its server call ID. Render one client keypad component inside `DialerProvider` so every application route shares the existing one-call state machine.

**Tech stack:** Next.js App Router, React, TypeScript, Tailwind/shadcn Sheet, Supabase Postgres RPC/RLS, Twilio Voice SDK/TwiML, Vitest.

**Rules applying to every task:**
- Preserve `POST /api/calls/outbound` and `create_outbound_call(uuid)` as lead-only. Lead ownership, status, and DNC checks stay unchanged.
- Normalize user input with `normalizePhone(raw, "US")` and reject it before call creation if it is invalid.
- Store manual calls as `direction = 'OUTBOUND'`, `user_id = auth.uid()`, `lead_id = null`, `mode`, and `remote_e164`; do not create a lead.
- Preserve the one-active-call guard and `outbound_call` rate limit.
- Keep assigned caller-ID allocation and the final Twilio destination exclusively server-side.
- Support 320px screens, iOS safe areas, and 48px touch targets.

## Task 1: Create manual call records safely

**Files:**
- Create: `supabase/migrations/20260923001900_manual_dialer.sql`
- Modify: `src/lib/database.types.ts`
- Modify: the repository's RPC/permission test fixture if present

**Step 1: Add database assertions before the migration**

Cover an active authenticated user creating a manual call, and assert that its row has the current user, a null lead, and normalized E.164 destination.

```sql
select public.create_manual_outbound_call('+12125550123', 'IN_APP');
select direction, mode, user_id, lead_id, remote_e164
from public.calls where id = :created_call_id;
```

Assert invalid destinations and a second live outbound call are refused. Assert that `anon` and `public` cannot execute the RPC; authenticated users can; the function is `security definer` with `set search_path = ''`.

**Step 2: Add an additive migration**

Do not edit applied migrations. First replace the checked constraint after verifying its existing name:

```sql
alter table public.calls drop constraint calls_outbound_has_owner_and_lead;
alter table public.calls add constraint calls_outbound_has_owner_and_destination
  check (
    direction = 'INBOUND'
    or (user_id is not null and (lead_id is not null or remote_e164 is not null))
  );
```

Then create `public.create_manual_outbound_call(p_remote_e164 text, p_mode public.call_mode) returns uuid`.

1. Require `auth.uid()` and lock/read the active profile. Refuse inactive users and refuse `IN_APP` if `in_app_calling_enabled` is false.
2. Permit only `IN_APP` and `TEL`; validate the E.164 value with the same SQL pattern as `calls.remote_e164`.
3. Reuse the per-user advisory lock, live-call conflict check, stale unclaimed-in-app cleanup, and `apply_rate_limit(v_uid, 'outbound_call')` behavior from `create_outbound_call`.
4. Insert the no-lead outbound row and return its ID.
5. Revoke execution from `public` and `anon`; grant only `authenticated` and `service_role`.

**Step 3: Generate types and check**

Run the documented Supabase type generation. Confirm the generated `create_manual_outbound_call` function argument and result types exactly match the server call.

```powershell
npm run typecheck
```

## Task 2: Add the guarded HTTP and Twilio manual-call path

**Files:**
- Modify: `src/server/http/voice.ts`
- Create: `src/app/api/calls/manual-outbound/route.ts`
- Modify: `src/server/http/twilio/outbound.ts`
- Modify: `tests/routes/calls-outbound.test.ts`
- Modify: `tests/routes/twilio-outbound.test.ts`
- Modify: `tests/routes/twilio-outbound-live-call.test.ts`

**Step 1: Write endpoint and webhook tests**

Test:

```ts
await POST(jsonRequest({ phone: "(212) 555-0123", mode: "IN_APP" }));
// 200 and the RPC receives "+12125550123", "IN_APP"

await POST(jsonRequest({ phone: "not a number", mode: "IN_APP" }));
// validation response, RPC not called

await POST(jsonRequest({ phone: "+12125550123", mode: "other" }));
// validation response
```

Also test existing authentication/origin behavior. Add webhook tests where a manual record dials `remote_e164`, while expired, already-claimed, wrong-identity, disabled-user, or invalid-destination records are refused. Existing lead records must retain all assignment, status/DNC, and phone validations.

**Step 2: Implement the manual route**

In `src/server/http/voice.ts`, add `handleManualCallsOutbound` using:

```ts
const manualOutboundBodySchema = z.object({
  phone: z.string().trim().min(1).max(100),
  mode: z.enum(["IN_APP", "TEL"]),
});
```

Apply the same session, origin/CSRF, JSON error, and error-mapping conventions as `handleCallsOutbound`. Normalize with `normalizePhone(body.phone, "US")`; return validation without the RPC on failure. Call the new RPC using only normalized E.164 and return `{ callId }`. Add the thin POST App Route wrapper.

**Step 3: Update Twilio destination lookup**

In `respondOutbound`, select `remote_e164`. Retain every shared check: age, mode, direction, unused row, user ownership, Twilio client identity, active profile, server caller ID claim, and atomic one-time update.

```ts
const destination = call.lead_id === null
  ? (isE164(call.remote_e164) ? call.remote_e164 : null)
  : await resolveAuthorizedLeadDestination(call.lead_id, call.user_id, profile);
if (!destination) return refuse(/* explicit refusal reason */);
```

Do not query or create a lead for a manual row. Send only this database-resolved destination to `outboundDialTwiml`.

**Step 4: Run focused checks**

```powershell
npm test -- tests/routes/calls-outbound.test.ts tests/routes/twilio-outbound.test.ts tests/routes/twilio-outbound-live-call.test.ts
npm run typecheck
```

## Task 3: Support manual browser and phone calls in the dialer state

**Files:**
- Modify: `src/lib/dialer/types.ts`
- Modify: `src/lib/dialer/state.ts`
- Modify: `src/lib/dialer/drivers/tel.ts`
- Modify: `src/components/dialer/dialer-context.tsx`
- Modify: `src/components/dialer/dialer-provider.tsx`
- Modify: `tests/unit/dialer/state.test.ts`
- Modify: `tests/unit/dialer/tel-and-skip.test.ts`
- Create: `tests/unit/dialer/manual-dial.test.ts`

**Step 1: Write reducer/provider tests**

Cover manual IN_APP idle -> preparing -> ringing/in-call -> wrap-up with `leadId: null`; manual TEL pending and reload restore; ignored start attempts while the dialer is non-idle; and failed endpoint results returning state to idle. Assert no lead is created or selected.

**Step 2: Generalize target and TEL persistence**

Add:

```ts
export interface ManualDialTarget {
  phone: string; // raw keypad value, validated by the server
  label: string; // formatted user-facing display
}
```

Permit `tel-pending` and `PendingTel` to hold `leadId: null`. Add server-created `callId: string` to manual TEL pending data. Preserve safe parsing/restoration of legacy lead data and discard malformed data. Carry this call ID through `TEL_START` and `WrapUp`, so `logCall` uses the existing `p_call_id` path for the no-lead record.

**Step 3: Expose and implement manual methods**

```ts
startManualCall(target: ManualDialTarget): Promise<void>;
beginManualTelCall(target: ManualDialTarget): Promise<boolean>;
```

Use a private helper to require idle/non-recovery state, POST the target/mode, verify the UUID response, and return it with a display label.

`startManualCall` requests mic access, creates the IN_APP row, dispatches `OUTBOUND_START` with `leadId: null`, then reuses the current driver callbacks, cancellation, and status recheck. `beginManualTelCall` creates the TEL row before saving pending storage and dispatching `TEL_START`; it returns true only when it is safe for the component to open `tel:`. Return-to-outcome saves against call ID.

**Step 4: Run focused checks**

```powershell
npm test -- tests/unit/dialer/state.test.ts tests/unit/dialer/tel-and-skip.test.ts tests/unit/dialer/manual-dial.test.ts
npm run typecheck
```

## Task 4: Build and mount the persistent keypad

**Files:**
- Create: `src/components/dialer/persistent-keypad.tsx`
- Modify: `src/components/dialer/keypad.tsx`
- Modify: `src/components/dialer/in-call-bar.tsx`
- Modify: `src/components/dialer/dialer-provider.tsx`
- Create: `tests/unit/ui/persistent-keypad.test.tsx`
- Modify: `tests/unit/ui/call-readiness.test.tsx` if needed for rendering

**Step 1: Write UI tests**

Assert a labelled persistent Keypad launcher when idle; idle controls for display, digits, star, pound, Backspace, Close, and Call; valid entry starts the correct in-app or TEL flow; invalid entry cannot start; active DTMF invokes `sendDigits`; and all buttons have 48px-equivalent targets and safe-area padding.

**Step 2: Reuse keypad rendering**

Keep `Keypad` as the connected-call DTMF surface. Extract its key grid only if needed to prevent divergent layouts and labels. DTMF remains available only after connection.

**Step 3: Implement `PersistentKeypad`**

Use `useDialer()` to:
- render a fixed launcher above `--bottom-nav-height` on mobile and clear of desktop navigation;
- show a bottom Sheet on mobile and a constrained side/dialog layout at larger widths;
- accept keypad entry, keyboard input, paste, and Backspace; show a formatted preview only when normalization succeeds;
- await `startManualCall` for in-app, or await `beginManualTelCall` before setting `window.location.href = "tel:" + encodedNormalizedNumber`;
- close only after success, announce errors accessibly, and hide/disable while any call state is active.

Mount it once inside `DialerProvider` beside the current overlays and after `{children}`, without adding route-by-route buttons or changing `AppShell`.

**Step 4: Verify responsive layout**

Inspect 320px, 390px with iPhone safe area, tablet, and desktop sidebar widths. Confirm live `InCallBar` is never obscured.

```powershell
npm test -- tests/unit/ui/persistent-keypad.test.tsx tests/unit/ui/call-readiness.test.tsx
npm run typecheck
```

## Task 5: Complete verification and deploy

**Files:**
- Modify the existing voice setup documentation only if it must explain assigned caller IDs and call modes
- Modify `docs/DEVIATIONS.md` only for an intentional approved departure

**Step 1: Run final verification**

```powershell
npm test
npm run typecheck
npm run lint
git diff --check
```

If the browser harness is available, test mock-driver manual in-app dialling, TEL return-to-outcome, lead call DTMF, and an idle inbound ring.

**Step 2: Check security and deployment**

Confirm no-lead outbound records always have owner/destination, the RPC excludes `anon` and `public`, Twilio only dials the server-created destination, and manual numbers are normalized before the database.

Deploy in this order:
1. Apply the Supabase migration in production.
2. Confirm current Twilio variables and phone-number assignments.
3. Deploy the application.
4. Test an inbound call and a non-production manual outbound call.
5. On iPhone, verify Phone call mode, persistent Keypad, and return-to-outcome.

**Step 3: Report results**

Report exact commands and outcomes. If browser/Vitest process spawning is blocked locally, say so plainly and do not describe blocked tests as passed.

