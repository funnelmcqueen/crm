import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export interface CreateDatabaseOptions {
  /** Directory for persistent storage. Omit for an in-memory database. */
  dataDir?: string;
  /** Defaults to `supabase/migrations` relative to the current working directory. */
  migrationsDir?: string;
  log?: (message: string) => void;
}

export class MigrationError extends Error {
  constructor(
    readonly file: string,
    readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function localbaseDir(): string {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}

export function listMigrationFiles(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

interface PgErrorLike {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
}

function describeSqlError(error: unknown, sql: string): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & PgErrorLike;
  const parts = [e.code ? `${e.code}: ${e.message}` : e.message];
  const position = e.position ? Number.parseInt(e.position, 10) : Number.NaN;
  if (Number.isFinite(position)) {
    const line = sql.slice(0, position - 1).split('\n').length;
    parts.push(`at line ${line}`);
  }
  if (e.detail) parts.push(`detail: ${e.detail}`);
  if (e.hint) parts.push(`hint: ${e.hint}`);
  return parts.join(' | ');
}

/**
 * Boots PGlite with pg_trgm + pgcrypto, applies bootstrap.sql once, then every unapplied migration in
 * filename order, each in its own transaction (recorded in localbase.schema_migrations).
 */
export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<PGlite> {
  const log = options.log ?? (() => undefined);
  let dataDir: string | undefined;
  if (options.dataDir) {
    dataDir = path.resolve(options.dataDir);
    mkdirSync(dataDir, { recursive: true });
  }
  const db: PGlite = await PGlite.create({ dataDir, extensions: { pg_trgm, pgcrypto } });

  try {
    // Hosted Supabase databases run in UTC; PGlite otherwise inherits the host time zone.
    await db.exec(`SET TIME ZONE 'UTC'`);

    const marker = await db.query<{ present: boolean }>(
      `select to_regclass('localbase.schema_migrations') is not null as present`,
    );
    if (!marker.rows[0]?.present) {
      const bootstrapPath = path.join(localbaseDir(), 'bootstrap.sql');
      const bootstrapSql = readFileSync(bootstrapPath, 'utf8');
      try {
        await db.transaction(async (tx) => {
          await tx.exec(bootstrapSql);
        });
      } catch (error) {
        throw new MigrationError('bootstrap.sql', error, `bootstrap.sql failed: ${describeSqlError(error, bootstrapSql)}`);
      }
      log('applied bootstrap.sql');
    }

    // Idempotent, and applied on every boot so existing data directories pick up new views too.
    const compatPath = path.join(localbaseDir(), 'auth-compat.sql');
    const compatSql = readFileSync(compatPath, 'utf8');
    try {
      await db.transaction(async (tx) => {
        await tx.exec(compatSql);
      });
    } catch (error) {
      throw new MigrationError('auth-compat.sql', error, `auth-compat.sql failed: ${describeSqlError(error, compatSql)}`);
    }

    const migrationsDir = path.resolve(options.migrationsDir ?? 'supabase/migrations');
    const files = listMigrationFiles(migrationsDir);
    const applied = new Set(
      (await db.query<{ name: string }>('select name from localbase.schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await db.transaction(async (tx) => {
          await tx.exec(sql);
          await tx.query('insert into localbase.schema_migrations (name) values ($1)', [file]);
        });
      } catch (error) {
        throw new MigrationError(file, error, `migration ${file} failed: ${describeSqlError(error, sql)}`);
      }
      // A migration may legitimately change session settings; restore the ones localbase relies on.
      await db.exec(`RESET ROLE; SET TIME ZONE 'UTC'`);
      log(`applied migration ${file}`);
    }
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}
