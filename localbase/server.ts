import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { handleAuth } from './auth';
import { createDatabase } from './db';
import { bearerToken, corsHeaders, header, jsonResponse, type LbRequest, type LbResponse } from './http';
import { JWT_SECRET, createApiKeys, isApiRole, verifyJwt, type ApiKeys } from './jwt';
import { AsyncMutex } from './mutex';
import { handleRest, type RestAuth } from './rest';

export interface StartLocalbaseOptions {
  /** 0 picks a random free port. Default 54321. */
  port?: number;
  /** Persistent storage directory. Omit for in-memory. */
  dataDir?: string;
  /** Default 'supabase/migrations'. */
  migrationsDir?: string;
  silent?: boolean;
  /** Bind address. Default 127.0.0.1. */
  host?: string;
}

export interface Localbase {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
  /** Raw PGlite handle (runs as postgres). Do not use it while HTTP requests are in flight. */
  db: PGlite;
  stop(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_ROWS = 1000;

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function restJwtError(code: string, message: string): LbResponse {
  return jsonResponse(
    401,
    { code, details: null, hint: null, message },
    { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${message.replace(/"/g, "'")}"` },
  );
}

/** Kong-like key check + PostgREST JWT role resolution. */
async function resolveRestAuth(req: LbRequest): Promise<RestAuth | LbResponse> {
  const { present, token } = bearerToken(req);
  if (!present) return { role: 'anon', claims: { role: 'anon' } };
  if (!token) return restJwtError('PGRST301', 'Expected Authorization: Bearer <token>');
  const verified = await verifyJwt(token);
  if (!verified.ok) {
    return verified.reason === 'expired'
      ? restJwtError('PGRST303', 'JWT expired')
      : restJwtError('PGRST301', 'JWSError JWSInvalidSignature');
  }
  // PostgREST 12: a verified token without a role claim runs as db-anon-role, and an authenticated
  // token without sub runs as authenticated with auth.uid() null (policies must then match nothing).
  const role = verified.claims.role === undefined ? 'anon' : verified.claims.role;
  if (!isApiRole(role)) return restJwtError('PGRST301', 'JWT role claim is not an allowed API role');
  return { role, claims: verified.claims };
}

export async function startLocalbase(options: StartLocalbaseOptions = {}): Promise<Localbase> {
  const silent = options.silent ?? false;
  const log = silent ? () => undefined : (message: string) => console.log(`[localbase] ${message}`);
  const host = options.host ?? '127.0.0.1';
  const db = await createDatabase({ dataDir: options.dataDir, migrationsDir: options.migrationsDir, log });
  const keys: ApiKeys = await createApiKeys();
  const mutex = new AsyncMutex();
  let baseUrl = '';

  const restDeps = { db, mutex, maxRows: MAX_ROWS, log };
  const authDeps = { db, mutex, baseUrl: () => baseUrl, log };

  async function route(req: LbRequest): Promise<LbResponse> {
    const path = req.url.pathname;
    const isRest = path === '/rest/v1' || path.startsWith('/rest/v1/');
    const isAuth = path === '/auth/v1' || path.startsWith('/auth/v1/');
    if (!isRest && !isAuth) return jsonResponse(404, { message: 'no Route matched with those values' });

    const apikey = header(req, 'apikey');
    if (!apikey) return jsonResponse(401, { message: 'No API key found in request' });
    if (apikey !== keys.anonKey && apikey !== keys.serviceRoleKey) {
      return jsonResponse(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    }
    if (isAuth) return handleAuth(req, authDeps);
    const auth = await resolveRestAuth(req);
    if ('status' in auth) return auth;
    return handleRest(req, auth, restDeps);
  }

  async function onRequest(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = (nodeReq.method ?? 'GET').toUpperCase();
    let response: LbResponse;
    let lbReq: LbRequest | null = null;
    try {
      const body = await readBody(nodeReq);
      lbReq = { method, url: new URL(nodeReq.url ?? '/', 'http://localbase.invalid'), headers: nodeReq.headers, body };
      response = method === 'OPTIONS' ? { status: 204, headers: {} } : await route(lbReq);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        response = jsonResponse(413, { message: 'Request body too large' });
      } else {
        log(`unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        response = jsonResponse(500, { message: 'localbase internal error' });
      }
    }
    const headers = { ...(lbReq ? corsHeaders(lbReq) : {}), ...response.headers };
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(response.status, headers);
      nodeRes.end(method === 'HEAD' || response.body === undefined ? undefined : response.body);
    }
    log(`${method} ${nodeReq.url ?? ''} ${response.status} ${Date.now() - started}ms`);
  }

  const server = createServer((req, res) => {
    void onRequest(req, res);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 54321, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  const address = server.address() as AddressInfo;
  baseUrl = `http://${host}:${address.port}`;
  log(`listening on ${baseUrl}`);

  let stopped: Promise<void> | null = null;
  return {
    url: baseUrl,
    anonKey: keys.anonKey,
    serviceRoleKey: keys.serviceRoleKey,
    jwtSecret: JWT_SECRET,
    db,
    stop() {
      stopped ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await mutex.idle();
        await db.close();
      })();
      return stopped;
    },
  };
}
