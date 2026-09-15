import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { nameCityKey } from '../../../src/lib/domain/dedupe';

// Exactly the generated column expression from ARCHITECTURE 4.2.
const GENERATED_COLUMN = `lower(regexp_replace(business_name,'[^A-Za-z0-9]+','','g')) || '|' || lower(regexp_replace(coalesce(city,''),'[^A-Za-z0-9]+','','g'))`;

const SAMPLES: Array<[string, string | null]> = [
  ["Joe's Pizza & Grill", 'New York'],
  ['ACME, Inc.', null],
  ['ACME, Inc.', ''],
  ['Café Olé', 'São Paulo'],
  ['Ångström Labs', 'Malmö'],
  ['Straße GmbH', 'München'],
  ['\uFF21\uFF23\uFF2D\uFF25 Full Width', 'Tōkyō'],
  ['123 Plumbing', 'St. Louis'],
  ['  Tab\tName\n ', 'city_name'],
  ['Pizza 🍕 Place', 'Austin 🤠'],
  ['ÀÉÎÕÜ ǅ ǈ', 'İstanbul'],
  ['MiXeD CaSe_under_score', 'LOS-ANGELES'],
  ['a-b.c/d\\e', '"quoted"'],
  ['!!!', 'Austin'],
  ['🍕', null],
  ['x'.repeat(500), 'y'.repeat(300)],
  ['Ω Omega Σigma', 'Αθήνα'],
  ['Zero\u200BWidth', 'Non\u00A0Breaking'],
];

describe('nameCityKey parity with the SQL generated column', () => {
  it('produces the same key as Postgres for tricky names', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(
        `create table t (id int primary key, business_name text not null, city text, dedupe_name_key text generated always as (${GENERATED_COLUMN}) stored)`,
      );
      for (const [id, [business, city]] of SAMPLES.entries()) {
        await db.query('insert into t (id, business_name, city) values ($1, $2, $3)', [id, business, city]);
      }
      const { rows } = await db.query<{ id: number; dedupe_name_key: string }>(
        'select id, dedupe_name_key from t order by id',
      );
      expect(rows).toHaveLength(SAMPLES.length);
      for (const { id, dedupe_name_key: sqlKey } of rows) {
        const [business, city] = SAMPLES[id];
        const jsKey = nameCityKey(business, city);
        if (jsKey === null) {
          // JS refuses to key an empty business part; SQL yields '|<city>' there.
          expect(sqlKey.startsWith('|')).toBe(true);
        } else {
          expect(jsKey).toBe(sqlKey);
        }
      }
    } finally {
      await db.close();
    }
  }, 60_000);
});
