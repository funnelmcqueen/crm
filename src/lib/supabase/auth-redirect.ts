export const LOGIN_PATH = "/login";
export const DEFAULT_AUTHENTICATED_PATH = "/dashboard";

/**
 * Pages reachable without a session. Everything else under the proxy matcher requires one.
 *
 * `/privacy` and `/terms` are public because Google will not publish an OAuth consent screen whose privacy
 * policy and terms links need a login to read, and its reviewers fetch both while signed out.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

export function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Validates a post-login `next` target. Only same-origin absolute paths are accepted, which blocks
 * open redirects such as `//evil.com`, `/\evil.com` and `https://evil.com`.
 */
export function safeNextPath(raw: unknown, fallback: string = DEFAULT_AUTHENTICATED_PATH): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || hasControlOrBackslash(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, "http://internal.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://internal.invalid") return fallback;
  // Dot segments can normalize into a protocol-relative path: "/..//evil.com" becomes "//evil.com".
  if (url.pathname.startsWith("//") || isPublicPath(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
