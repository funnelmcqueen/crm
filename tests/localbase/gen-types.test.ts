import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../localbase/db';
import { generateTypes } from '../../scripts/gen-types';

const dir = mkdtempSync(path.join(os.tmpdir(), 'lb-gentypes-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SCHEMA = `
create type public.mood as enum ('happy', 'sad');
create type public.point2 as (x int, y int);
create table public.people (
  id bigint generated always as identity primary key,
  name text not null,
  mood public.mood not null default 'happy',
  moods public.mood[],
  nick text,
  data jsonb,
  upper_name text generated always as (upper(name)) stored,
  created_at timestamptz not null default now()
);
create table public.pets (id uuid primary key default gen_random_uuid(), owner_id bigint not null references public.people (id), name text);
create table public.passports (person_id bigint primary key references public.people (id));
create view public.people_names with (security_invoker = true) as select id, name from public.people;
create function public.find_people(p_query text, p_moods public.mood[] default null, p_limit int default 10)
returns table (id bigint, name text, total bigint) language sql stable as $$
  select p.id, p.name, count(*) over () from public.people p limit p_limit
$$;
create function public.list_names() returns setof text language sql stable as $$ select name from public.people $$;
create function public.touch() returns void language plpgsql as $$ begin end $$;
create function public.is_happy(p_id bigint) returns boolean language sql stable as $$ select true $$;
create function public.all_people() returns setof public.people language sql stable as $$ select * from public.people $$;
create function public.trg() returns trigger language plpgsql as $$ begin return new; end $$;
`;

function compile(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2020.d.ts'],
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

describe('gen-types', () => {
  it('renders the supabase gen types format and compiles', async () => {
    const migrations = path.join(dir, 'migrations');
    rmSync(migrations, { recursive: true, force: true });
    await import('node:fs').then((fs) => fs.mkdirSync(migrations, { recursive: true }));
    writeFileSync(path.join(migrations, '0001_schema.sql'), SCHEMA);
    const db = await createDatabase({ migrationsDir: migrations });
    const output = await generateTypes(db);
    await db.close();

    expect(output).toContain('PostgrestVersion: "12"');
    expect(output).toContain('moods: Database["public"]["Enums"]["mood"][] | null');
    expect(output).toContain('id?: never');
    expect(output).toContain('upper_name?: never');
    expect(output).toContain('foreignKeyName: "pets_owner_id_fkey"');
    expect(output).toMatch(/foreignKeyName: "passports_person_id_fkey"\n\s+columns: \["person_id"\]\n\s+isOneToOne: true/);
    expect(output).toContain('people_names: {');
    expect(output).toContain('p_moods?: Database["public"]["Enums"]["mood"][]');
    expect(output).toContain('Returns: string[]');
    expect(output).toContain('Returns: undefined');
    expect(output).not.toContain('trg:');
    expect(output).toContain('mood: "happy" | "sad"');
    expect(output).toContain('mood: ["happy", "sad"],');
    expect(output).toContain('point2: {');
    expect(output).not.toContain('\r');

    const typesFile = path.join(dir, 'database.types.ts');
    writeFileSync(typesFile, output);
    const usageFile = path.join(dir, 'usage.ts');
    writeFileSync(
      usageFile,
      `import type { Constants as _C, Database, Enums, Tables, TablesInsert, TablesUpdate } from './database.types'
const row: Tables<'people'> = { id: 1, name: 'a', mood: 'happy', moods: null, nick: null, data: { a: [1] }, upper_name: 'A', created_at: 'x' }
const insert: TablesInsert<'people'> = { name: 'b' }
const update: TablesUpdate<'people'> = { nick: null }
// @ts-expect-error identity always columns cannot be inserted
const badInsert: TablesInsert<'people'> = { name: 'c', id: 5 }
const mood: Enums<'mood'> = 'sad'
type FindRow = Database['public']['Functions']['find_people']['Returns'][number]
const found: FindRow = { id: 1, name: 'x', total: 3 }
const view: Tables<'people_names'> = { id: null, name: null }
const args: Database['public']['Functions']['find_people']['Args'] = { p_query: 'x' }
export { row, insert, update, badInsert, mood, found, view, args }
`,
    );
    expect(compile([typesFile, usageFile])).toEqual([]);
  });
});
