import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

// Supabase CLI default secret; the derived anon/service keys equal the well-known local demo keys.
export const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export const API_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type ApiRole = (typeof API_ROLES)[number];

const secretKey = new TextEncoder().encode(JWT_SECRET);

export function isApiRole(value: unknown): value is ApiRole {
  return typeof value === 'string' && (API_ROLES as readonly string[]).includes(value);
}

export async function signJwt(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(secretKey);
}

export async function signApiKey(role: 'anon' | 'service_role'): Promise<string> {
  return signJwt({ iss: 'supabase-demo', role, exp: 1983812996 });
}

export interface ApiKeys {
  anonKey: string;
  serviceRoleKey: string;
}

export async function createApiKeys(): Promise<ApiKeys> {
  return { anonKey: await signApiKey('anon'), serviceRoleKey: await signApiKey('service_role') };
}

export type JwtVerifyResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: 'expired' | 'invalid'; message: string };

export async function verifyJwt(token: string): Promise<JwtVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'], clockTolerance: 30 });
    return { ok: true, claims: payload as Record<string, unknown> };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired', message: 'JWT expired' };
    }
    const message = error instanceof Error ? error.message : 'invalid JWT';
    return { ok: false, reason: 'invalid', message };
  }
}
