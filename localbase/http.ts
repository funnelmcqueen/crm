import type { IncomingHttpHeaders } from 'node:http';

export interface LbRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  /** Raw request body as UTF-8 text ('' when absent). */
  body: string;
}

export interface LbResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export function header(req: LbRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

export function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): LbResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(value),
  };
}

export const CORS_ALLOW_HEADERS = [
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  'x-supabase-api-version',
  'x-retry-count',
  'prefer',
  'range',
  'range-unit',
  'accept',
  'accept-profile',
  'content-profile',
  'baggage',
  'sentry-trace',
  'traceparent',
  'tracestate',
].join(', ');

export function corsHeaders(req: LbRequest): Record<string, string> {
  const origin = header(req, 'origin');
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': header(req, 'access-control-request-headers') ?? CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers':
      'Content-Range, Content-Location, Preference-Applied, X-Total-Count, Link, X-Supabase-Api-Version',
    'Access-Control-Max-Age': '600',
    ...(origin ? { Vary: 'Origin' } : {}),
  };
}

export function bearerToken(req: LbRequest): { present: boolean; token: string | null } {
  const value = header(req, 'authorization');
  if (value === undefined) return { present: false, token: null };
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return { present: true, token: match ? match[1] : null };
}
