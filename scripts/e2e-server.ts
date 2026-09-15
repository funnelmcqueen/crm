/**
 * Playwright webServer: an in-memory seeded localbase plus `next dev` wired to it with the mock dialer.
 * Every run starts from the same fresh seed, so specs may mutate the rows of the agent they own.
 *
 * Env overrides: E2E_APP_PORT (default 3170), E2E_LOCALBASE_PORT (default 54370).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runSeed } from '../localbase/cli';
import { startLocalbase, type Localbase } from '../localbase/server';

const APP_PORT = Number.parseInt(process.env.E2E_APP_PORT ?? '3170', 10);
const LOCALBASE_PORT = Number.parseInt(process.env.E2E_LOCALBASE_PORT ?? '54370', 10);
const APP_URL = `http://localhost:${APP_PORT}`;
const READY_TIMEOUT_MS = 180_000;
// Compiling these on first request can take several seconds each in dev; doing it here keeps test timeouts honest.
const WARM_PATHS = ['/login', '/dashboard', '/leads', '/next', '/api/voice/token'];

let localbase: Localbase | null = null;
let next: ChildProcess | null = null;
let stopping = false;

function log(message: string): void {
  console.log(`[e2e-server] ${message}`);
}

/** Kills `next dev` and everything it spawned. On Windows signals do not reach the process tree, so use taskkill. */
function killNext(): void {
  const child = next;
  next = null;
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    killNext();
    await localbase?.stop().catch((error: unknown) => console.error('[e2e-server] stopping localbase failed:', error));
  }
  process.exit(code);
}

async function waitForApp(deadline: number): Promise<void> {
  for (;;) {
    if (next === null || next.exitCode !== null) throw new Error('next dev exited before it was ready');
    try {
      const response = await fetch(`${APP_URL}/login`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`next dev did not answer on ${APP_URL} within ${READY_TIMEOUT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function warm(): Promise<void> {
  for (const pathname of WARM_PATHS) {
    const method = pathname.startsWith('/api/') ? 'POST' : 'GET';
    const started = Date.now();
    try {
      const response = await fetch(`${APP_URL}${pathname}`, { method, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      log(`warmed ${method} ${pathname} -> ${response.status} in ${Date.now() - started}ms`);
    } catch (error) {
      log(`warming ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function main(): Promise<void> {
  const nextBin = path.resolve('node_modules/next/dist/bin/next');
  if (!existsSync(nextBin)) throw new Error(`next is not installed (${nextBin} missing)`);

  localbase = await startLocalbase({ port: LOCALBASE_PORT, silent: true });
  log(`localbase (in-memory) on ${localbase.url}`);
  if (!(await runSeed(localbase))) throw new Error('seeding failed: scripts/seed.ts is missing or exports no seed()');
  log('seed complete');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: localbase.url,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: localbase.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: localbase.serviceRoleKey,
    APP_BASE_URL: APP_URL,
    DIALER_DRIVER: 'mock',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  // Spawning node directly (not the .cmd shim) needs no shell on Windows and gives a pid taskkill can walk.
  next = spawn(process.execPath, [nextBin, 'dev', '--port', String(APP_PORT)], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  next.on('exit', (code, signal) => {
    if (stopping) return;
    log(`next dev exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    void shutdown(code ?? 1);
  });
  next.on('error', (error) => {
    console.error('[e2e-server] failed to start next dev:', error);
    void shutdown(1);
  });

  await waitForApp(Date.now() + READY_TIMEOUT_MS);
  await warm();
  log(`ready on ${APP_URL}`);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(signal, () => void shutdown(0));
}
// Last resort when the process is ending without a signal handler running (e.g. an uncaught error).
process.on('exit', () => killNext());

main().catch((error: unknown) => {
  console.error('[e2e-server]', error instanceof Error ? error.message : error);
  void shutdown(1);
});
