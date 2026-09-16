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

const uiSource = (file: string) => readFileSync(path.join(COMPONENTS, 'ui', file), 'utf8');

/**
 * The checkbox, radio and switch are 16px (and the small switch 14px) boxes that rely on an absolutely
 * positioned `::after` for their real hit area. `after:-inset-x-3 after:-inset-y-2` adds only 24px of
 * width and 16px of height, which Chrome laid out as 40x32 for every checkbox and radio and 56x34 for
 * the switch: under SPEC 11's 48px on every phone width. Measured with a Playwright probe across the
 * status filter (12 checkboxes), the reassign dialog (12), the import assign step (3 radios + 3
 * checkboxes), the call-mode radios (3), "Show closed" and the leads "Unassigned" toggle.
 *
 * These assert the geometry that replaced it, because the rule is arithmetic a reviewer cannot eyeball:
 * a 16px box needs 16px added on every side to reach 48.
 */
describe('checkbox, radio and switch hit areas reach 48px', () => {
  it('no primitive still uses the 40x32 inset pair', () => {
    for (const file of ['checkbox.tsx', 'radio-group.tsx', 'switch.tsx']) {
      expect(uiSource(file), file).not.toContain('after:-inset-x-3 after:-inset-y-2');
    }
  });

  it('the 16px checkbox and radio expand by 16px on every side', () => {
    expect(uiSource('checkbox.tsx')).toContain('after:absolute after:-inset-4');
    expect(uiSource('radio-group.tsx')).toContain('after:absolute after:-inset-4');
  });

  it('the switch expands enough that even its 14px small size clears 48px', () => {
    // 14 + 17 + 17 = 48, so `sm` passes too; the default 18.4px size lands at 52.4.
    expect(uiSource('switch.tsx')).toContain('after:absolute after:-inset-x-4 after:-inset-y-[17px]');
  });

  it('the dialog close button is 48px, like the sheet already was', () => {
    const dialog = uiSource('dialog.tsx');
    expect(dialog).not.toContain('size="icon-sm"');
    expect(dialog).toContain('className="absolute top-2 right-2 size-12"');
  });
});
