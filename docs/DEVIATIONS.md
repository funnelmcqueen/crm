# Deviations from docs/SPEC.md

Every intentional difference from the spec, with the reason. Append; never delete history.
Format: `## D<n>. Title`, then **Spec**, **Built**, **Why**.

## D1. Tests run against "localbase" instead of `supabase start`
**Spec:** §13 run against local Supabase (`supabase start`).
**Built:** The same `supabase/migrations` run in PGlite (Postgres 18 WASM), behind a PostgREST/GoTrue-compatible
HTTP emulator (`localbase/`). Tests use supabase-js with the anon key and real JWTs from `signInWithPassword`. Setting
`SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` runs the identical suite against a real stack.
**Why:** Docker, WSL and Postgres are not installed on the build machine, and installing them changes system settings.
RLS is still enforced by real Postgres (`SET LOCAL ROLE authenticated` + `request.jwt.claims`), not by the emulator.

## D2. `proxy.ts` instead of `middleware.ts`
**Spec:** §8 "Protect admin routes in middleware".
**Built:** `src/proxy.ts`, which is the same feature under its Next.js 16 name (`middleware` is deprecated).
**Why:** Next.js 16 renamed the convention.

## D3. Sensitive `calls` columns hidden by column grants
**Spec:** §5 agents SELECT calls rows for their leads.
**Built:** The RLS row policy is as specified. In addition, `authenticated` has no SELECT privilege on `user_id`,
`phone_number_id`, `provider_call_sid` or `voicemail_recording_sid`. The app reads call history, voicemails and stats
through SECURITY DEFINER RPCs that re-check access and expose caller names/caller ID to admins only.
**Why:** §5 requires "the new agent never sees who made earlier calls". A row policy cannot hide a column. Admins also
read those columns through RPCs, not direct table selects.

## D4. Schema additions
- `profiles.device_seen_at`: Twilio Device presence heartbeat, used for "if their Device is registered" (§7c).
- `calls.remote_e164`: the other party's number. Unmatched inbound voicemails need a callback number.
- `leads.dedupe_name_key`: generated business+city key for duplicate checks (§9).
- `rate_limit_hits` table + `consume_rate_limit()` RPC: DB-backed rate limits that work across serverless instances (§12).
- `calls.user_id` is nullable, but only for INBOUND admin-only voicemails (§7c "visible to admin only").

## D5. `leads.next_follow_up_at` is always derived
**Spec:** §3 agents may update next follow-up. §4 a trigger keeps it equal to the earliest open follow-up.
**Built:** Agents set the next follow-up by creating or rescheduling follow-ups. A direct write to the column is
recomputed by the trigger, so the §4 invariant can never be broken.

## D6. `log_call` also closes out due work on the lead
**Built:** Logging an outcome marks that lead's unheard voicemails as handled and completes its follow-ups that are already due.
**Why:** Otherwise §7g Next Lead would keep returning the same lead after the agent calls it ("unless a follow-up is due").

## D7. Inbound calls to numbers arrive at the TwiML App Voice URL
**Spec:** §7c numbers point to the TwiML App, whose Voice URL is `/api/twilio/voice/outbound` (§16), and inbound is handled at `/api/twilio/voice/inbound`.
**Built:** `/outbound` treats a non-`client:` caller as inbound and runs the same handler as `/inbound`. `/inbound` also works when a number is pointed at it directly.
