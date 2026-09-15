/**
 * npm run dev:local: persistent localbase + seed on first run + `next dev` wired to it.
 * Extra arguments are forwarded to `next dev` (e.g. `npm run dev:local -- --port 3001`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR, runSeed } from '../localbase/cli';
import { startLocalbase } from '../localbase/server';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.LOCALBASE_PORT ?? '54321', 10);
  const lb = await startLocalbase({ port, dataDir: path.resolve(DEFAULT_DATA_DIR) });

  const profiles = await lb.db.query<{ present: boolean }>(`select to_regclass('public.profiles') is not null as present`);
  if (profiles.rows[0]?.present) {
    const count = await lb.db.query<{ n: number }>('select count(*)::int as n from public.profiles');
    if (count.rows[0].n === 0) {
      console.log('[dev:local] database has no profiles; seeding');
      await runSeed(lb);
    }
  } else {
    console.warn('[dev:local] public.profiles does not exist yet; skipping seed');
  }

  const nextBin = path.resolve('node_modules/next/dist/bin/next');
  if (!existsSync(nextBin)) throw new Error(`next is not installed (${nextBin} missing)`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: lb.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: lb.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: lb.serviceRoleKey,
    APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    DIALER_DRIVER: process.env.DIALER_DRIVER ?? 'mock',
  };
  // Spawning node directly (instead of the .cmd shim) avoids needing a shell on Windows.
  const child = spawn(process.execPath, [nextBin, 'dev', ...process.argv.slice(2)], { stdio: 'inherit', env });

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await lb.stop().catch((error: unknown) => console.error('[dev:local] stopping localbase failed:', error));
    process.exit(code);
  };
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
    // If next ignores the signal, do not hang forever.
    setTimeout(() => void shutdown(0), 5000).unref();
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    void shutdown(code ?? (signal ? 0 : 1));
  });
  child.on('error', (error) => {
    console.error('[dev:local] failed to start next dev:', error);
    void shutdown(1);
  });
}

main().catch((error: unknown) => {
  console.error('[dev:local]', error instanceof Error ? error.message : error);
  process.exit(1);
});
