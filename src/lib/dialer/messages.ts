export const DIALER_MESSAGES = {
  micBlocked: "Microphone blocked. Allow microphone access for this site, or switch Call mode to Phone in Settings.",
  micMissing: "Microphone not found. Connect a microphone, or switch Call mode to Phone in Settings.",
  leadUnavailable: "This lead is no longer available",
  doNotContact: "This lead is marked Do Not Contact",
  callInProgress: "You already have a call in progress",
  rateLimited: "Too many calls. Wait a moment.",
  signedOut: "Your session has ended. Sign in again.",
  inAppDisabled: "In-app calling is turned off for your account. Calls will use your phone.",
  inAppUnavailable: "In-app calling is unavailable right now. Calls will use your phone.",
  startFailed: "Could not start the call. Try again.",
  acceptFailed: "Could not answer the call.",
} as const;

/** User-facing message for a failed POST /api/calls/outbound. */
export function outboundErrorMessage(status: number, body: unknown, messages: { [K in keyof typeof DIALER_MESSAGES]: string } = DIALER_MESSAGES): string {
  const reason =
    typeof body === "object" && body !== null && "reason" in body ? (body as { reason: unknown }).reason : undefined;
  switch (status) {
    case 404:
      return messages.leadUnavailable;
    case 409:
      if (reason === "do_not_contact") return messages.doNotContact;
      if (reason === "call_in_progress") return messages.callInProgress;
      return messages.startFailed;
    case 429:
      return messages.rateLimited;
    case 401:
      return messages.signedOut;
    case 403:
      return messages.inAppDisabled;
    case 503:
      return messages.inAppUnavailable;
    default:
      return messages.startFailed;
  }
}

/** Maps a getUserMedia failure to the message shown before the first in-app call. */
export function microphoneErrorMessage(error: unknown, messages: { [K in keyof typeof DIALER_MESSAGES]: string } = DIALER_MESSAGES): string {
  const name = typeof error === "object" && error !== null && "name" in error ? (error as { name: unknown }).name : "";
  return name === "NotFoundError" || name === "OverconstrainedError" ? messages.micMissing : messages.micBlocked;
}
