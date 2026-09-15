// Scans Next.js client build output for server-only secrets (SPEC 12). Used by `npm run check:bundle`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Server-only values that must never appear in anything a browser can download. */
export const SECRET_ENV_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET'] as const;

/** Shorter values would match by accident and are not realistic secrets. */
const MIN_SECRET_LENGTH = 8;

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{2,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;

export interface NamedSecret {
  name: string;
  value: string;
}

export interface BundleFile {
  path: string;
  content: string;
}

/** `reason` is the environment variable name or "service_role JWT". It never contains the secret. */
export interface BundleLeak {
  file: string;
  reason: string;
}

export interface ScanResult {
  scannedFiles: number;
  checkedSecrets: string[];
  leaks: BundleLeak[];
}

export function collectSecrets(env: Readonly<Record<string, string | undefined>>): NamedSecret[] {
  const secrets: NamedSecret[] = [];
  for (const name of SECRET_ENV_KEYS) {
    const value = env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.push({ name, value });
  }
  return secrets;
}

function hasServiceRoleJwt(content: string): boolean {
  for (const match of content.matchAll(JWT_PATTERN)) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      if (typeof payload === 'object' && payload !== null && (payload as { role?: unknown }).role === 'service_role') return true;
    } catch {
      // Not a JWT after all.
    }
  }
  return false;
}

export function findBundleSecretLeaks(files: readonly BundleFile[], secrets: readonly NamedSecret[]): BundleLeak[] {
  const leaks: BundleLeak[] = [];
  for (const file of files) {
    for (const secret of secrets) {
      if (file.content.includes(secret.value)) leaks.push({ file: file.path, reason: secret.name });
    }
    if (hasServiceRoleJwt(file.content)) leaks.push({ file: file.path, reason: 'service_role JWT' });
  }
  return leaks;
}

function walk(dir: string, base: string, include: (relative: string) => boolean, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, include, out);
    else if (entry.isFile()) {
      const relative = path.relative(base, full);
      if (include(relative)) out.push(relative);
    }
  }
}

/**
 * Files under `<nextDir>/static` (every chunk, stylesheet and source map a browser can fetch) plus the
 * client reference manifests under `<nextDir>/server`. Paths are relative to nextDir.
 */
export function listClientBundleFiles(nextDir: string): string[] {
  const files: string[] = [];
  const staticDir = path.join(nextDir, 'static');
  if (existsSync(staticDir)) walk(staticDir, nextDir, () => true, files);
  const serverDir = path.join(nextDir, 'server');
  if (existsSync(serverDir)) walk(serverDir, nextDir, (relative) => relative.endsWith('_client-reference-manifest.js'), files);
  return files;
}

export function scanBuildOutput(nextDir: string, env: Readonly<Record<string, string | undefined>>): ScanResult {
  if (!existsSync(path.join(nextDir, 'static'))) {
    throw new Error(`no client build output in ${nextDir}; run \`next build\` (npm run build) first`);
  }
  const relativePaths = listClientBundleFiles(nextDir);
  const files = relativePaths.map((relative) => ({
    path: relative.split(path.sep).join('/'),
    content: readFileSync(path.join(nextDir, relative), 'utf8'),
  }));
  const secrets = collectSecrets(env);
  return { scannedFiles: files.length, checkedSecrets: secrets.map((s) => s.name), leaks: findBundleSecretLeaks(files, secrets) };
}
