/**
 * Attributes for the Supabase session cookie, shared by every client that owns one: the browser client,
 * the Server Component client, the route-handler client and the proxy.
 *
 * @supabase/ssr never sets `Secure` — its DEFAULT_COOKIE_OPTIONS is `path`, `sameSite`, `httpOnly` and
 * `maxAge` only — so without this the session (a base64 blob holding both the access token and the
 * refresh token) is attached to any plaintext http:// request for the domain: a stray link, a
 * non-preloaded subdomain, or an attacker forcing http on first contact. `httpOnly: false` is inherent
 * to @supabase/ssr, because the browser client has to read the cookie; `Secure` costs nothing.
 *
 * It stays off outside production so that http://localhost keeps working for development and the
 * Playwright suite, which run over plain http.
 */
export function sessionCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV): { secure: boolean } {
  return { secure: nodeEnv === "production" };
}
