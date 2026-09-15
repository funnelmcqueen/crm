function decodeBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const binary = atob(base64);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The JWT payload object, or null when the key is not a JWT (e.g. an opaque publishable key). Not verified. */
function jwtPayload(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  const json = decodeBase64Url(parts[1]);
  if (json === null) return null;
  try {
    const payload: unknown = JSON.parse(json);
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * True for a key that must never be shipped to browsers as NEXT_PUBLIC_SUPABASE_ANON_KEY: a secret
 * (`sb_secret_…`) key, or a JWT whose role is anything but `anon` (a service_role key bypasses RLS).
 */
export function isUnsafePublicSupabaseKey(key: string): boolean {
  const value = key.trim();
  if (value.startsWith("sb_secret_")) return true;
  const payload = jwtPayload(value);
  return payload !== null && payload.role !== "anon";
}
