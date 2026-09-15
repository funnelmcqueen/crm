import { describe, expect, it } from "vitest";
import { DIALER_MESSAGES, microphoneErrorMessage, outboundErrorMessage } from "@/lib/dialer/messages";

describe("outboundErrorMessage", () => {
  it.each([
    [404, { error: "not_found" }, "This lead is no longer available"],
    [409, { error: "conflict", reason: "do_not_contact" }, "This lead is marked Do Not Contact"],
    [409, { error: "conflict", reason: "call_in_progress" }, "You already have a call in progress"],
    [409, { error: "conflict" }, DIALER_MESSAGES.startFailed],
    [429, { error: "rate_limited" }, "Too many calls. Wait a moment."],
    [401, null, DIALER_MESSAGES.signedOut],
    [403, "oops", DIALER_MESSAGES.inAppDisabled],
    [503, undefined, DIALER_MESSAGES.inAppUnavailable],
    [500, { error: "internal" }, DIALER_MESSAGES.startFailed],
  ])("%i %j", (status, body, message) => {
    expect(outboundErrorMessage(status, body)).toBe(message);
  });
});

describe("microphoneErrorMessage", () => {
  it("distinguishes a missing microphone from a blocked one", () => {
    expect(microphoneErrorMessage({ name: "NotAllowedError" })).toBe(
      "Microphone blocked. Allow microphone access for this site, or switch Call mode to Phone in Settings.",
    );
    expect(microphoneErrorMessage({ name: "NotFoundError" })).toBe(DIALER_MESSAGES.micMissing);
    expect(microphoneErrorMessage(new Error("x"))).toBe(DIALER_MESSAGES.micBlocked);
    expect(microphoneErrorMessage(undefined)).toBe(DIALER_MESSAGES.micBlocked);
  });
});
