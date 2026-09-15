import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MigrationError, createDatabase, listMigrationFiles } from '../../localbase/db';
import { NO_MIGRATIONS_DIR } from './helpers';

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('createDatabase', () => {
  it('boots with no migrations directory', async () => {
    const db = await createDatabase({ migrationsDir: NO_MIGRATIONS_DIR });
    const roles = await db.query<{ rolname: string }>(
      `select rolname::text as rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1`,
    );
    expect(roles.rows.map((r) => r.rolname)).toEqual(['anon', 'authenticated', 'service_role']);
    const ext = await db.query<{ extname: string }>(`select extname::text as extname from pg_extension order by 1`);
    expect(ext.rows.map((r) => r.extname)).toEqual(expect.arrayContaining(['pg_trgm', 'pgcrypto']));
    const tz = await db.query<{ tz: string }>(`select current_setting('TimeZone') as tz`);
    expect(tz.rows[0].tz).toBe('UTC');
    await db.close();
  });

  it('applies migrations in order, once, each in its own transaction, and persists to dataDir', async () => {
    const migrations = tempDir('lb-migrations-');
    const dataDir = path.join(tempDir('lb-data-'), 'data');
    writeFileSync(path.join(migrations, '0002_second.sql'), `insert into public.log (step) values ('second');`);
    writeFileSync(path.join(migrations, '0001_first.sql'), `create table public.log (step text); insert into public.log values ('first');`);
    writeFileSync(path.join(migrations, 'README.md'), 'not sql');
    expect(listMigrationFiles(migrations)).toEqual(['0001_first.sql', '0002_second.sql']);

    let db = await createDatabase({ dataDir, migrationsDir: migrations });
    expect((await db.query<{ step: string }>('select step from public.log')).rows.map((r) => r.step)).toEqual(['first', 'second']);
    await db.close();

    writeFileSync(
      path.join(migrations, '0003_broken.sql'),
      `insert into public.log (step) values ('third');\nselect * from public.does_not_exist;`,
    );
    const failure = await createDatabase({ dataDir, migrationsDir: migrations }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).file).toBe('0003_broken.sql');
    expect((failure as Error).message).toContain('line 2');

    writeFileSync(path.join(migrations, '0003_broken.sql'), `insert into public.log (step) values ('third');`);
    db = await createDatabase({ dataDir, migrationsDir: migrations });
    expect((await db.query<{ step: string }>('select step from public.log')).rows.map((r) => r.step)).toEqual([
      'first',
      'second',
      'third',
    ]);
    const applied = await db.query<{ name: string }>('select name from localbase.schema_migrations order by name');
    expect(applied.rows.map((r) => r.name)).toEqual(['0001_first.sql', '0002_second.sql', '0003_broken.sql']);
    await db.close();
  });
});
