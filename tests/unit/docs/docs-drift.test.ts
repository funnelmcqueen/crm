// The docs describe the Playwright suite in prose, and prose does not fail when the suite changes.
// D31 added a fourth project (`journey`) and made the import spec insert 97 leads instead of 92, but
// README.md, docs/ARCHITECTURE.md section 10 and docs/PLAN.md still said "three projects" and "92
// leads". A contributor reading the binding contract to learn where a new spec belongs would have
// named it so it matched no `testMatch` and it would never have run, silently.
//
// So the numbers that can drift are checked against their source: playwright.config.ts for the
// projects, e2e/admin-import.spec.ts for the imported row count.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

const playwrightConfig = repoFile('playwright.config.ts');
const importSpec = repoFile('e2e/admin-import.spec.ts');
const DOCS = ['README.md', 'docs/ARCHITECTURE.md', 'docs/PLAN.md'] as const;

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'] as const;

/** Project names declared in playwright.config.ts, in order. */
function playwrightProjects(): string[] {
  const projects = /projects:\s*\[([\s\S]*?)\n\s*\],\n\s*webServer/.exec(playwrightConfig);
  expect(projects, 'could not find the projects array in playwright.config.ts').not.toBeNull();
  return [...(projects as RegExpExecArray)[1].matchAll(/\bname:\s*'([a-z-]+)'/g)].map((match) => match[1]);
}

/** Leads e2e/admin-import.spec.ts actually inserts: every valid row, duplicates included. */
function importedLeadCount(): number {
  const ready = /const READY = (\d+)/.exec(importSpec);
  const duplicates = /const DUPLICATES = (\d+)/.exec(importSpec);
  expect(ready && duplicates, 'admin-import.spec.ts no longer declares READY and DUPLICATES').toBeTruthy();
  return Number((ready as RegExpExecArray)[1]) + Number((duplicates as RegExpExecArray)[1]);
}

describe('documentation matches the Playwright suite', () => {
  it('finds five projects, including journey and workspace', () => {
    expect(playwrightProjects()).toEqual(['mobile', 'desktop', 'journey', 'import', 'workspace']);
  });

  it.each(DOCS)('%s names every Playwright project', (doc) => {
    const text = repoFile(doc);
    const missing = playwrightProjects().filter((name) => !new RegExp(`\`${name}\`|\\b${name}\\b`).test(text));
    expect(missing, `${doc} describes the e2e suite without mentioning these projects`).toEqual([]);
  });

  it.each(DOCS)('%s does not claim the wrong number of projects', (doc) => {
    const expected = COUNT_WORDS[playwrightProjects().length];
    const claims = [...repoFile(doc).matchAll(/\b(zero|one|two|three|four|five|six) projects\b/gi)].map((match) =>
      match[1].toLowerCase(),
    );
    expect(new Set(claims.filter((claim) => claim !== expected)), `${doc} miscounts the Playwright projects`).toEqual(new Set());
  });

  it.each(DOCS)('%s cites the number of leads the import spec really inserts', (doc) => {
    const claims = [...repoFile(doc).matchAll(/inserts (\d+) leads/g)].map((match) => Number(match[1]));
    for (const claim of claims) expect(claim, `${doc} is out of date with e2e/admin-import.spec.ts`).toBe(importedLeadCount());
  });
});

// The same failure mode one directory over: D39 added a twelfth migration, and the README's sample
// localbase output plus docs/PLAN.md both still said "11 migrations (000100-001200)". Nothing failed,
// because the only check on those numbers was that someone re-read them. supabase/migrations/ is the
// source of truth, so compare against it.
describe('documentation matches supabase/migrations', () => {
  /** Timestamped migration files, in filename order (the order localbase and `supabase db push` apply). */
  function migrationFiles(): string[] {
    const dir = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
    return readdirSync(dir)
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .sort();
  }

  it('finds the migrations on disk', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it.each(DOCS)('%s does not claim the wrong number of migrations', (doc) => {
    const expected = migrationFiles().length;
    const claims = [...repoFile(doc).matchAll(/\b(\d+) migrations\b/g)].map((match) => Number(match[1]));
    for (const claim of claims) {
      expect(claim, `${doc} miscounts supabase/migrations (${expected} on disk)`).toBe(expected);
    }
  });

  // Deliberately no assertion on cited ranges like "000100-001300": docs/PLAN.md also says
  // "Migrations 000100-000300" about stage 1, which is a correct statement about a subset. A range
  // cannot be told apart from a total without reading the sentence, so the count above is the guard.
});
