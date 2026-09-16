import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { compare, hash } from 'bcryptjs';
import { bearerToken, header, jsonResponse, type LbRequest, type LbResponse } from './http';
import { ACCESS_TOKEN_TTL_SECONDS, signJwt, verifyJwt } from './jwt';
import type { AsyncMutex } from './mutex';

export interface AuthDeps {
  db: PGlite;
  mutex: AsyncMutex;
  /** Public base URL of this localbase instance (no trailing slash). */
  baseUrl: () => string;
  log: (message: string) => void;
  /** GoTrue's refresh token reuse interval. */
  refreshTokenReuseIntervalSeconds?: number;
}

const API_VERSION = '2024-01-01';
const BCRYPT_COST = 10;
const MIN_PASSWORD_LENGTH = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

function authErrorResponse(req: LbRequest, error: AuthHttpError): LbResponse {
  const requested = header(req, 'x-supabase-api-version');
  const versioned = requested !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= API_VERSION;
  const body = versioned
    ? { code: error.errorCode, message: error.message, ...error.extra }
    : { code: error.status, error_code: error.errorCode, msg: error.message, ...error.extra };
  return jsonResponse(error.status, body, { 'X-Supabase-Api-Version': API_VERSION });
}

function ok(status: number, value: unknown, headers: Record<string, string> = {}): LbResponse {
  return jsonResponse(status, value, { 'X-Supabase-Api-Version': API_VERSION, ...headers });
}

type Json = Record<string, unknown>;

interface UserRow {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: string | null;
  invited_at: string | null;
  confirmation_sent_at: string | null;
  recovery_sent_at: string | null;
  email_change: string | null;
  email_change_sent_at: string | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Json | null;
  raw_user_meta_data: Json | null;
  created_at: string | null;
  updated_at: string | null;
  phone: string | null;
  phone_confirmed_at: string | null;
  confirmed_at: string | null;
  banned_until: string | null;
  deleted_at: string | null;
  is_anonymous: boolean;
}

interface LoadedUser {
  row: UserRow;
  banned: boolean;
  identities: Json[];
}

type Db = Pick<PGlite, 'query'>;

async function authTx<T>(deps: AuthDeps, work: (q: Db) => Promise<T>): Promise<T> {
  return deps.mutex.run(async () => {
    const db = deps.db;
    await db.query('BEGIN');
    let finished = false;
    try {
      await db.query('SET LOCAL ROLE supabase_auth_admin');
      await db.query(`select set_config('search_path', 'auth', true)`);
      const value = await work(db);
      await db.query('COMMIT');
      finished = true;
      return value;
    } finally {
      if (!finished) await db.query('ROLLBACK').catch(() => undefined);
    }
  });
}

async function loadUser(q: Db, where: 'id' | 'email' | 'phone', value: string): Promise<LoadedUser | null> {
  const column = { id: 'u.id', email: 'lower(u.email)', phone: 'u.phone' }[where];
  const param = where === 'email' ? value.toLowerCase() : value;
  const result = await q.query<{ j: string; banned: boolean }>(
    `select row_to_json(u)::text as j, coalesce(u.banned_until > now(), false) as banned
       from auth.users u where ${column} = $1 and u.deleted_at is null limit 1`,
    [param],
  );
  const found = result.rows[0];
  if (!found) return null;
  const row = JSON.parse(found.j) as UserRow;
  const identities = await q.query<{ j: string }>(
    `select coalesce(json_agg(i order by i.created_at), '[]')::text as j from auth.identities i where i.user_id = $1`,
    [row.id],
  );
  return { row, banned: found.banned, identities: JSON.parse(identities.rows[0].j) as Json[] };
}

function userJson(user: LoadedUser): Json {
  const u = user.row;
  const out: Json = {
    id: u.id,
    aud: u.aud ?? 'authenticated',
    role: u.role ?? 'authenticated',
    email: u.email ?? '',
  };
  if (u.email_confirmed_at) out.email_confirmed_at = u.email_confirmed_at;
  out.phone = u.phone ?? '';
  if (u.phone_confirmed_at) out.phone_confirmed_at = u.phone_confirmed_at;
  if (u.confirmation_sent_at) out.confirmation_sent_at = u.confirmation_sent_at;
  if (u.confirmed_at) out.confirmed_at = u.confirmed_at;
  if (u.recovery_sent_at) out.recovery_sent_at = u.recovery_sent_at;
  if (u.email_change) out.new_email = u.email_change;
  if (u.email_change_sent_at) out.email_change_sent_at = u.email_change_sent_at;
  if (u.invited_at) out.invited_at = u.invited_at;
  if (u.last_sign_in_at) out.last_sign_in_at = u.last_sign_in_at;
  out.app_metadata = u.raw_app_meta_data ?? {};
  out.user_metadata = u.raw_user_meta_data ?? {};
  out.identities = user.identities.map((i) => ({
    identity_id: i.id,
    id: i.provider_id,
    user_id: i.user_id,
    identity_data: i.identity_data,
    provider: i.provider,
    last_sign_in_at: i.last_sign_in_at,
    created_at: i.created_at,
    updated_at: i.updated_at,
    email: i.email,
  }));
  out.created_at = u.created_at;
  out.updated_at = u.updated_at;
  if (u.banned_until) out.banned_until = u.banned_until;
  out.is_anonymous = u.is_anonymous;
  return out;
}

function parseBody(req: LbRequest): Json {
  if (req.body.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch (error) {
    throw new AuthHttpError(400, 'bad_json', `Could not parse request body as JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AuthHttpError(400, 'bad_json', 'Could not parse request body as JSON: expected an object');
  }
  return parsed as Json;
}

function optionalString(body: Json, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AuthHttpError(400, 'validation_failed', `${key} must be a string`);
  return value;
}

function optionalObject(body: Json, key: string): Json | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthHttpError(400, 'validation_failed', `${key} must be an object`);
  }
  return value as Json;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 255) {
    throw new AuthHttpError(400, 'validation_failed', 'Unable to validate email address: invalid format');
  }
  return normalized;
}

function checkPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthHttpError(422, 'weak_password', `Password should be at least ${MIN_PASSWORD_LENGTH} characters.`, {
      weak_password: { reasons: ['length'] },
    });
  }
}

/** Go `time.ParseDuration` subset; returns milliseconds. */
export function parseGoDuration(input: string): number | null {
  const units: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let rest = input.trim();
  let sign = 1;
  if (rest.startsWith('-') || rest.startsWith('+')) {
    sign = rest.startsWith('-') ? -1 : 1;
    rest = rest.slice(1);
  }
  if (rest === '0') return 0;
  if (rest === '') return null;
  const re = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/;
  let total = 0;
  while (rest.length > 0) {
    const match = re.exec(rest);
    if (!match) return null;
    total += Number.parseFloat(match[1]) * units[match[2]];
    rest = rest.slice(match[0].length);
  }
  return sign * total;
}

function banUntil(duration: string): string | null {
  if (duration === 'none') return null;
  const ms = parseGoDuration(duration);
  if (ms === null) {
    throw new AuthHttpError(400, 'validation_failed', `invalid format for ban duration: time: invalid duration "${duration}"`);
  }
  return new Date(Date.now() + ms).toISOString();
}

function mergeMetadata(current: Json | null, patch: Json): Json {
  const merged: Json = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

let dummyHash: Promise<string> | null = null;
function timingSafeDummyHash(): Promise<string> {
  dummyHash ??= hash(randomBytes(16).toString('hex'), BCRYPT_COST);
  return dummyHash;
}

function newRefreshToken(): string {
  return randomBytes(9).toString('base64url');
}

interface SessionInfo {
  id: string;
  amr: Json[];
}

async function tokenResponse(deps: AuthDeps, user: LoadedUser, session: SessionInfo, refreshToken: string): Promise<Json> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
  const u = user.row;
  const claims = {
    aud: u.aud || 'authenticated',
    exp,
    iat,
    iss: `${deps.baseUrl()}/auth/v1`,
    sub: u.id,
    email: u.email ?? '',
    phone: u.phone ?? '',
    app_metadata: u.raw_app_meta_data ?? {},
    user_metadata: u.raw_user_meta_data ?? {},
    role: u.role || 'authenticated',
    aal: 'aal1',
    amr: session.amr,
    session_id: session.id,
    is_anonymous: u.is_anonymous,
  };
  return {
    access_token: await signJwt(claims),
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    expires_at: exp,
    refresh_token: refreshToken,
    user: userJson(user),
    weak_password: null,
  };
}

async function passwordGrant(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const body = parseBody(req);
  const email = optionalString(body, 'email');
  const phone = optionalString(body, 'phone');
  const password = optionalString(body, 'password') ?? '';
  if (!email && !phone) throw new AuthHttpError(400, 'validation_failed', 'missing email or phone');

  const user = await authTx(deps, (q) => (email ? loadUser(q, 'email', email) : loadUser(q, 'phone', phone ?? '')));
  const storedHash = user?.row.encrypted_password;
  let passwordOk = false;
  if (storedHash && password) {
    passwordOk = await compare(password, storedHash);
  } else {
    await compare(password || 'x', await timingSafeDummyHash());
  }
  if (!user || !passwordOk) throw new AuthHttpError(400, 'invalid_credentials', 'Invalid login credentials');
  if (email && !user.row.email_confirmed_at) throw new AuthHttpError(400, 'email_not_confirmed', 'Email not confirmed');
  if (phone && !email && !user.row.phone_confirmed_at) throw new AuthHttpError(400, 'phone_not_confirmed', 'Phone not confirmed');
  if (user.banned) throw new AuthHttpError(400, 'user_banned', 'User is banned');

  const session: SessionInfo = {
    id: randomUUID(),
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
  };
  const refreshToken = newRefreshToken();
  const refreshed = await authTx(deps, async (q) => {
    await q.query(`insert into localbase.sessions (id, user_id, aal, amr) values ($1, $2, 'aal1', $3::jsonb)`, [
      session.id,
      user.row.id,
      JSON.stringify(session.amr),
    ]);
    await q.query(`insert into localbase.refresh_tokens (token, session_id, user_id) values ($1, $2, $3)`, [
      refreshToken,
      session.id,
      user.row.id,
    ]);
    await q.query(`update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1`, [user.row.id]);
    await q.query(`update auth.identities set last_sign_in_at = now() where user_id = $1`, [user.row.id]);
    return loadUser(q, 'id', user.row.id);
  });
  if (!refreshed) throw new AuthHttpError(400, 'invalid_credentials', 'Invalid login credentials');
  return ok(200, await tokenResponse(deps, refreshed, session, refreshToken));
}

type RefreshOutcome =
  | { kind: 'ok'; user: LoadedUser; session: SessionInfo; token: string }
  | { kind: 'error'; error: AuthHttpError };

async function refreshGrant(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const body = parseBody(req);
  const presented = optionalString(body, 'refresh_token');
  const notFound = new AuthHttpError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
  if (!presented) throw notFound;
  const reuseInterval = deps.refreshTokenReuseIntervalSeconds ?? 10;

  const outcome = await authTx<RefreshOutcome>(deps, async (q) => {
    const tokenRow = (
      await q.query<{ id: string; session_id: string; user_id: string; revoked: boolean; age: number }>(
        `select t.id::text as id, t.session_id::text as session_id, t.user_id::text as user_id, t.revoked,
                extract(epoch from now() - t.updated_at)::float8 as age
           from localbase.refresh_tokens t where t.token = $1 for update`,
        [presented],
      )
    ).rows[0];
    if (!tokenRow) return { kind: 'error', error: notFound };
    const sessionRow = (
      await q.query<{ amr: Json[] }>(`select amr from localbase.sessions where id = $1`, [tokenRow.session_id])
    ).rows[0];
    const user = await loadUser(q, 'id', tokenRow.user_id);
    if (!sessionRow || !user) return { kind: 'error', error: notFound };
    if (user.banned) {
      return { kind: 'error', error: new AuthHttpError(400, 'user_banned', 'Invalid Refresh Token: User Banned') };
    }
    const session = { id: tokenRow.session_id, amr: sessionRow.amr };
    if (tokenRow.revoked) {
      if (tokenRow.age <= reuseInterval) {
        const active = (
          await q.query<{ token: string }>(
            `select token from localbase.refresh_tokens where session_id = $1 and not revoked order by id desc limit 1`,
            [tokenRow.session_id],
          )
        ).rows[0];
        if (active) return { kind: 'ok', user, session, token: active.token };
      }
      // Reuse outside the interval: revoke the whole session family (committed before the error is returned).
      await q.query(`delete from localbase.sessions where id = $1`, [tokenRow.session_id]);
      return {
        kind: 'error',
        error: new AuthHttpError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used'),
      };
    }
    const token = newRefreshToken();
    await q.query(`update localbase.refresh_tokens set revoked = true, updated_at = now() where id = $1::bigint`, [tokenRow.id]);
    await q.query(
      `insert into localbase.refresh_tokens (token, session_id, user_id, parent) values ($1, $2, $3, $4)`,
      [token, tokenRow.session_id, tokenRow.user_id, presented],
    );
    await q.query(`update localbase.sessions set updated_at = now() where id = $1`, [tokenRow.session_id]);
    return { kind: 'ok', user, session, token };
  });
  if (outcome.kind === 'error') throw outcome.error;
  return ok(200, await tokenResponse(deps, outcome.user, outcome.session, outcome.token));
}

interface VerifiedToken {
  claims: Json;
  sub: string;
  sessionId: string | null;
}

async function verifyBearer(req: LbRequest): Promise<VerifiedToken> {
  const { present, token } = bearerToken(req);
  if (!present || !token) throw new AuthHttpError(401, 'no_authorization', 'This endpoint requires a Bearer token');
  const verified = await verifyJwt(token);
  if (!verified.ok) {
    throw new AuthHttpError(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${verified.message}`);
  }
  const sub = verified.claims.sub;
  if (typeof sub !== 'string' || !UUID_RE.test(sub)) {
    throw new AuthHttpError(403, 'bad_jwt', 'invalid claim: missing sub claim');
  }
  const sessionId = typeof verified.claims.session_id === 'string' ? verified.claims.session_id : null;
  return { claims: verified.claims, sub, sessionId };
}

async function requireUser(req: LbRequest, deps: AuthDeps): Promise<{ token: VerifiedToken; user: LoadedUser }> {
  const token = await verifyBearer(req);
  const result = await authTx(deps, async (q) => {
    const user = await loadUser(q, 'id', token.sub);
    if (!user) return { error: new AuthHttpError(403, 'user_not_found', 'User from sub claim in JWT does not exist') };
    if (token.sessionId) {
      const session = UUID_RE.test(token.sessionId)
        ? (await q.query(`select 1 from localbase.sessions where id = $1 and user_id = $2`, [token.sessionId, token.sub])).rows[0]
        : undefined;
      if (!session) {
        return { error: new AuthHttpError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist') };
      }
    }
    return { user };
  });
  if ('error' in result) throw result.error;
  if (result.user.banned) throw new AuthHttpError(403, 'user_banned', 'User is banned');
  return { token, user: result.user };
}

async function requireAdmin(req: LbRequest): Promise<void> {
  const { present, token } = bearerToken(req);
  if (!present || !token) throw new AuthHttpError(401, 'no_authorization', 'This endpoint requires a Bearer token');
  const verified = await verifyJwt(token);
  if (!verified.ok) {
    throw new AuthHttpError(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${verified.message}`);
  }
  const role = verified.claims.role;
  if (role !== 'service_role' && role !== 'supabase_admin') {
    throw new AuthHttpError(403, 'not_admin', 'User not allowed');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === '23505';
}

interface UserChanges {
  email?: string;
  emailConfirm?: boolean;
  phone?: string;
  phoneConfirm?: boolean;
  passwordHash?: string;
  userMetadata?: Json;
  appMetadata?: Json;
  bannedUntil?: string | null;
  role?: string;
}

async function applyUserChanges(q: Db, user: LoadedUser, changes: UserChanges): Promise<void> {
  const u = user.row;
  if (changes.email !== undefined && changes.email !== (u.email ?? '').toLowerCase()) {
    const taken = await q.query(`select 1 from auth.users where lower(email) = $1 and id <> $2`, [changes.email, u.id]);
    if (taken.rows.length) {
      throw new AuthHttpError(422, 'email_exists', 'A user with this email address has already been registered');
    }
    await q.query(`update auth.users set email = $1, email_change = '', updated_at = now() where id = $2`, [changes.email, u.id]);
    await q.query(
      `update auth.identities set identity_data = identity_data || jsonb_build_object('email', $1::text), updated_at = now()
        where user_id = $2 and provider = 'email'`,
      [changes.email, u.id],
    );
  }
  if (changes.emailConfirm) {
    await q.query(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1`, [u.id]);
  }
  if (changes.phone !== undefined && changes.phone !== (u.phone ?? '')) {
    const taken = await q.query(`select 1 from auth.users where phone = $1 and id <> $2`, [changes.phone, u.id]);
    if (taken.rows.length) {
      throw new AuthHttpError(422, 'phone_exists', 'A user with this phone number has already been registered');
    }
    await q.query(`update auth.users set phone = nullif($1, ''), updated_at = now() where id = $2`, [changes.phone, u.id]);
  }
  if (changes.phoneConfirm) {
    await q.query(`update auth.users set phone_confirmed_at = coalesce(phone_confirmed_at, now()) where id = $1`, [u.id]);
  }
  if (changes.passwordHash !== undefined) {
    await q.query(`update auth.users set encrypted_password = $1, updated_at = now() where id = $2`, [changes.passwordHash, u.id]);
  }
  if (changes.userMetadata !== undefined) {
    await q.query(`update auth.users set raw_user_meta_data = $1::jsonb, updated_at = now() where id = $2`, [
      JSON.stringify(mergeMetadata(u.raw_user_meta_data, changes.userMetadata)),
      u.id,
    ]);
  }
  if (changes.appMetadata !== undefined) {
    await q.query(`update auth.users set raw_app_meta_data = $1::jsonb, updated_at = now() where id = $2`, [
      JSON.stringify(mergeMetadata(u.raw_app_meta_data, changes.appMetadata)),
      u.id,
    ]);
  }
  if (changes.bannedUntil !== undefined) {
    await q.query(`update auth.users set banned_until = $1::timestamptz, updated_at = now() where id = $2`, [
      changes.bannedUntil,
      u.id,
    ]);
  }
  if (changes.role !== undefined) {
    await q.query(`update auth.users set role = $1, updated_at = now() where id = $2`, [changes.role, u.id]);
  }
}

async function withDbFailure<T>(deps: AuthDeps, message: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    const detail = error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error);
    deps.log(`auth database error (${message}): ${detail}`);
    throw new AuthHttpError(500, 'unexpected_failure', message);
  }
}

async function getUser(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const { user } = await requireUser(req, deps);
  return ok(200, userJson(user));
}

async function updateUser(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const { user } = await requireUser(req, deps);
  const body = parseBody(req);
  const changes: UserChanges = {};
  const email = optionalString(body, 'email');
  if (email !== undefined) changes.email = normalizeEmail(email);
  const phone = optionalString(body, 'phone');
  if (phone !== undefined) changes.phone = phone;
  const data = optionalObject(body, 'data');
  if (data !== undefined) changes.userMetadata = data;
  const password = optionalString(body, 'password');
  if (password !== undefined) {
    checkPasswordStrength(password);
    if (user.row.encrypted_password && (await compare(password, user.row.encrypted_password))) {
      throw new AuthHttpError(422, 'same_password', 'New password should be different from the old password.');
    }
    changes.passwordHash = await hash(password, BCRYPT_COST);
  }
  const updated = await withDbFailure(deps, 'Database error updating user', () =>
    authTx(deps, async (q) => {
      await applyUserChanges(q, user, changes);
      return loadUser(q, 'id', user.row.id);
    }),
  );
  if (!updated) throw new AuthHttpError(404, 'user_not_found', 'User not found');
  return ok(200, userJson(updated));
}

async function logout(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const token = await verifyBearer(req);
  const scope = req.url.searchParams.get('scope') ?? 'global';
  if (!['global', 'local', 'others'].includes(scope)) {
    throw new AuthHttpError(400, 'validation_failed', 'Unsupported logout scope');
  }
  await authTx(deps, async (q) => {
    const sessionId = token.sessionId && UUID_RE.test(token.sessionId) ? token.sessionId : null;
    if (scope === 'global' || !sessionId) {
      if (scope !== 'others') await q.query(`delete from localbase.sessions where user_id = $1`, [token.sub]);
    } else if (scope === 'local') {
      await q.query(`delete from localbase.sessions where id = $1 and user_id = $2`, [sessionId, token.sub]);
    } else {
      await q.query(`delete from localbase.sessions where user_id = $1 and id <> $2`, [token.sub, sessionId]);
    }
  });
  return { status: 204, headers: { 'X-Supabase-Api-Version': API_VERSION } };
}

async function adminListUsers(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  await requireAdmin(req);
  const pageRaw = Number.parseInt(req.url.searchParams.get('page') ?? '', 10);
  const perPageRaw = Number.parseInt(req.url.searchParams.get('per_page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 1000) : 50;
  const { total, users } = await authTx(deps, async (q) => {
    const count = await q.query<{ total: number }>(`select count(*)::int as total from auth.users where deleted_at is null`);
    const ids = await q.query<{ id: string }>(
      `select id::text as id from auth.users where deleted_at is null order by created_at desc, id limit $1 offset $2`,
      [perPage, (page - 1) * perPage],
    );
    const loaded: LoadedUser[] = [];
    for (const { id } of ids.rows) {
      const user = await loadUser(q, 'id', id);
      if (user) loaded.push(user);
    }
    return { total: count.rows[0].total, users: loaded };
  });
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  if (page < lastPage) links.push(`</admin/users?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  links.push(`</admin/users?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  return ok(200, { users: users.map(userJson), aud: 'authenticated' }, { 'X-Total-Count': String(total), Link: links.join(', ') });
}

async function adminCreateUser(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  await requireAdmin(req);
  const body = parseBody(req);
  const emailRaw = optionalString(body, 'email');
  const phone = optionalString(body, 'phone');
  if (!emailRaw && !phone) throw new AuthHttpError(400, 'validation_failed', 'Unable to validate email address: invalid format');
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  const password = optionalString(body, 'password');
  const passwordHashInput = optionalString(body, 'password_hash');
  if (password !== undefined) checkPasswordStrength(password);
  const userMetadata = optionalObject(body, 'user_metadata') ?? {};
  const appMetadataInput = optionalObject(body, 'app_metadata') ?? {};
  const banDuration = optionalString(body, 'ban_duration');
  const bannedUntil = banDuration !== undefined ? banUntil(banDuration) : null;
  const role = optionalString(body, 'role') ?? 'authenticated';
  const idInput = optionalString(body, 'id');
  if (idInput !== undefined && !UUID_RE.test(idInput)) throw new AuthHttpError(400, 'validation_failed', 'id must be a UUID');
  const id = idInput ?? randomUUID();
  const provider = email ? 'email' : 'phone';
  const appMetadata = { provider, providers: [provider], ...appMetadataInput };
  const passwordHash = password !== undefined ? await hash(password, BCRYPT_COST) : (passwordHashInput ?? null);

  const created = await withDbFailure(deps, 'Database error creating new user', () =>
    authTx(deps, async (q) => {
      if (email && (await q.query(`select 1 from auth.users where lower(email) = $1`, [email])).rows.length) {
        throw new AuthHttpError(422, 'email_exists', 'A user with this email address has already been registered');
      }
      if (phone && (await q.query(`select 1 from auth.users where phone = $1`, [phone])).rows.length) {
        throw new AuthHttpError(422, 'phone_exists', 'A user with this phone number has already been registered');
      }
      try {
        await q.query(
          `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, phone,
                                   phone_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                   banned_until, is_sso_user, is_anonymous)
           values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', $2, $3, $4,
                   case when $5::boolean then now() end, $6, case when $7::boolean then now() end,
                   $8::jsonb, $9::jsonb, now(), now(), $10::timestamptz, false, false)`,
          [
            id,
            role,
            email,
            passwordHash ?? '',
            body.email_confirm === true,
            phone ?? null,
            body.phone_confirm === true,
            JSON.stringify(appMetadata),
            JSON.stringify(userMetadata),
            bannedUntil,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AuthHttpError(422, 'email_exists', 'A user with this email address has already been registered');
        }
        throw error;
      }
      const identityData = email
        ? { sub: id, email, email_verified: body.email_confirm === true, phone_verified: false }
        : { sub: id, phone, email_verified: false, phone_verified: body.phone_confirm === true };
      await q.query(
        `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         values ($1, $2, $3::jsonb, $4, null, now(), now())`,
        [id, id, JSON.stringify(identityData), provider],
      );
      return loadUser(q, 'id', id);
    }),
  );
  if (!created) throw new AuthHttpError(500, 'unexpected_failure', 'Database error creating new user');
  return ok(200, userJson(created));
}

async function adminGetUser(req: LbRequest, deps: AuthDeps, id: string): Promise<LbResponse> {
  await requireAdmin(req);
  const user = UUID_RE.test(id) ? await authTx(deps, (q) => loadUser(q, 'id', id)) : null;
  if (!user) throw new AuthHttpError(404, 'user_not_found', 'User not found');
  return ok(200, userJson(user));
}

async function adminUpdateUser(req: LbRequest, deps: AuthDeps, id: string): Promise<LbResponse> {
  await requireAdmin(req);
  const body = parseBody(req);
  const changes: UserChanges = {};
  const email = optionalString(body, 'email');
  if (email !== undefined) changes.email = normalizeEmail(email);
  const phone = optionalString(body, 'phone');
  if (phone !== undefined) changes.phone = phone;
  if (body.email_confirm === true) changes.emailConfirm = true;
  if (body.phone_confirm === true) changes.phoneConfirm = true;
  const password = optionalString(body, 'password');
  if (password !== undefined) {
    checkPasswordStrength(password);
    changes.passwordHash = await hash(password, BCRYPT_COST);
  }
  const userMetadata = optionalObject(body, 'user_metadata');
  if (userMetadata !== undefined) changes.userMetadata = userMetadata;
  const appMetadata = optionalObject(body, 'app_metadata');
  if (appMetadata !== undefined) changes.appMetadata = appMetadata;
  const banDuration = optionalString(body, 'ban_duration');
  if (banDuration !== undefined) changes.bannedUntil = banUntil(banDuration);
  const role = optionalString(body, 'role');
  if (role !== undefined) changes.role = role;

  if (!UUID_RE.test(id)) throw new AuthHttpError(404, 'user_not_found', 'User not found');
  const updated = await withDbFailure(deps, 'Database error updating user', () =>
    authTx(deps, async (q) => {
      const user = await loadUser(q, 'id', id);
      if (!user) throw new AuthHttpError(404, 'user_not_found', 'User not found');
      await applyUserChanges(q, user, changes);
      return loadUser(q, 'id', id);
    }),
  );
  if (!updated) throw new AuthHttpError(404, 'user_not_found', 'User not found');
  return ok(200, userJson(updated));
}

async function adminDeleteUser(req: LbRequest, deps: AuthDeps, id: string): Promise<LbResponse> {
  await requireAdmin(req);
  const body = parseBody(req);
  if (!UUID_RE.test(id)) throw new AuthHttpError(404, 'user_not_found', 'User not found');
  const soft = body.should_soft_delete === true;
  await withDbFailure(deps, 'Database error deleting user', () =>
    authTx(deps, async (q) => {
      const user = await loadUser(q, 'id', id);
      if (!user) throw new AuthHttpError(404, 'user_not_found', 'User not found');
      if (!soft) {
        await q.query(`delete from auth.users where id = $1`, [id]);
        return;
      }
      const obfuscate = (value: string) => createHash('sha256').update(`${id}${value}`).digest('hex');
      await q.query(
        `update auth.users set deleted_at = now(), updated_at = now(), encrypted_password = '',
                raw_user_meta_data = '{}'::jsonb, raw_app_meta_data = '{}'::jsonb,
                email = case when email is null then null else $2 end, phone = null
          where id = $1`,
        [id, obfuscate(user.row.email ?? '')],
      );
      await q.query(`delete from auth.identities where user_id = $1`, [id]);
      await q.query(`delete from localbase.sessions where user_id = $1`, [id]);
    }),
  );
  return ok(200, {});
}

const SETTINGS = {
  external: {
    anonymous_users: false,
    apple: false,
    azure: false,
    bitbucket: false,
    discord: false,
    facebook: false,
    figma: false,
    github: false,
    gitlab: false,
    google: false,
    keycloak: false,
    kakao: false,
    linkedin_oidc: false,
    notion: false,
    spotify: false,
    slack_oidc: false,
    twitch: false,
    twitter: false,
    workos: false,
    zoom: false,
    email: true,
    phone: false,
  },
  disable_signup: true,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  sms_provider: '',
  saml_enabled: false,
};

export async function handleAuth(req: LbRequest, deps: AuthDeps): Promise<LbResponse> {
  const path = req.url.pathname.slice('/auth/v1'.length).replace(/\/+$/, '') || '/';
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  try {
    if (path === '/health' && method === 'GET') {
      return ok(200, { version: 'localbase', name: 'GoTrue', description: 'GoTrue is a user registration and authentication API' });
    }
    if (path === '/settings' && method === 'GET') return ok(200, SETTINGS);
    if (path === '/.well-known/jwks.json' && method === 'GET') return ok(200, { keys: [] });
    if (path === '/signup' && method === 'POST') {
      throw new AuthHttpError(422, 'signup_disabled', 'Signups not allowed for this instance');
    }
    if (path === '/token' && method === 'POST') {
      const grant = req.url.searchParams.get('grant_type');
      if (grant === 'password') return await passwordGrant(req, deps);
      if (grant === 'refresh_token') return await refreshGrant(req, deps);
      throw new AuthHttpError(400, 'validation_failed', 'unsupported_grant_type');
    }
    if (path === '/user') {
      if (method === 'GET') return await getUser(req, deps);
      if (method === 'PUT') return await updateUser(req, deps);
    }
    if (path === '/logout' && method === 'POST') return await logout(req, deps);
    if (path === '/admin/users') {
      if (method === 'GET') return await adminListUsers(req, deps);
      if (method === 'POST') return await adminCreateUser(req, deps);
    }
    const adminUser = /^\/admin\/users\/([^/]+)$/.exec(path);
    if (adminUser) {
      const id = decodeURIComponent(adminUser[1]);
      if (method === 'GET') return await adminGetUser(req, deps, id);
      if (method === 'PUT') return await adminUpdateUser(req, deps, id);
      if (method === 'DELETE') return await adminDeleteUser(req, deps, id);
    }
    throw new AuthHttpError(404, 'not_found', `localbase does not implement ${req.method} /auth/v1${path}`);
  } catch (error) {
    if (error instanceof AuthHttpError) return authErrorResponse(req, error);
    deps.log(`auth internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return authErrorResponse(req, new AuthHttpError(500, 'unexpected_failure', 'Unexpected failure'));
  }
}
