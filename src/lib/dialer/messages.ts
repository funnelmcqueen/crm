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
export function outboundErrorMessage(status: number, body: unknown): string {
  const reason =
    typeof body === "object" && body !== null && "reason" in body ? (body as { reason: unknown }).reason : undefined;
  switch (status) {
    case 404:
      return DIALER_MESSAGES.leadUnavailable;
    case 409:
      if (reason === "do_not_contact") return DIALER_MESSAGES.doNotContact;
      if (reason === "call_in_progress") return DIALER_MESSAGES.callInProgress;
      return DIALER_MESSAGES.startFailed;
    case 429:
      return DIALER_MESSAGES.rateLimited;
    case 401:
      return DIALER_MESSAGES.signedOut;
    case 403:
      return DIALER_MESSAGES.inAppDisabled;
    case 503:
      return DIALER_MESSAGES.inAppUnavailable;
    default:
      return DIALER_MESSAGES.startFailed;
  }
}

/** Maps a getUserMedia failure to the message shown before the first in-app call. */
export function microphoneErrorMessage(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? (error as { name: unknown }).name : "";
  return name === "NotFoundError" || name === "OverconstrainedError" ? DIALER_MESSAGES.micMissing : DIALER_MESSAGES.micBlocked;
}
