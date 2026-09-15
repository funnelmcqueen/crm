import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalbase, type Localbase } from './server';

export const DEFAULT_DATA_DIR = '.localbase/data';

interface CliOptions {
  reset: boolean;
  memory: boolean;
  seed: boolean;
  port: number;
  dataDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { reset: false, memory: false, seed: false, port: 54321, dataDir: DEFAULT_DATA_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--memory') options.memory = true;
    else if (arg === '--seed') options.seed = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      const port = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port value: ${raw}`);
      options.port = port;
    } else if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const raw = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      if (!raw) throw new Error('--data-dir needs a value');
      options.dataDir = raw;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run localbase -- [--reset] [--memory] [--seed] [--port N] [--data-dir DIR]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

type SeedFn = (config: { url: string; serviceRoleKey: string }) => Promise<unknown>;

/** Imports scripts/seed.ts (when present) and runs its exported seed(). Returns false if unavailable. */
export async function runSeed(instance: Pick<Localbase, 'url' | 'serviceRoleKey'>): Promise<boolean> {
  const seedPath = path.resolve('scripts/seed.ts');
  if (!existsSync(seedPath)) {
    console.warn('[localbase] scripts/seed.ts not found; skipping seed');
    return false;
  }
  const mod = (await import(pathToFileURL(seedPath).href)) as { seed?: SeedFn; default?: { seed?: SeedFn } };
  const seed = mod.seed ?? mod.default?.seed;
  if (typeof seed !== 'function') {
    console.warn('[localbase] scripts/seed.ts does not export seed(); skipping seed');
    return false;
  }
  await seed({ url: instance.url, serviceRoleKey: instance.serviceRoleKey });
  return true;
}

export function envBlock(instance: Pick<Localbase, 'url' | 'anonKey' | 'serviceRoleKey'>): string {
  return [
    `NEXT_PUBLIC_SUPABASE_URL=${instance.url}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${instance.anonKey}`,
    `SUPABASE_SERVICE_ROLE_KEY=${instance.serviceRoleKey}`,
    'APP_BASE_URL=http://localhost:3000',
    'DIALER_DRIVER=mock',
  ].join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = options.memory ? undefined : path.resolve(options.dataDir);
  if (options.reset && dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`[localbase] deleted ${dataDir}`);
  }
  const instance = await startLocalbase({ port: options.port, dataDir });
  if (options.seed) {
    const seeded = await runSeed(instance);
    if (seeded) console.log('[localbase] seed complete');
  }
  console.log('');
  console.log(`localbase is running (${dataDir ? `data: ${dataDir}` : 'in-memory'})`);
  console.log(`  API URL:          ${instance.url}`);
  console.log(`  REST:             ${instance.url}/rest/v1`);
  console.log(`  Auth:             ${instance.url}/auth/v1`);
  console.log(`  anon key:         ${instance.anonKey}`);
  console.log(`  service_role key: ${instance.serviceRoleKey}`);
  console.log(`  JWT secret:       ${instance.jwtSecret}`);
  console.log('');
  console.log('Paste into .env.local:');
  console.log('');
  console.log(envBlock(instance));
  console.log('');
  console.log('Press Ctrl+C to stop.');

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[localbase] ${signal} received, shutting down`);
    instance
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = /[\\/]localbase[\\/]cli\.ts$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[localbase] failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
