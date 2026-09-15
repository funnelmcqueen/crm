// SPEC 13 isolation checks that go through Next.js route handlers or Twilio webhooks. They are
// tracked here until the stage that builds each route implements them (tests/routes/** or here).
import { describe, it } from 'vitest';

describe('route-level agent isolation (pending later stages)', () => {
  it.todo("Agent A cannot stream B's voicemail through GET /api/voicemail/[callId] (404, same as a missing id) (stage 5)");
  it.todo("Agent A cannot create an outbound call for B's lead through POST /api/calls/outbound (404) (stage 4)");
  it.todo("the outbound webhook refuses to dial B's lead when the Twilio identity does not match calls.user_id (stage 4)");
  it.todo('the outbound webhook refuses to dial a DO_NOT_CONTACT lead even with a valid pre-created call row (stage 4)');
  it.todo('the outbound webhook refuses a pre-created row whose outcome was already logged, so logged rows cannot be dialed alongside a live call (stage 4)');
  it.todo("Agent A cannot export B's leads through GET /api/leads/export (only own rows, no assigned agent column) (stage 9)");
  it.todo('a disabled agent with a still-valid session cannot get a Twilio token from POST /api/voice/token (stage 4)');
  it.todo('after reassignment A -> B, an inbound callback from that lead routes to B and never rings A (stage 5)');
  it.todo("an inbound call from B's lead never rings A, even when it arrives on a shared pool number (stage 5)");
});
