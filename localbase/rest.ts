import type { PGlite } from '@electric-sql/pglite';
import { header, jsonResponse, type LbRequest, type LbResponse } from './http';
import type { ApiRole } from './jwt';
import type { AsyncMutex } from './mutex';
import {
  PgrstError,
  negotiateAccept,
  parseFailure,
  parsePrefer,
  parseQuery,
  parseRangeHeader,
  type AcceptResult,
  type Condition,
  type OrderTerm,
  type ParsedQuery,
  type Preferences,
  type SelectItem,
} from './rest-parse';

export interface RestAuth {
  role: ApiRole;
  claims: Record<string, unknown>;
}

export interface RestDeps {
  db: PGlite;
  mutex: AsyncMutex;
  /** Supabase's default "Max rows" API setting. */
  maxRows: number;
  log: (message: string) => void;
}

type Queryable = Pick<PGlite, 'query'>;

const ROLE_SQL: Record<ApiRole, string> = {
  anon: 'anon',
  authenticated: 'authenticated',
  service_role: 'service_role',
};

export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw parseFailure('invalid identifier');
  return `"${name.replace(/"/g, '""')}"`;
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface ColumnMeta {
  name: string;
  type: string;
}

interface RelationMeta {
  name: string;
  columns: Map<string, ColumnMeta>;
  primaryKey: string[];
}

interface PgErrorShape {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  severity?: string;
}

function isPgError(error: unknown): error is Error & PgErrorShape {
  return (
    error instanceof Error &&
    typeof (error as Partial<PgErrorShape>).code === 'string' &&
    typeof (error as Partial<PgErrorShape>).severity === 'string'
  );
}

/** PostgREST 12 `pgErrorStatus`. */
export function pgErrorStatus(code: string, message: string, authenticated: boolean): number {
  if (code.startsWith('08')) return 503;
  if (code.startsWith('09')) return 500;
  if (code.startsWith('0L') || code.startsWith('0P')) return 403;
  if (code === '23503' || code === '23505') return 409;
  if (code === '25006') return 405;
  if (code === '21000') return message.endsWith('requires a WHERE clause') ? 400 : 500;
  if (code.startsWith('25')) return 500;
  if (code.startsWith('28')) return 403;
  if (code.startsWith('2D') || code.startsWith('38') || code.startsWith('39') || code.startsWith('3B')) return 500;
  if (code.startsWith('40')) return 500;
  if (code === '53400') return 500;
  if (code.startsWith('53')) return 503;
  if (code.startsWith('54') || code.startsWith('55')) return 500;
  if (code === '57P01') return 503;
  if (code.startsWith('57') || code.startsWith('58') || code.startsWith('F0') || code.startsWith('HV')) return 500;
  if (code === 'P0001') return 400;
  if (code.startsWith('P0') || code.startsWith('XX')) return 500;
  if (code === '42883' || code === '42P01') return 404;
  if (code === '42P17') return 500;
  if (code === '42501') return authenticated ? 403 : 401;
  if (code.startsWith('PT')) {
    const status = Number.parseInt(code.slice(2), 10);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  }
  return 400;
}

function errorResponse(error: unknown, auth: RestAuth, log: (m: string) => void): LbResponse {
  if (error instanceof PgrstError) {
    return jsonResponse(
      error.status,
      { code: error.code, details: error.details, hint: error.hint, message: error.message },
      error.headers,
    );
  }
  if (isPgError(error)) {
    const status = pgErrorStatus(error.code, error.message, auth.role !== 'anon');
    const headers: Record<string, string> = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {};
    return jsonResponse(
      status,
      { code: error.code, details: error.detail ?? null, hint: error.hint ?? null, message: error.message },
      headers,
    );
  }
  log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return jsonResponse(500, {
    code: 'PGRST000',
    details: null,
    hint: null,
    message: 'localbase internal error',
  });
}

function singularityError(rows: number): PgrstError {
  return new PgrstError(
    406,
    'PGRST116',
    'Cannot coerce the result to a single JSON object',
    `The result contains ${rows} rows`,
  );
}

function schemaCheck(req: LbRequest): void {
  for (const name of ['accept-profile', 'content-profile']) {
    const value = header(req, name);
    if (value !== undefined && value.trim() !== 'public') {
      throw new PgrstError(406, 'PGRST106', 'The schema must be one of the following: public');
    }
  }
}

interface TxOutcome<T> {
  value: T;
  rollback: boolean;
}

async function runRequestTransaction<T>(
  deps: RestDeps,
  auth: RestAuth,
  req: LbRequest,
  readOnly: boolean,
  work: (q: Queryable) => Promise<TxOutcome<T>>,
): Promise<T> {
  const role = ROLE_SQL[auth.role];
  if (!role) throw new Error('refusing to run a request without an API role');
  return deps.mutex.run(async () => {
    const db = deps.db;
    await db.query(
      readOnly ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED',
    );
    let finished = false;
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      const who = await db.query<{ current_user: string }>('select current_user::text as current_user');
      if (who.rows[0]?.current_user !== role) throw new Error('role switch failed');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      await db.query(
        `select set_config('request.jwt.claims', $1, true), set_config('request.method', $2, true),
                set_config('request.path', $3, true), set_config('request.headers', $4, true)`,
        [JSON.stringify(auth.claims), req.method, req.url.pathname, JSON.stringify(headers)],
      );
      const outcome = await work(db);
      const after = await db.query<{ current_user: string }>('select current_user::text as current_user');
      if (after.rows[0]?.current_user !== role) throw new Error('request changed the active role; rolled back');
      await db.query(outcome.rollback ? 'ROLLBACK' : 'COMMIT');
      finished = true;
      return outcome.value;
    } finally {
      if (!finished) await db.query('ROLLBACK').catch(() => undefined);
    }
  });
}

async function loadRelation(q: Queryable, name: string): Promise<RelationMeta> {
  const rel = await q.query<{ oid: string }>(
    `select c.oid::int8::text as oid
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r', 'v', 'm', 'f', 'p')`,
    [name],
  );
  const oid = rel.rows[0]?.oid;
  if (!oid) {
    throw new PgrstError(404, '42P01', `relation "public.${name}" does not exist`);
  }
  const cols = await q.query<{ name: string; type: string }>(
    `select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
       from pg_catalog.pg_attribute a
      where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [oid],
  );
  const pk = await q.query<{ name: string }>(
    `select a.attname::text as name
       from pg_catalog.pg_index i
       join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::oid and i.indisprimary
      order by array_position(i.indkey::int2[], a.attnum)`,
    [oid],
  );
  return {
    name,
    columns: new Map(cols.rows.map((c) => [c.name, c])),
    primaryKey: pk.rows.map((r) => r.name),
  };
}

function columnRef(rel: RelationMeta, name: string, qualifier: string): string {
  if (!rel.columns.has(name)) {
    throw new PgrstError(400, '42703', `column ${rel.name}.${name} does not exist`);
  }
  return `${qualifier}.${quoteIdent(name)}`;
}

const BINARY_OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  match: '~',
  imatch: '~*',
  isdistinct: 'IS DISTINCT FROM',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxr: '&<',
  nxl: '&>',
  adj: '-|-',
};

const FTS_FUNCTIONS: Record<string, string> = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
};

function buildCondition(condition: Condition, rel: RelationMeta, params: Params, qualifier: string): string {
  if (condition.kind === 'logic') {
    const joiner = condition.operator === 'and' ? ' AND ' : ' OR ';
    const inner = `(${condition.children.map((c) => buildCondition(c, rel, params, qualifier)).join(joiner)})`;
    return condition.negate ? `NOT ${inner}` : inner;
  }
  const column = columnRef(rel, condition.column, qualifier);
  let expression: string;
  const { operator, value } = condition;
  if (operator === 'in') {
    const items = value as string[];
    expression = items.length === 0 ? 'false' : `${column} IN (${items.map((v) => params.add(v)).join(', ')})`;
  } else if (operator === 'is') {
    const map: Record<string, string> = {
      null: 'IS NULL',
      not_null: 'IS NOT NULL',
      true: 'IS TRUE',
      false: 'IS FALSE',
      unknown: 'IS UNKNOWN',
    };
    expression = `${column} ${map[value as string]}`;
  } else if (operator in FTS_FUNCTIONS) {
    const fn = FTS_FUNCTIONS[operator];
    const language = condition.language ? `${params.add(condition.language)}::regconfig, ` : '';
    expression = `${column} @@ pg_catalog.${fn}(${language}${params.add(value)})`;
  } else if (condition.quantifier) {
    expression = `${column} ${BINARY_OPERATORS[operator]} ${condition.quantifier.toUpperCase()}(${params.add(value)})`;
  } else {
    expression = `${column} ${BINARY_OPERATORS[operator]} ${params.add(value)}`;
  }
  return condition.negate ? `NOT (${expression})` : expression;
}

function buildWhere(conditions: Condition[], rel: RelationMeta, params: Params, qualifier: string): string {
  if (conditions.length === 0) return '';
  return ` WHERE ${conditions.map((c) => buildCondition(c, rel, params, qualifier)).join(' AND ')}`;
}

function buildSelectList(items: SelectItem[] | null, rel: RelationMeta, qualifier: string): string {
  const list = items ?? [{ kind: 'star' as const }];
  return list
    .map((item) => {
      if (item.kind === 'star') return `${qualifier}.*`;
      const cast = item.cast ? `::${item.cast}` : '';
      return `${columnRef(rel, item.name, qualifier)}${cast} AS ${quoteIdent(item.alias ?? item.name)}`;
    })
    .join(', ');
}

function buildOrder(order: OrderTerm[], rel: RelationMeta, qualifier: string): string {
  if (order.length === 0) return '';
  return ` ORDER BY ${order
    .map((term) => {
      const nulls = term.nulls ? ` NULLS ${term.nulls.toUpperCase()}` : '';
      return `${columnRef(rel, term.column, qualifier)} ${term.direction.toUpperCase()}${nulls}`;
    })
    .join(', ')}`;
}

function aggregateColumns(stripNulls: boolean, valueExpr = '_postgrest_t'): { body: string; first: string } {
  const element = stripNulls ? `pg_catalog.json_strip_nulls(pg_catalog.to_json(${valueExpr}))` : valueExpr;
  return {
    body: `coalesce(pg_catalog.json_agg(${element}), '[]')::text`,
    first: `(pg_catalog.json_agg(${element}) -> 0)::text`,
  };
}

interface ResultRow {
  total: string | null;
  page_total: string;
  body: string | null;
  first: string | null;
}

function contentType(accept: AcceptResult): string {
  if (accept.kind === 'object') {
    return `application/vnd.pgrst.object+json${accept.stripNulls ? ';nulls=stripped' : ''}; charset=utf-8`;
  }
  return accept.stripNulls
    ? 'application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8'
    : 'application/json; charset=utf-8';
}

function resolvePage(
  req: LbRequest,
  query: ParsedQuery,
  maxRows: number,
): { offset: number; limit: number } {
  let offset = query.offset ?? 0;
  let end = query.limit === null ? Number.POSITIVE_INFINITY : offset + query.limit - 1;
  if (req.method === 'GET' || req.method === 'HEAD') {
    const range = parseRangeHeader(header(req, 'range'));
    if (range) {
      offset = Math.max(offset, range.lower);
      if (range.upper !== null) end = Math.min(end, range.upper);
    }
  }
  const limit = end === Number.POSITIVE_INFINITY ? maxRows : Math.max(0, Math.min(maxRows, end - offset + 1));
  return { offset, limit };
}

function readResponse(
  req: LbRequest,
  row: ResultRow,
  offset: number,
  accept: AcceptResult,
  prefer: Preferences,
): { response: LbResponse; rollback: boolean } {
  const pageTotal = Number.parseInt(row.page_total, 10);
  const total = row.total === null ? null : Number.parseInt(row.total, 10);
  if (accept.kind === 'object' && pageTotal !== 1) throw singularityError(pageTotal);
  let status = 200;
  if (total !== null) {
    if (offset > total && !(offset === 0 && total === 0)) {
      throw new PgrstError(
        416,
        'PGRST103',
        'Requested range not satisfiable',
        `An offset of ${offset} was requested, but there are only ${total} rows.`,
      );
    }
    if (pageTotal < total) status = 206;
  }
  const rangeEnd = offset + pageTotal - 1;
  const headers: Record<string, string> = {
    'Content-Type': contentType(accept),
    'Content-Range': `${pageTotal > 0 ? `${offset}-${rangeEnd}` : '*'}/${total ?? '*'}`,
  };
  if (prefer.applied.length) headers['Preference-Applied'] = prefer.applied.join(', ');
  const body = accept.kind === 'object' ? (row.first ?? 'null') : (row.body ?? '[]');
  return { response: { status, headers, body: req.method === 'HEAD' ? undefined : body }, rollback: false };
}

function parseJsonBody(raw: string): unknown {
  if (raw.trim() === '') throw new PgrstError(400, 'PGRST102', 'Empty or invalid json');
  try {
    return JSON.parse(raw);
  } catch {
    throw new PgrstError(400, 'PGRST102', 'Empty or invalid json');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkContentType(req: LbRequest): void {
  const value = header(req, 'content-type');
  if (value === undefined) return;
  const type = value.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== '') {
    throw new PgrstError(415, 'PGRST107', `Content-Type not acceptable: ${value}`);
  }
}

function mutationStatementFilterGuard(query: ParsedQuery, method: string): void {
  if (method === 'POST' && (query.conditions.length > 0 || query.order.length > 0 || query.limit !== null || query.offset !== null)) {
    throw parseFailure('filters, order, limit and offset are not supported on insert by localbase');
  }
  if ((method === 'PATCH' || method === 'DELETE') && (query.order.length > 0 || query.limit !== null || query.offset !== null)) {
    throw parseFailure('order, limit and offset are not supported on update/delete by localbase');
  }
}

async function handleRelation(req: LbRequest, relationName: string, auth: RestAuth, deps: RestDeps): Promise<LbResponse> {
  const method = req.method;
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    throw new PgrstError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
  }
  const query = parseQuery(req.url.searchParams);
  const prefer = parsePrefer(header(req, 'prefer'));
  const accept = negotiateAccept(header(req, 'accept'));
  mutationStatementFilterGuard(query, method);
  const readOnly = method === 'GET' || method === 'HEAD';
  if (!readOnly) checkContentType(req);

  return runRequestTransaction(deps, auth, req, readOnly, async (q) => {
    const rel = await loadRelation(q, relationName);
    const target = `"public".${quoteIdent(rel.name)}`;
    if (readOnly) {
      const params = new Params();
      const selectList = buildSelectList(query.select, rel, target);
      const where = buildWhere(query.conditions, rel, params, target);
      const order = buildOrder(query.order, rel, target);
      const { offset, limit } = resolvePage(req, query, deps.maxRows);
      const agg = aggregateColumns(accept.stripNulls);
      const countSql = prefer.count ? `(SELECT pg_catalog.count(*) FROM ${target}${where})::int8::text` : 'null::text';
      const sql =
        `WITH pgrst_source AS (SELECT ${selectList} FROM ${target}${where}${order} LIMIT ${limit} OFFSET ${offset}) ` +
        `SELECT ${countSql} AS total, pg_catalog.count(_postgrest_t)::int8::text AS page_total, ` +
        `${agg.body} AS body, ${agg.first} AS first FROM (SELECT * FROM pgrst_source) _postgrest_t`;
      const result = await q.query<ResultRow>(sql, params.values);
      const { response, rollback } = readResponse(req, result.rows[0], offset, accept, prefer);
      return { value: response, rollback };
    }
    if (method === 'POST') return handleInsert(req, rel, target, query, prefer, accept, q);
    return handleUpdateOrDelete(req, rel, target, query, prefer, accept, q);
  });
}

function returningClause(prefer: Preferences, query: ParsedQuery, rel: RelationMeta, target: string): string {
  return prefer.return === 'representation' ? buildSelectList(query.select, rel, target) : '1';
}

function mutationSql(statement: string, returning: string, representation: boolean, stripNulls: boolean): string {
  const agg = aggregateColumns(stripNulls);
  const bodyCols = representation ? `${agg.body} AS body, ${agg.first} AS first` : 'null::text AS body, null::text AS first';
  return (
    `WITH pgrst_source AS (${statement} RETURNING ${returning}) ` +
    `SELECT null::text AS total, pg_catalog.count(_postgrest_t)::int8::text AS page_total, ${bodyCols} ` +
    `FROM (SELECT * FROM pgrst_source) _postgrest_t`
  );
}

function mutationResponse(
  status: number,
  rows: { pageTotal: number; body: string; first: string | null },
  prefer: Preferences,
  accept: AcceptResult,
): TxOutcome<LbResponse> {
  if (accept.kind === 'object' && rows.pageTotal !== 1) throw singularityError(rows.pageTotal);
  if (prefer.handling === 'strict' && prefer.maxAffected !== null && rows.pageTotal > prefer.maxAffected) {
    throw new PgrstError(
      400,
      'PGRST124',
      'Query result exceeds max-affected preference constraint',
      `The query affects ${rows.pageTotal} rows`,
    );
  }
  const headers: Record<string, string> = {
    'Content-Range': `*/${prefer.count ? rows.pageTotal : '*'}`,
  };
  if (prefer.applied.length) headers['Preference-Applied'] = prefer.applied.join(', ');
  if (prefer.return === 'representation') {
    headers['Content-Type'] = contentType(accept);
    const body = accept.kind === 'object' ? (rows.first ?? 'null') : rows.body;
    return { value: { status: status === 204 ? 200 : status, headers, body }, rollback: false };
  }
  return { value: { status, headers }, rollback: false };
}

function unknownColumn(rel: RelationMeta, column: string): PgrstError {
  return new PgrstError(400, 'PGRST204', `Could not find the '${column}' column of '${rel.name}' in the schema cache`);
}

async function handleInsert(
  req: LbRequest,
  rel: RelationMeta,
  target: string,
  query: ParsedQuery,
  prefer: Preferences,
  accept: AcceptResult,
  q: Queryable,
): Promise<TxOutcome<LbResponse>> {
  const payload = parseJsonBody(req.body);
  const isArray = Array.isArray(payload);
  const rows: unknown[] = isArray ? payload : [payload];
  if (!rows.every(isPlainObject)) throw new PgrstError(400, 'PGRST102', 'Empty or invalid json');
  const objects = rows as Record<string, unknown>[];

  let columns: string[];
  if (query.columns) {
    columns = query.columns;
  } else if (objects.length === 0) {
    columns = [];
  } else {
    columns = Object.keys(objects[0]);
    const signature = [...columns].sort().join(' ');
    if (objects.some((o) => Object.keys(o).sort().join(' ') !== signature)) {
      throw new PgrstError(400, 'PGRST102', 'All object keys must match');
    }
  }
  for (const column of columns) if (!rel.columns.has(column)) throw unknownColumn(rel, column);

  let conflict = '';
  if (prefer.resolution) {
    const targetColumns = query.onConflict ?? rel.primaryKey;
    if (targetColumns.length === 0) {
      throw new PgrstError(400, 'PGRST100', `on_conflict is required: ${rel.name} has no primary key`);
    }
    for (const column of targetColumns) if (!rel.columns.has(column)) throw unknownColumn(rel, column);
    const conflictCols = targetColumns.map(quoteIdent).join(', ');
    if (prefer.resolution === 'ignore-duplicates' || columns.length === 0) {
      conflict = ` ON CONFLICT (${conflictCols}) DO NOTHING`;
    } else {
      conflict = ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${columns
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(', ')}`;
    }
  }

  const representation = prefer.return === 'representation';
  const returning = returningClause(prefer, query, rel, target);
  if (objects.length === 0) {
    return mutationResponse(201, { pageTotal: 0, body: '[]', first: null }, prefer, accept);
  }

  if (prefer.missing !== 'default' && columns.length > 0) {
    const params = new Params();
    const p = params.add(req.body);
    const source = `CASE WHEN pg_catalog.json_typeof(${p}::json) = 'array' THEN ${p}::json ELSE pg_catalog.json_build_array(${p}::json) END`;
    const statement =
      `INSERT INTO ${target} (${columns.map(quoteIdent).join(', ')}) ` +
      `SELECT ${columns.map((c) => `_.${quoteIdent(c)}`).join(', ')} ` +
      `FROM pg_catalog.json_populate_recordset(NULL::${target}, ${source}) _${conflict}`;
    const result = await q.query<ResultRow>(mutationSql(statement, returning, representation, accept.stripNulls), params.values);
    const row = result.rows[0];
    return mutationResponse(
      201,
      { pageTotal: Number.parseInt(row.page_total, 10), body: row.body ?? '[]', first: row.first },
      prefer,
      accept,
    );
  }

  // Prefer: missing=default (or no columns at all): one INSERT per row so absent keys take column defaults.
  let pageTotal = 0;
  const bodies: string[] = [];
  let first: string | null = null;
  for (let index = 0; index < objects.length; index += 1) {
    const params = new Params();
    const present = columns.filter((c) => Object.prototype.hasOwnProperty.call(objects[index], c));
    let statement: string;
    if (present.length === 0) {
      statement = `INSERT INTO ${target} DEFAULT VALUES${conflict}`;
    } else {
      const p = params.add(req.body);
      const element = isArray ? `(${p}::json -> ${params.add(index)}::int)` : `${p}::json`;
      statement =
        `INSERT INTO ${target} (${present.map(quoteIdent).join(', ')}) ` +
        `SELECT ${present.map((c) => `_.${quoteIdent(c)}`).join(', ')} ` +
        `FROM pg_catalog.json_populate_record(NULL::${target}, ${element}) _${conflict}`;
    }
    const result = await q.query<ResultRow>(mutationSql(statement, returning, representation, accept.stripNulls), params.values);
    const row = result.rows[0];
    const count = Number.parseInt(row.page_total, 10);
    pageTotal += count;
    if (representation && row.body && count > 0) {
      bodies.push(row.body.slice(1, -1));
      first ??= row.first;
    }
  }
  return mutationResponse(201, { pageTotal, body: `[${bodies.join(',')}]`, first }, prefer, accept);
}

async function handleUpdateOrDelete(
  req: LbRequest,
  rel: RelationMeta,
  target: string,
  query: ParsedQuery,
  prefer: Preferences,
  accept: AcceptResult,
  q: Queryable,
): Promise<TxOutcome<LbResponse>> {
  const isUpdate = req.method === 'PATCH';
  const params = new Params();
  let statement: string;
  if (isUpdate) {
    const payload = parseJsonBody(req.body);
    if (!isPlainObject(payload)) throw new PgrstError(400, 'PGRST102', 'Empty or invalid json');
    const keys = query.columns ?? Object.keys(payload);
    for (const key of keys) if (!rel.columns.has(key)) throw unknownColumn(rel, key);
    if (query.conditions.length === 0) {
      throw new PgrstError(400, '21000', 'UPDATE requires a WHERE clause');
    }
    if (keys.length === 0) {
      return mutationResponse(204, { pageTotal: 0, body: '[]', first: null }, prefer, accept);
    }
    const p = params.add(req.body);
    const where = buildWhere(query.conditions, rel, params, target);
    statement =
      `UPDATE ${target} SET ${keys.map((k) => `${quoteIdent(k)} = _.${quoteIdent(k)}`).join(', ')} ` +
      `FROM (SELECT * FROM pg_catalog.json_populate_record(NULL::${target}, ${p}::json)) _${where}`;
  } else {
    if (query.conditions.length === 0) {
      throw new PgrstError(400, '21000', 'DELETE requires a WHERE clause');
    }
    statement = `DELETE FROM ${target}${buildWhere(query.conditions, rel, params, target)}`;
  }
  const representation = prefer.return === 'representation';
  const returning = returningClause(prefer, query, rel, target);
  const result = await q.query<ResultRow>(mutationSql(statement, returning, representation, accept.stripNulls), params.values);
  const row = result.rows[0];
  return mutationResponse(
    204,
    { pageTotal: Number.parseInt(row.page_total, 10), body: row.body ?? '[]', first: row.first },
    prefer,
    accept,
  );
}

interface FunctionArg {
  name: string;
  type: string;
  variadic: boolean;
}

interface FunctionMeta {
  inputs: FunctionArg[];
  outputs: FunctionArg[];
  defaults: number;
  returnsSet: boolean;
  returnType: string;
  returnTypType: string;
  returnRelid: string;
}

async function loadFunctions(q: Queryable, name: string): Promise<FunctionMeta[]> {
  const result = await q.query<{
    argnames: string[];
    argmodes: string[];
    argtypes: string[];
    ndefaults: number;
    retset: boolean;
    rettype: string;
    rettyptype: string;
    retrelid: string;
  }>(
    `select coalesce(p.proargnames, array[]::text[]) as argnames,
            coalesce(p.proargmodes::text[], array[]::text[]) as argmodes,
            array(select pg_catalog.format_type(t.typ, null)
                    from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as t(typ, ord)
                   order by t.ord) as argtypes,
            p.pronargdefaults::int as ndefaults,
            p.proretset as retset,
            pg_catalog.format_type(p.prorettype, null) as rettype,
            rt.typtype::text as rettyptype,
            rt.typrelid::int8::text as retrelid
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_type rt on rt.oid = p.prorettype
      where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f'`,
    [name],
  );
  const functions: FunctionMeta[] = [];
  for (const row of result.rows) {
    const modes = row.argmodes.length ? row.argmodes : row.argtypes.map(() => 'i');
    const inputs: FunctionArg[] = [];
    const outputs: FunctionArg[] = [];
    modes.forEach((mode, index) => {
      const arg = { name: row.argnames[index] ?? '', type: row.argtypes[index], variadic: mode === 'v' };
      if (mode === 'i' || mode === 'b' || mode === 'v') inputs.push(arg);
      if (mode === 'o' || mode === 'b' || mode === 't') outputs.push(arg);
    });
    let returnOutputs = outputs;
    if (outputs.length === 0 && row.rettyptype === 'c') {
      const attrs = await q.query<{ name: string; type: string }>(
        `select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type
           from pg_catalog.pg_attribute a
          where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped order by a.attnum`,
        [row.retrelid],
      );
      returnOutputs = attrs.rows.map((a) => ({ name: a.name, type: a.type, variadic: false }));
    }
    functions.push({
      inputs,
      outputs: returnOutputs,
      defaults: row.ndefaults,
      returnsSet: row.retset,
      returnType: row.rettype,
      returnTypType: row.rettyptype,
      returnRelid: row.retrelid,
    });
  }
  return functions;
}

function functionNotFound(name: string, keys: string[]): PgrstError {
  const sorted = [...keys].sort();
  const details =
    sorted.length === 0
      ? `Searched for the function public.${name} without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`
      : `Searched for the function public.${name} with parameters ${sorted.join(', ')} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`;
  return new PgrstError(
    404,
    'PGRST202',
    `Could not find the function public.${name}(${sorted.join(', ')}) in the schema cache`,
    details,
  );
}

function matchesArgs(fn: FunctionMeta, keys: string[]): boolean {
  if (fn.inputs.some((arg) => arg.name === '')) return false;
  const names = new Set(fn.inputs.map((arg) => arg.name));
  if (!keys.every((key) => names.has(key))) return false;
  const firstOptional = fn.inputs.length - fn.defaults;
  return fn.inputs.every((arg, index) => index >= firstOptional || keys.includes(arg.name));
}

function isSingleUnnamedJson(fn: FunctionMeta): boolean {
  return fn.inputs.length === 1 && fn.inputs[0].name === '' && (fn.inputs[0].type === 'json' || fn.inputs[0].type === 'jsonb');
}

async function handleRpc(req: LbRequest, fnName: string, auth: RestAuth, deps: RestDeps): Promise<LbResponse> {
  const method = req.method;
  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    throw new PgrstError(405, 'PGRST101', `Cannot use the ${method} method on RPC`);
  }
  const readOnly = method !== 'POST';
  const prefer = parsePrefer(header(req, 'prefer'));
  const accept = negotiateAccept(header(req, 'accept'));
  if (prefer.paramsSingleObject) {
    throw parseFailure('Prefer: params=single-object is not supported by localbase');
  }
  if (!readOnly) checkContentType(req);

  let bodyArgs: Record<string, unknown> | null = null;
  if (!readOnly) {
    const payload = req.body.trim() === '' ? {} : parseJsonBody(req.body);
    if (!isPlainObject(payload)) throw new PgrstError(400, 'PGRST102', 'Empty or invalid json');
    bodyArgs = payload;
  }

  return runRequestTransaction(deps, auth, req, readOnly, async (q) => {
    const functions = await loadFunctions(q, fnName);
    const inputNames = new Set(functions.flatMap((fn) => fn.inputs.map((arg) => arg.name)));
    const query = parseQuery(req.url.searchParams, readOnly ? (name) => inputNames.has(name) : () => false);
    if (query.columns || query.onConflict) throw parseFailure('columns and on_conflict are not valid for RPC');

    const argsObject: Record<string, unknown> = bodyArgs ?? query.rpcArgs;
    const rawArgs = bodyArgs ? (req.body.trim() === '' ? '{}' : req.body) : JSON.stringify(query.rpcArgs);
    const keys = Object.keys(argsObject);
    let candidates = functions.filter((fn) => matchesArgs(fn, keys));
    let singleJson = false;
    if (candidates.length === 0 && !readOnly) {
      candidates = functions.filter(isSingleUnnamedJson);
      singleJson = candidates.length > 0;
    }
    if (candidates.length === 0) throw functionNotFound(fnName, keys);
    if (candidates.length > 1) {
      throw new PgrstError(
        300,
        'PGRST203',
        `Could not choose the best candidate function between: ${candidates
          .map((fn) => `public.${fnName}(${fn.inputs.map((a) => `${a.name} => ${a.type}`).join(', ')})`)
          .join(', ')}`,
        null,
        'Try renaming the parameters or the function itself in the database so function overloading can be resolved',
      );
    }
    const fn = candidates[0];
    const params = new Params();
    let fromArgs = '';
    let callArgs = '';
    if (singleJson) {
      callArgs = `${params.add(rawArgs)}::${fn.inputs[0].type}`;
    } else if (keys.length > 0) {
      const byName = new Map(fn.inputs.map((arg) => [arg.name, arg]));
      const p = params.add(rawArgs);
      fromArgs = `pg_catalog.json_to_record(${p}::json) AS _(${keys
        .map((k) => `${quoteIdent(k)} ${byName.get(k)?.type}`)
        .join(', ')})`;
      callArgs = keys
        .map((k) => `${byName.get(k)?.variadic ? 'VARIADIC ' : ''}${quoteIdent(k)} := _.${quoteIdent(k)}`)
        .join(', ');
    }
    const call = `"public".${quoteIdent(fnName)}(${callArgs})`;
    const fromPrefix = fromArgs ? `${fromArgs}, LATERAL ` : '';
    const hasShaping =
      query.select !== null || query.conditions.length > 0 || query.order.length > 0 || query.limit !== null || query.offset !== null;

    if (fn.returnType === 'void') {
      if (hasShaping) throw parseFailure('select, filters, order and limits are not valid for a void function');
      await q.query(`SELECT ${call}${fromArgs ? ` FROM ${fromArgs}` : ''}`, params.values);
      return { value: { status: 204, headers: {} }, rollback: false };
    }

    const composite = fn.outputs.length > 0;
    if (!fn.returnsSet) {
      if (hasShaping) throw parseFailure('select, filters, order and limits are only supported on set-returning functions by localbase');
      const sql = composite
        ? `SELECT pg_catalog.to_json(pgrst_call)::text AS body FROM ${fromPrefix}${call} AS pgrst_call`
        : `SELECT pg_catalog.to_json(${call})::text AS body${fromArgs ? ` FROM ${fromArgs}` : ''}`;
      const result = await q.query<{ body: string | null }>(sql, params.values);
      const body = result.rows[0]?.body ?? 'null';
      const headers: Record<string, string> = {
        'Content-Type': contentType({ kind: accept.kind, stripNulls: false }),
        'Content-Range': '0-0/*',
      };
      return { value: { status: 200, headers, body: method === 'HEAD' ? undefined : body }, rollback: false };
    }

    const { offset, limit } = resolvePage(req, query, deps.maxRows);
    let sql: string;
    if (!composite) {
      if (hasShaping && (query.select !== null || query.conditions.length > 0 || query.order.length > 0)) {
        throw parseFailure('select, filters and order on functions returning a set of scalars are not supported by localbase');
      }
      const agg = aggregateColumns(false, '_postgrest_t.pgrst_scalar');
      const countSql = prefer.count ? '(SELECT pg_catalog.count(*) FROM pgrst_source)::int8::text' : 'null::text';
      sql =
        `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM ${fromPrefix}${call} AS pgrst_call(pgrst_scalar)), ` +
        `pgrst_page AS (SELECT * FROM pgrst_source LIMIT ${limit} OFFSET ${offset}) ` +
        `SELECT ${countSql} AS total, pg_catalog.count(_postgrest_t)::int8::text AS page_total, ${agg.body} AS body, ${agg.first} AS first ` +
        `FROM (SELECT * FROM pgrst_page) _postgrest_t`;
    } else {
      const rel: RelationMeta = {
        name: fnName,
        columns: new Map(fn.outputs.map((o) => [o.name, { name: o.name, type: o.type }])),
        primaryKey: [],
      };
      const qualifier = 'pgrst_call';
      const selectList = buildSelectList(query.select, rel, qualifier);
      const where = buildWhere(query.conditions, rel, params, qualifier);
      const order = buildOrder(query.order, rel, qualifier);
      const agg = aggregateColumns(accept.stripNulls);
      const countSql = prefer.count ? `(SELECT pg_catalog.count(*) FROM pgrst_source pgrst_call${where})::int8::text` : 'null::text';
      sql =
        `WITH pgrst_source AS (SELECT pgrst_call.* FROM ${fromPrefix}${call} AS pgrst_call), ` +
        `pgrst_page AS (SELECT ${selectList} FROM pgrst_source pgrst_call${where}${order} LIMIT ${limit} OFFSET ${offset}) ` +
        `SELECT ${countSql} AS total, pg_catalog.count(_postgrest_t)::int8::text AS page_total, ${agg.body} AS body, ${agg.first} AS first ` +
        `FROM (SELECT * FROM pgrst_page) _postgrest_t`;
    }
    const result = await q.query<ResultRow>(sql, params.values);
    const row = result.rows[0];
    const pageTotal = Number.parseInt(row.page_total, 10);
    if (prefer.handling === 'strict' && prefer.maxAffected !== null && pageTotal > prefer.maxAffected) {
      throw new PgrstError(400, 'PGRST124', 'Query result exceeds max-affected preference constraint', `The query affects ${pageTotal} rows`);
    }
    const { response } = readResponse(req, row, offset, accept, prefer);
    return { value: response, rollback: accept.kind === 'object' && pageTotal !== 1 };
  });
}

const OPENAPI_STUB = JSON.stringify({
  swagger: '2.0',
  info: { title: 'localbase (PostgREST 12 subset)', version: '12' },
  paths: {},
});

export async function handleRest(req: LbRequest, auth: RestAuth, deps: RestDeps): Promise<LbResponse> {
  try {
    schemaCheck(req);
    const rest = req.url.pathname.slice('/rest/v1'.length);
    const segments = rest.split('/').filter((s) => s !== '');
    let decoded: string[];
    try {
      decoded = segments.map((s) => decodeURIComponent(s));
    } catch {
      throw new PgrstError(404, 'PGRST125', 'Invalid path specified in request URL');
    }
    if (decoded.length === 0) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new PgrstError(405, 'PGRST117', `Unsupported HTTP method: ${req.method}`);
      return { status: 200, headers: { 'Content-Type': 'application/openapi+json; charset=utf-8' }, body: OPENAPI_STUB };
    }
    if (decoded.length === 1) return await handleRelation(req, decoded[0], auth, deps);
    if (decoded.length === 2 && decoded[0] === 'rpc') return await handleRpc(req, decoded[1], auth, deps);
    throw new PgrstError(404, 'PGRST125', 'Invalid path specified in request URL');
  } catch (error) {
    return errorResponse(error, auth, deps.log);
  }
}
