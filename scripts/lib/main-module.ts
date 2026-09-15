import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `moduleUrl` is the process entry point (e.g. `tsx scripts/seed.ts`), false when imported. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string => {
    const resolved = path.resolve(p).replace(/\.[cm]?[jt]s$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(entry) === normalize(fileURLToPath(moduleUrl));
}
