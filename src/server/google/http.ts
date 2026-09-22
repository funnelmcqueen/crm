// Shared Google HTTP timeout + retry plumbing (docs/DEVIATIONS.md D47), used by both
// src/server/google/api.ts (the Calendar/OAuth2 REST calls) and src/server/google/oauth.ts (the
// authorization-code exchange and token revocation), so the 8-second timeout and the one-retry rule live
// in exactly one place. This module never classifies an HTTP status — only a timeout or a connection-level
// failure (fetch's own TypeError) becomes GoogleConnectionFailure; each caller maps that into its own error
// type at the point of use (GoogleApiError in api.ts, ConnectionError in oauth.ts).
import "server-only";

export const GOOGLE_HTTP_TIMEOUT_MS = 8000;

/**
 * Thrown when a Google HTTP call fails at the connection level: a timeout, or fetch's own TypeError for a
 * network failure. Never thrown for an HTTP status Google returned.
 */
export class GoogleConnectionFailure extends Error {
  readonly reason: "timeout" | "connection_error";

  constructor(reason: "timeout" | "connection_error") {
    super(`Google request failed: ${reason}`);
    this.name = "GoogleConnectionFailure";
    this.reason = reason;
  }
}

/** Marks a rejection from the timeout race so requestOnce can tell it apart from a real fetch failure. */
class TimeoutSignal extends Error {}

/**
 * Races a fetch call against a timer so the timeout is driven by plain setTimeout/clearTimeout (mockable
 * with vi.useFakeTimers()) rather than AbortSignal.timeout, whose internal timer several fake-timer
 * implementations (notably on Windows/Node) cannot advance. The AbortController still cancels the
 * underlying request when the timer wins.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutSignal("Google request timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** One attempt: fetch with an 8s timeout, classifying a timeout or connection error as GoogleConnectionFailure. */
async function requestOnce(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  try {
    return await withTimeout(fetch(url, { ...init, signal: controller.signal }), GOOGLE_HTTP_TIMEOUT_MS, controller);
  } catch (err) {
    if (err instanceof TimeoutSignal) throw new GoogleConnectionFailure("timeout");
    if (err instanceof TypeError) throw new GoogleConnectionFailure("connection_error");
    throw err;
  }
}

/** Retries once, only for a connection error or a timeout — never for an HTTP status the server returned. */
export async function requestWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await requestOnce(url, init);
  } catch (err) {
    if (err instanceof GoogleConnectionFailure) return await requestOnce(url, init);
    throw err;
  }
}
