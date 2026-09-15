/**
 * Parsers for the PostgREST 12 URL grammar subset that localbase supports. Anything outside the subset
 * raises a PgrstError (never silently ignored).
 */

export class PgrstError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'PgrstError';
  }
}

export function parseFailure(message: string, details: string | null = null): PgrstError {
  return new PgrstError(400, 'PGRST100', message, details);
}

export type SelectItem =
  | { kind: 'star' }
  | { kind: 'column'; name: string; alias: string | null; cast: string | null };

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'match',
  'imatch',
  'is',
  'isdistinct',
  'in',
  'cs',
  'cd',
  'ov',
  'sl',
  'sr',
  'nxr',
  'nxl',
  'adj',
  'fts',
  'plfts',
  'phfts',
  'wfts',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const QUANTIFIABLE = new Set<FilterOperator>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch']);
const FTS = new Set<FilterOperator>(['fts', 'plfts', 'phfts', 'wfts']);
export const IS_VALUES = ['null', 'not_null', 'true', 'false', 'unknown'] as const;

export interface Filter {
  kind: 'filter';
  column: string;
  negate: boolean;
  operator: FilterOperator;
  quantifier: 'any' | 'all' | null;
  language: string | null;
  /** string for scalar operators, string[] for `in`. */
  value: string | string[];
}

export interface LogicTree {
  kind: 'logic';
  operator: 'and' | 'or';
  negate: boolean;
  children: Condition[];
}

export type Condition = Filter | LogicTree;

export interface OrderTerm {
  column: string;
  direction: 'asc' | 'desc';
  nulls: 'first' | 'last' | null;
}

/** Splits on `sep` at nesting depth 0, honouring double quotes (with backslash escapes), () and {}. */
export function splitTopLevel(input: string, sep = ','): string[] {
  const parts: string[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      current += ch;
      if (ch === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === '(') {
      depthParen += 1;
    } else if (ch === ')') {
      depthParen -= 1;
      if (depthParen < 0) throw parseFailure(`failed to parse (${input})`, 'unbalanced parentheses');
    } else if (ch === '{') {
      depthBrace += 1;
    } else if (ch === '}') {
      depthBrace -= 1;
      if (depthBrace < 0) throw parseFailure(`failed to parse (${input})`, 'unbalanced braces');
    } else if (ch === sep && depthParen === 0 && depthBrace === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuotes || depthParen !== 0 || depthBrace !== 0) {
    throw parseFailure(`failed to parse (${input})`, 'unbalanced quotes, parentheses or braces');
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  let out = '';
  for (let i = 1; i < value.length - 1; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length - 1) {
      out += value[i + 1];
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function isQuoted(value: string): boolean {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return false;
  // The closing quote must not be escaped.
  let backslashes = 0;
  for (let i = value.length - 2; i > 0 && value[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

const BARE_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

/** Parses a column/field name: bare identifier or "quoted name". */
export function parseIdentifier(raw: string, context: string): string {
  if (raw.includes('->')) {
    throw parseFailure(`failed to parse ${context} (${raw})`, 'JSON path operators are not supported by localbase');
  }
  if (isQuoted(raw)) {
    const name = unquote(raw);
    if (name.length === 0 || name.includes('\0')) throw parseFailure(`failed to parse ${context} (${raw})`);
    return name;
  }
  if (!BARE_IDENTIFIER.test(raw)) throw parseFailure(`failed to parse ${context} (${raw})`, `invalid identifier "${raw}"`);
  return raw;
}

const CAST_TYPE = /^[A-Za-z_][A-Za-z0-9_]*(\[\])?$/;

export function parseSelect(raw: string): SelectItem[] {
  if (raw.trim() === '') return [];
  const items: SelectItem[] = [];
  for (const part of splitTopLevel(raw)) {
    const item = part.trim();
    if (item === '') throw parseFailure(`failed to parse select parameter (${raw})`, 'empty select item');
    if (item === '*') {
      items.push({ kind: 'star' });
      continue;
    }
    if (item.startsWith('...') || /[()!]/.test(item.replace(/"[^"]*"/g, ''))) {
      throw parseFailure(
        `failed to parse select parameter (${raw})`,
        'embedded resources, spreads and aggregates are not supported by localbase; use an RPC or a security_invoker view',
      );
    }
    let alias: string | null = null;
    let rest = item;
    const aliasIndex = findAliasColon(item);
    if (aliasIndex >= 0) {
      alias = parseIdentifier(item.slice(0, aliasIndex), 'select alias');
      rest = item.slice(aliasIndex + 1);
    }
    let cast: string | null = null;
    const castIndex = rest.lastIndexOf('::');
    if (castIndex >= 0 && !isInsideQuotes(rest, castIndex)) {
      cast = rest.slice(castIndex + 2);
      rest = rest.slice(0, castIndex);
      if (!CAST_TYPE.test(cast)) throw parseFailure(`failed to parse select parameter (${raw})`, `invalid cast type "${cast}"`);
    }
    const name = parseIdentifier(rest, 'select parameter');
    items.push({ kind: 'column', name, alias, cast });
  }
  return items;
}

function isInsideQuotes(value: string, index: number): boolean {
  let inQuotes = false;
  for (let i = 0; i < index; i += 1) {
    if (value[i] === '\\' && inQuotes) i += 1;
    else if (value[i] === '"') inQuotes = !inQuotes;
  }
  return inQuotes;
}

function findAliasColon(item: string): number {
  let inQuotes = false;
  for (let i = 0; i < item.length; i += 1) {
    const ch = item[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (inQuotes || ch !== ':') continue;
    if (item[i + 1] === ':') return -1;
    return i;
  }
  return -1;
}

export function parseOrder(raw: string): OrderTerm[] {
  const terms: OrderTerm[] = [];
  for (const part of splitTopLevel(raw)) {
    const item = part.trim();
    if (item === '' || /[()]/.test(item.replace(/"[^"]*"/g, ''))) {
      throw parseFailure(`failed to parse order (${raw})`, 'ordering by embedded resources is not supported by localbase');
    }
    let columnRaw: string;
    let modifiers: string[];
    if (item.startsWith('"')) {
      const close = findClosingQuote(item);
      if (close < 0) throw parseFailure(`failed to parse order (${raw})`);
      columnRaw = item.slice(0, close + 1);
      const tail = item.slice(close + 1);
      if (tail !== '' && !tail.startsWith('.')) throw parseFailure(`failed to parse order (${raw})`);
      modifiers = tail === '' ? [] : tail.slice(1).split('.');
    } else {
      const segments = item.split('.');
      columnRaw = segments[0];
      modifiers = segments.slice(1);
    }
    const column = parseIdentifier(columnRaw, 'order');
    let direction: 'asc' | 'desc' = 'asc';
    let nulls: 'first' | 'last' | null = null;
    let sawDirection = false;
    for (const modifier of modifiers) {
      if ((modifier === 'asc' || modifier === 'desc') && !sawDirection && nulls === null) {
        direction = modifier;
        sawDirection = true;
      } else if ((modifier === 'nullsfirst' || modifier === 'nullslast') && nulls === null) {
        nulls = modifier === 'nullsfirst' ? 'first' : 'last';
      } else {
        throw parseFailure(`failed to parse order (${raw})`, `unexpected "${modifier}"`);
      }
    }
    terms.push({ column, direction, nulls });
  }
  return terms;
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === '\\') i += 1;
    else if (value[i] === '"') return i;
  }
  return -1;
}

export function parseList(raw: string, context: string): string[] {
  if (!raw.startsWith('(') || !raw.endsWith(')')) {
    throw parseFailure(`failed to parse filter (${context})`, 'expected a parenthesised list');
  }
  const inner = raw.slice(1, -1);
  if (inner === '') return [];
  return splitTopLevel(inner).map((item) => (isQuoted(item) ? unquote(item) : item));
}

const OPERATOR_TOKEN = /^([a-z]+)(?:\((any|all)\)|\(([A-Za-z0-9_]+)\))?$/;

/** Parses `[not.]op[(modifier)].value` for `column`. */
export function parseFilterExpression(column: string, expression: string, inLogicTree: boolean): Filter {
  let rest = expression;
  let negate = false;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf('.');
  if (dot < 0) throw parseFailure(`failed to parse filter (${expression})`, 'expected operator.value');
  const token = rest.slice(0, dot);
  let value = rest.slice(dot + 1);
  const match = OPERATOR_TOKEN.exec(token);
  if (!match || !(FILTER_OPERATORS as readonly string[]).includes(match[1])) {
    throw parseFailure(`failed to parse filter (${expression})`, `unknown or unsupported operator "${token}"`);
  }
  const operator = match[1] as FilterOperator;
  const quantifier = (match[2] as 'any' | 'all' | undefined) ?? null;
  const language = match[3] ?? null;
  if (quantifier && !QUANTIFIABLE.has(operator)) {
    throw parseFailure(`failed to parse filter (${expression})`, `operator "${operator}" does not accept (${quantifier})`);
  }
  if (language && !FTS.has(operator)) {
    throw parseFailure(`failed to parse filter (${expression})`, `operator "${operator}" does not accept a language`);
  }

  if (operator === 'in') {
    return { kind: 'filter', column, negate, operator, quantifier, language, value: parseList(value, expression) };
  }
  if (operator === 'is') {
    const normalized = value.toLowerCase();
    if (!(IS_VALUES as readonly string[]).includes(normalized)) {
      throw parseFailure(`failed to parse filter (${expression})`, 'is accepts null, not_null, true, false or unknown');
    }
    return { kind: 'filter', column, negate, operator, quantifier, language, value: normalized };
  }
  if (quantifier) {
    if (!value.startsWith('{') || !value.endsWith('}')) {
      throw parseFailure(`failed to parse filter (${expression})`, `(${quantifier}) expects a {a,b} list`);
    }
  } else if (inLogicTree && isQuoted(value)) {
    value = unquote(value);
  }
  if (operator === 'like' || operator === 'ilike') value = value.replace(/\*/g, '%');
  return { kind: 'filter', column, negate, operator, quantifier, language, value };
}

export function parseLogicTree(key: string, raw: string): LogicTree {
  const match = /^(not\.)?(and|or)$/.exec(key);
  if (!match) throw parseFailure(`failed to parse logic tree (${key})`);
  if (!raw.startsWith('(') || !raw.endsWith(')')) {
    throw parseFailure(`failed to parse logic tree (${raw})`, 'expected "(" ... ")"');
  }
  return {
    kind: 'logic',
    operator: match[2] as 'and' | 'or',
    negate: Boolean(match[1]),
    children: parseLogicChildren(raw.slice(1, -1), raw),
  };
}

function parseLogicChildren(inner: string, whole: string): Condition[] {
  if (inner.trim() === '') throw parseFailure(`failed to parse logic tree (${whole})`, 'empty logic tree');
  return splitTopLevel(inner).map((part) => {
    const nested = /^(not\.)?(and|or)\(/.exec(part);
    if (nested && part.endsWith(')')) {
      return {
        kind: 'logic',
        operator: nested[2] as 'and' | 'or',
        negate: Boolean(nested[1]),
        children: parseLogicChildren(part.slice(nested[0].length, -1), whole),
      } satisfies LogicTree;
    }
    let fieldRaw: string;
    let rest: string;
    if (part.startsWith('"')) {
      const close = findClosingQuote(part);
      if (close < 0 || part[close + 1] !== '.') throw parseFailure(`failed to parse logic tree (${whole})`);
      fieldRaw = part.slice(0, close + 1);
      rest = part.slice(close + 2);
    } else {
      const dot = part.indexOf('.');
      if (dot < 0) throw parseFailure(`failed to parse logic tree (${whole})`, `"${part}" is not column.operator.value`);
      fieldRaw = part.slice(0, dot);
      rest = part.slice(dot + 1);
    }
    const column = parseIdentifier(fieldRaw, 'logic tree');
    return parseFilterExpression(column, rest, true);
  });
}

export interface ParsedQuery {
  /** null when the select parameter is absent. */
  select: SelectItem[] | null;
  conditions: Condition[];
  order: OrderTerm[];
  limit: number | null;
  offset: number | null;
  columns: string[] | null;
  onConflict: string[] | null;
  /** Query parameters claimed as RPC arguments (GET/HEAD rpc only). */
  rpcArgs: Record<string, string>;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict', 'or', 'and', 'not.or', 'not.and']);

function lastValue(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length ? values[values.length - 1] : null;
}

function parseNonNegativeInt(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw parseFailure(`failed to parse ${name} parameter (${raw})`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) throw parseFailure(`failed to parse ${name} parameter (${raw})`);
  return value;
}

export function parseQuery(params: URLSearchParams, isRpcArg: (name: string) => boolean = () => false): ParsedQuery {
  const selectRaw = lastValue(params, 'select');
  const orderRaw = lastValue(params, 'order');
  const limitRaw = lastValue(params, 'limit');
  const offsetRaw = lastValue(params, 'offset');
  const columnsRaw = lastValue(params, 'columns');
  const onConflictRaw = lastValue(params, 'on_conflict');

  const conditions: Condition[] = [];
  const rpcArgs: Record<string, string> = {};
  for (const [key, value] of params) {
    if (RESERVED.has(key)) {
      if (key === 'or' || key === 'and' || key === 'not.or' || key === 'not.and') {
        conditions.push(parseLogicTree(key, value));
      }
      continue;
    }
    if (isRpcArg(key)) {
      rpcArgs[key] = value;
      continue;
    }
    if (!isQuoted(key) && key.includes('.')) {
      throw parseFailure(
        `failed to parse filter (${key})`,
        'filters, ordering or limits on embedded resources are not supported by localbase',
      );
    }
    const column = parseIdentifier(key, 'filter');
    conditions.push(parseFilterExpression(column, value, false));
  }

  return {
    select: selectRaw === null ? null : parseSelect(selectRaw),
    conditions,
    order: orderRaw === null || orderRaw === '' ? [] : parseOrder(orderRaw),
    limit: limitRaw === null ? null : parseNonNegativeInt(limitRaw, 'limit'),
    offset: offsetRaw === null ? null : parseNonNegativeInt(offsetRaw, 'offset'),
    columns: columnsRaw === null ? null : splitTopLevel(columnsRaw).map((c) => parseIdentifier(c.trim(), 'columns')),
    onConflict:
      onConflictRaw === null ? null : splitTopLevel(onConflictRaw).map((c) => parseIdentifier(c.trim(), 'on_conflict')),
    rpcArgs,
  };
}

export interface Preferences {
  return: 'minimal' | 'representation' | 'headers-only' | null;
  count: 'exact' | 'planned' | 'estimated' | null;
  resolution: 'merge-duplicates' | 'ignore-duplicates' | null;
  missing: 'default' | 'null' | null;
  handling: 'strict' | 'lenient';
  maxAffected: number | null;
  paramsSingleObject: boolean;
  invalid: string[];
  applied: string[];
}

export function parsePrefer(headerValue: string | undefined): Preferences {
  const prefs: Preferences = {
    return: null,
    count: null,
    resolution: null,
    missing: null,
    handling: 'lenient',
    maxAffected: null,
    paramsSingleObject: false,
    invalid: [],
    applied: [],
  };
  if (!headerValue) return prefs;
  for (const rawToken of headerValue.split(',')) {
    const token = rawToken.trim();
    if (token === '') continue;
    const [name, value = ''] = token.split('=', 2).map((s) => s.trim());
    let ok = true;
    switch (name) {
      case 'return':
        if (value === 'minimal' || value === 'representation' || value === 'headers-only') prefs.return = value;
        else ok = false;
        break;
      case 'count':
        // PostgREST answers planned/estimated from planner statistics of the whole table, not from
        // the RLS-visible rows. Emulating them as exact counts would hide that leak, so refuse them.
        if (value === 'planned' || value === 'estimated') {
          throw parseFailure(`Prefer: count=${value} is not supported by localbase; use count=exact`);
        }
        if (value === 'exact') prefs.count = value;
        else ok = false;
        break;
      case 'resolution':
        if (value === 'merge-duplicates' || value === 'ignore-duplicates') prefs.resolution = value;
        else ok = false;
        break;
      case 'missing':
        if (value === 'default' || value === 'null') prefs.missing = value;
        else ok = false;
        break;
      case 'handling':
        if (value === 'strict' || value === 'lenient') prefs.handling = value;
        else ok = false;
        break;
      case 'max-affected':
        if (/^\d+$/.test(value)) prefs.maxAffected = Number.parseInt(value, 10);
        else ok = false;
        break;
      case 'params':
        if (value === 'single-object') prefs.paramsSingleObject = true;
        else ok = false;
        break;
      case 'tx':
        // PostgREST ignores tx= unless db-tx-end allows overrides; Supabase does not.
        ok = value === 'commit' || value === 'rollback';
        break;
      default:
        ok = false;
    }
    if (ok) prefs.applied.push(token);
    else prefs.invalid.push(token);
  }
  if (prefs.handling === 'strict' && prefs.invalid.length > 0) {
    throw new PgrstError(400, 'PGRST122', `Invalid preferences given with handling=strict: ${prefs.invalid.join(', ')}`);
  }
  return prefs;
}

export interface AcceptResult {
  kind: 'array' | 'object';
  stripNulls: boolean;
}

export function negotiateAccept(accept: string | undefined): AcceptResult {
  if (!accept || accept.trim() === '') return { kind: 'array', stripNulls: false };
  for (const rawRange of accept.split(',')) {
    const [typePart, ...paramParts] = rawRange.split(';').map((s) => s.trim());
    const type = typePart.toLowerCase();
    const stripNulls = paramParts.some((p) => p.replace(/\s/g, '').toLowerCase() === 'nulls=stripped');
    if (type === 'application/json' || type === '*/*' || type === 'application/*') {
      return { kind: 'array', stripNulls: false };
    }
    if (type === 'application/vnd.pgrst.array+json' || type === 'application/vnd.pgrst.array') {
      return { kind: 'array', stripNulls };
    }
    if (type === 'application/vnd.pgrst.object+json' || type === 'application/vnd.pgrst.object') {
      return { kind: 'object', stripNulls };
    }
  }
  throw new PgrstError(406, 'PGRST107', `None of these media types are available: ${accept}`);
}

export function parseRangeHeader(value: string | undefined): { lower: number; upper: number | null } | null {
  if (!value) return null;
  const match = /^\s*(?:items=)?(\d+)-(\d*)\s*$/.exec(value);
  if (!match) return null;
  const lower = Number.parseInt(match[1], 10);
  const upper = match[2] === '' ? null : Number.parseInt(match[2], 10);
  if (upper !== null && upper < lower) {
    throw new PgrstError(416, 'PGRST103', 'Requested range not satisfiable', `Invalid range ${value}`);
  }
  return { lower, upper };
}
