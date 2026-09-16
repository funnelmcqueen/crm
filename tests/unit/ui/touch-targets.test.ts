// SPEC 11 / ARCHITECTURE 8: touch targets are at least 48px (min-h-12). The stage 6-10 screens put a
// number of *interactive* controls at 44px (h-11 / min-h-11): dropdown menu items (including the
// destructive "Disable agent"), select options, the import Skip / Import anyway pair, the reassign
// status checkboxes and the activity range tabs. On a phone those are the only way to reach several
// admin actions, and the destructive one sits directly under the one above it.
//
// Table *headers* are not touch targets, so `h-11` on a TableHead stays allowed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('../../../src/components/', import.meta.url));

/**
 * Every component tree, not just the stage 6-10 screens. The same 44px menu items and select options
 * were also fixed in `app-shell/user-menu.tsx` and three `leads/` components, and a list naming only
 * the stage 6-10 folders left those unguarded: SPEC 11 applies to them equally.
 */
const AREAS = readdirSync(COMPONENTS).filter((entry) => statSync(path.join(COMPONENTS, entry)).isDirectory());

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Offender {
  file: string;
  line: number;
  text: string;
}

function offenders(pattern: RegExp, allow: (text: string) => boolean): Offender[] {
  const found: Offender[] = [];
  for (const area of AREAS) {
    for (const file of sourceFiles(path.join(COMPONENTS, area))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          if (pattern.test(text) && !allow(text)) {
            found.push({ file: path.relative(COMPONENTS, file).split(path.sep).join('/'), line: index + 1, text: text.trim() });
          }
        });
    }
  }
  return found;
}

describe('interactive controls are at least 48px tall', () => {
  it('uses no 44px minimum height on menu items, options, labels or buttons', () => {
    expect(offenders(/\bmin-h-11\b/, () => false)).toEqual([]);
  });

  it('uses no 44px fixed height outside table headers', () => {
    expect(offenders(/\bh-11\b/, (text) => /TableHead/.test(text))).toEqual([]);
  });
});
