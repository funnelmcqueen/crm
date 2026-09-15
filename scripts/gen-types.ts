/**
 * Introspects the database built from supabase/migrations (in-memory localbase) and writes
 * src/lib/database.types.ts in the format of `supabase gen types typescript`.
 *
 *   npm run db:types                       # writes src/lib/database.types.ts
 *   npm run db:types -- --stdout           # print instead of writing
 *   npm run db:types -- --migrations DIR --out FILE
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createDatabase, listMigrationFiles } from '../localbase/db';

export const DEFAULT_OUT = 'src/lib/database.types.ts';
export const DEFAULT_MIGRATIONS = 'supabase/migrations';
export const STAGE1_MIGRATIONS = [
  '20260915000100_core_schema.sql',
  '20260915000200_rls.sql',
  '20260915000300_core_rpcs.sql',
];
/** PostgREST major version served by Supabase (and emulated by localbase). */
export const POSTGREST_VERSION = '12';

interface TypeRow {
  oid: string;
  name: string;
  typtype: string;
  schema: string;
  category: string;
  elem: string;
  base: string;
  relid: string;
}

interface RelationRow {
  oid: string;
  name: string;
  kind: string;
  schema: string;
  updatable_mask: number;
}

interface ColumnRow {
  relid: string;
  name: string;
  notnull: boolean;
  hasdef: boolean;
  identity: string;
  generated: string;
  typid: string;
  updatable: boolean;
}

interface RelationshipRow {
  name: string;
  source: string;
  target: string;
  columns: string[];
  refcolumns: string[];
  one_to_one: boolean;
}

interface FunctionRow {
  name: string;
  argnames: string[];
  argmodes: string[];
  argtypes: string[];
  ndefaults: number;
  retset: boolean;
  rettype: string;
}

interface EnumRow {
  name: string;
  vals: string[];
}

export interface SchemaInfo {
  types: Map<string, TypeRow>;
  relations: RelationRow[];
  relationsByOid: Map<string, RelationRow>;
  columns: ColumnRow[];
  relationships: RelationshipRow[];
  functions: FunctionRow[];
  enums: EnumRow[];
}

export async function introspect(db: PGlite): Promise<SchemaInfo> {
  const types = await db.query<TypeRow>(
    `select t.oid::int8::text as oid, t.typname::text as name, t.typtype::text as typtype, n.nspname::text as schema,
            t.typcategory::text as category, t.typelem::int8::text as elem, t.typbasetype::int8::text as base,
            t.typrelid::int8::text as relid
       from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace`,
  );
  const relations = await db.query<RelationRow>(
    `select c.oid::int8::text as oid, c.relname::text as name, c.relkind::text as kind, n.nspname::text as schema,
            pg_catalog.pg_relation_is_updatable(c.oid, false) as updatable_mask
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c')
      order by c.relname`,
  );
  const columns = await db.query<ColumnRow>(
    `select a.attrelid::int8::text as relid, a.attname::text as name, a.attnotnull as notnull, a.atthasdef as hasdef,
            a.attidentity::text as identity, a.attgenerated::text as generated, a.atttypid::int8::text as typid,
            pg_catalog.pg_column_is_updatable(a.attrelid, a.attnum, false) as updatable
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c') and a.attnum > 0 and not a.attisdropped`,
  );
  const relationships = await db.query<RelationshipRow>(
    `select con.conname::text as name, src.relname::text as source, tgt.relname::text as target,
            array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord) as columns,
            array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                    join pg_catalog.pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord) as refcolumns,
            exists(select 1 from pg_catalog.pg_index i
                    where i.indrelid = con.conrelid and i.indisunique and i.indnatts = cardinality(con.conkey)
                      and i.indkey::int2[] @> con.conkey and con.conkey @> i.indkey::int2[]) as one_to_one
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class src on src.oid = con.conrelid
       join pg_catalog.pg_namespace sn on sn.oid = src.relnamespace
       join pg_catalog.pg_class tgt on tgt.oid = con.confrelid
       join pg_catalog.pg_namespace tn on tn.oid = tgt.relnamespace
      where con.contype = 'f' and sn.nspname = 'public' and tn.nspname = 'public'
      order by con.conname`,
  );
  const functions = await db.query<FunctionRow>(
    `select p.proname::text as name,
            coalesce(p.proargnames, array[]::text[]) as argnames,
            coalesce(p.proargmodes::text[], array[]::text[]) as argmodes,
            array(select t.typ::int8::text from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality t(typ, ord)
                   order by t.ord) as argtypes,
            p.pronargdefaults::int as ndefaults, p.proretset as retset, p.prorettype::int8::text as rettype
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_type rt on rt.oid = p.prorettype
      where n.nspname = 'public' and p.prokind = 'f' and rt.typname not in ('trigger', 'event_trigger')
      order by p.proname, p.oid`,
  );
  const enums = await db.query<EnumRow>(
    `select t.typname::text as name, array_agg(e.enumlabel::text order by e.enumsortorder) as vals
       from pg_catalog.pg_type t
       join pg_catalog.pg_enum e on e.enumtypid = t.oid
       join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
      order by t.typname`,
  );
  return {
    types: new Map(types.rows.map((t) => [t.oid, t])),
    relations: relations.rows,
    relationsByOid: new Map(relations.rows.map((r) => [r.oid, r])),
    columns: columns.rows,
    relationships: relationships.rows,
    functions: functions.rows,
    enums: enums.rows,
  };
}

const NUMBER_TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid', 'money']);
const STRING_TYPES = new Set([
  'bytea', 'bpchar', 'varchar', 'date', 'text', 'citext', 'time', 'timetz', 'timestamp', 'timestamptz', 'uuid',
  'vector', 'interval', 'name', 'char', 'inet', 'cidr', 'macaddr', 'macaddr8', 'tsvector', 'tsquery', 'xml', 'bit',
  'varbit', 'regclass', 'regtype', 'regproc', 'regprocedure', 'regrole', 'regnamespace',
]);

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function tsType(info: SchemaInfo, oid: string, depth = 0): string {
  const t = info.types.get(oid);
  if (!t || depth > 10) return 'unknown';
  if (t.typtype === 'd') return tsType(info, t.base, depth + 1);
  if (t.category === 'A' && t.elem !== '0') {
    const inner = tsType(info, t.elem, depth + 1);
    return /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  if (t.typtype === 'e') return t.schema === 'public' ? `Database["public"]["Enums"][${JSON.stringify(t.name)}]` : 'string';
  if (t.typtype === 'c') {
    const rel = info.relationsByOid.get(t.relid);
    if (!rel) return 'Record<string, unknown>';
    if (rel.kind === 'c') return `Database["public"]["CompositeTypes"][${JSON.stringify(rel.name)}]`;
    if (rel.kind === 'v' || rel.kind === 'm') return `Database["public"]["Views"][${JSON.stringify(rel.name)}]["Row"]`;
    return `Database["public"]["Tables"][${JSON.stringify(rel.name)}]["Row"]`;
  }
  if (t.name === 'void') return 'undefined';
  if (t.name === 'record') return 'Record<string, unknown>';
  if (t.name === 'bool') return 'boolean';
  if (NUMBER_TYPES.has(t.name)) return 'number';
  if (t.name === 'json' || t.name === 'jsonb') return 'Json';
  if (STRING_TYPES.has(t.name)) return 'string';
  return 'unknown';
}

function block(indent: number, header: string, lines: string[], footer = '}'): string[] {
  const pad = ' '.repeat(indent);
  if (lines.length === 0) return [`${pad}${header}`, `${pad}  [_ in never]: never`, `${pad}${footer}`];
  return [`${pad}${header}`, ...lines, `${pad}${footer}`];
}

function renderRelationships(info: SchemaInfo, relation: string, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const rels = info.relationships.filter((r) => r.source === relation);
  if (rels.length === 0) return [`${pad}Relationships: []`];
  const out = [`${pad}Relationships: [`];
  for (const r of rels) {
    out.push(
      `${pad}  {`,
      `${pad}    foreignKeyName: ${JSON.stringify(r.name)}`,
      `${pad}    columns: [${r.columns.map((c) => JSON.stringify(c)).join(', ')}]`,
      `${pad}    isOneToOne: ${r.one_to_one}`,
      `${pad}    referencedRelation: ${JSON.stringify(r.target)}`,
      `${pad}    referencedColumns: [${r.refcolumns.map((c) => JSON.stringify(c)).join(', ')}]`,
      `${pad}  },`,
    );
  }
  out.push(`${pad}]`);
  return out;
}

function renderRelation(info: SchemaInfo, rel: RelationRow, isView: boolean): string[] {
  const cols = info.columns.filter((c) => c.relid === rel.oid).sort((a, b) => byName(a.name, b.name));
  const pad = ' '.repeat(10);
  const row = cols.map((c) => `${pad}${key(c.name)}: ${tsType(info, c.typid)}${c.notnull ? '' : ' | null'}`);
  const out = [`      ${key(rel.name)}: {`, ...block(8, 'Row: {', row)];
  const updatable = !isView || (rel.updatable_mask & 20) === 20;
  if (updatable) {
    const neverCol = (c: ColumnRow) => c.generated === 's' || c.identity === 'a' || (isView && !c.updatable);
    const insert = cols.map((c) => {
      if (neverCol(c)) return `${pad}${key(c.name)}?: never`;
      const optional = isView || !c.notnull || c.hasdef || c.identity === 'd';
      return `${pad}${key(c.name)}${optional ? '?' : ''}: ${tsType(info, c.typid)}${c.notnull ? '' : ' | null'}`;
    });
    const update = cols.map((c) =>
      neverCol(c) ? `${pad}${key(c.name)}?: never` : `${pad}${key(c.name)}?: ${tsType(info, c.typid)}${c.notnull ? '' : ' | null'}`,
    );
    out.push(...block(8, 'Insert: {', insert), ...block(8, 'Update: {', update));
  }
  out.push(...renderRelationships(info, rel.name, 8), '      }');
  return out;
}

function renderFunctionVariant(info: SchemaInfo, fn: FunctionRow, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const modes = fn.argmodes.length ? fn.argmodes : fn.argtypes.map(() => 'i');
  const inputs: { name: string; typid: string; optional: boolean }[] = [];
  const outputs: { name: string; typid: string }[] = [];
  const inputCount = modes.filter((m) => m === 'i' || m === 'b' || m === 'v').length;
  let inputIndex = 0;
  modes.forEach((mode, index) => {
    const name = fn.argnames[index] ?? '';
    if (mode === 'i' || mode === 'b' || mode === 'v') {
      inputs.push({ name, typid: fn.argtypes[index], optional: inputIndex >= inputCount - fn.ndefaults });
      inputIndex += 1;
    }
    if (mode === 'o' || mode === 'b' || mode === 't') outputs.push({ name, typid: fn.argtypes[index] });
  });

  const out: string[] = [];
  if (inputs.length === 0) {
    out.push(`${pad}Args: never`);
  } else {
    out.push(`${pad}Args: {`);
    for (const arg of [...inputs].sort((a, b) => byName(a.name, b.name))) {
      out.push(`${pad}  ${key(arg.name)}${arg.optional ? '?' : ''}: ${tsType(info, arg.typid)}`);
    }
    out.push(`${pad}}`);
  }

  const retType = info.types.get(fn.rettype);
  const retRel = retType?.typtype === 'c' ? info.relationsByOid.get(retType.relid) : undefined;
  if (outputs.length > 0) {
    out.push(`${pad}Returns: {`);
    for (const o of [...outputs].sort((a, b) => byName(a.name, b.name))) {
      out.push(`${pad}  ${key(o.name)}: ${tsType(info, o.typid)}`);
    }
    out.push(`${pad}}${fn.retset ? '[]' : ''}`);
  } else {
    const base = tsType(info, fn.rettype);
    out.push(`${pad}Returns: ${fn.retset ? (/[ |]/.test(base) ? `(${base})[]` : `${base}[]`) : base}`);
  }
  if (retRel && (retRel.kind === 'r' || retRel.kind === 'p' || retRel.kind === 'v' || retRel.kind === 'm')) {
    out.push(
      `${pad}SetofOptions: {`,
      `${pad}  from: "*"`,
      `${pad}  to: ${JSON.stringify(retRel.name)}`,
      `${pad}  isOneToOne: ${!fn.retset}`,
      `${pad}  isSetofReturn: ${fn.retset}`,
      `${pad}}`,
    );
  }
  return out;
}

function renderFunctions(info: SchemaInfo): string[] {
  const grouped = new Map<string, FunctionRow[]>();
  for (const fn of info.functions) grouped.set(fn.name, [...(grouped.get(fn.name) ?? []), fn]);
  const lines: string[] = [];
  for (const name of [...grouped.keys()].sort(byName)) {
    const variants = grouped.get(name) ?? [];
    if (variants.length === 1) {
      lines.push(`      ${key(name)}: {`, ...renderFunctionVariant(info, variants[0], 8), '      }');
    } else {
      lines.push(`      ${key(name)}:`);
      for (const variant of variants) {
        lines.push('        | {', ...renderFunctionVariant(info, variant, 12), '          }');
      }
    }
  }
  return lines;
}

const HELPERS = `type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
`;

export function renderTypes(info: SchemaInfo): string {
  const tables = info.relations.filter((r) => r.kind === 'r' || r.kind === 'p' || r.kind === 'f');
  const views = info.relations.filter((r) => r.kind === 'v' || r.kind === 'm');
  const composites = info.relations.filter((r) => r.kind === 'c');

  const lines: string[] = [
    'export type Json =',
    '  | string',
    '  | number',
    '  | boolean',
    '  | null',
    '  | { [key: string]: Json | undefined }',
    '  | Json[]',
    '',
    'export type Database = {',
    '  // Allows to automatically instantiate createClient with right options',
    "  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)",
    '  __InternalSupabase: {',
    `    PostgrestVersion: ${JSON.stringify(POSTGREST_VERSION)}`,
    '  }',
    '  public: {',
    ...block(4, 'Tables: {', tables.flatMap((t) => renderRelation(info, t, false))),
    ...block(4, 'Views: {', views.flatMap((v) => renderRelation(info, v, true))),
    ...block(4, 'Functions: {', renderFunctions(info)),
    ...block(
      4,
      'Enums: {',
      info.enums.map((e) => `      ${key(e.name)}: ${e.vals.map((v) => JSON.stringify(v)).join(' | ')}`),
    ),
    ...block(
      4,
      'CompositeTypes: {',
      composites.flatMap((c) => {
        const attrs = info.columns.filter((col) => col.relid === c.oid).sort((a, b) => byName(a.name, b.name));
        return [
          `      ${key(c.name)}: {`,
          ...attrs.map((a) => `        ${key(a.name)}: ${tsType(info, a.typid)} | null`),
          '      }',
        ];
      }),
    ),
    '  }',
    '}',
    '',
    HELPERS,
    'export const Constants = {',
    '  public: {',
    '    Enums: {',
    ...info.enums.map((e) => `      ${key(e.name)}: [${e.vals.map((v) => JSON.stringify(v)).join(', ')}],`),
    '    },',
    '  },',
    '} as const',
    '',
  ];
  return lines.join('\n');
}

export async function generateTypes(db: PGlite): Promise<string> {
  return renderTypes(await introspect(db));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const toStdout = args.includes('--stdout');
  const migrationsDir = path.resolve(valueOf('--migrations') ?? DEFAULT_MIGRATIONS);
  const outArg = valueOf('--out');
  const out = path.resolve(outArg ?? DEFAULT_OUT);

  if (!toStdout && !outArg) {
    const present = new Set(existsSync(migrationsDir) ? listMigrationFiles(migrationsDir) : []);
    const missing = STAGE1_MIGRATIONS.filter((file) => !present.has(file));
    if (missing.length > 0) {
      console.error(`[db:types] missing stage-1 migrations (${missing.join(', ')}); ${DEFAULT_OUT} left untouched`);
      process.exit(1);
    }
  }

  let db: PGlite;
  try {
    db = await createDatabase({ migrationsDir });
  } catch (error) {
    console.error(`[db:types] migrations did not apply cleanly; nothing written.\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const content = await generateTypes(db);
  await db.close();
  if (toStdout) {
    process.stdout.write(content);
    return;
  }
  writeFileSync(out, content.replace(/\r\n/g, '\n'), 'utf8');
  console.log(`[db:types] wrote ${path.relative(process.cwd(), out)}`);
}

if (/[\\/]scripts[\\/]gen-types\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
