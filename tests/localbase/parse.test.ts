import { describe, expect, it } from 'vitest';
import { parseGoDuration } from '../../localbase/auth';
import {
  PgrstError,
  negotiateAccept,
  parseLogicTree,
  parseOrder,
  parsePrefer,
  parseQuery,
  parseSelect,
  splitTopLevel,
} from '../../localbase/rest-parse';

describe('rest-parse', () => {
  it('splits on top-level commas only', () => {
    expect(splitTopLevel('a,"b,c",in.(1,2),{x,y}')).toEqual(['a', '"b,c"', 'in.(1,2)', '{x,y}']);
    expect(() => splitTopLevel('a,(b')).toThrow(PgrstError);
    expect(() => splitTopLevel('"open')).toThrow(PgrstError);
  });

  it('parses nested logic trees with quoted values', () => {
    const tree = parseLogicTree('or', '(name.eq."a,b (c)",and(qty.gt.1,not.or(code.in.("x,y",z),tag.is.null)))');
    expect(tree).toEqual({
      kind: 'logic',
      operator: 'or',
      negate: false,
      children: [
        { kind: 'filter', column: 'name', negate: false, operator: 'eq', quantifier: null, language: null, value: 'a,b (c)' },
        {
          kind: 'logic',
          operator: 'and',
          negate: false,
          children: [
            { kind: 'filter', column: 'qty', negate: false, operator: 'gt', quantifier: null, language: null, value: '1' },
            {
              kind: 'logic',
              operator: 'or',
              negate: true,
              children: [
                { kind: 'filter', column: 'code', negate: false, operator: 'in', quantifier: null, language: null, value: ['x,y', 'z'] },
                { kind: 'filter', column: 'tag', negate: false, operator: 'is', quantifier: null, language: null, value: 'null' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('parses select items and rejects embeds, spreads, aggregates and JSON paths', () => {
    expect(parseSelect('*,a:b,c::text,"odd name"')).toEqual([
      { kind: 'star' },
      { kind: 'column', name: 'b', alias: 'a', cast: null },
      { kind: 'column', name: 'c', alias: null, cast: 'text' },
      { kind: 'column', name: 'odd name', alias: null, cast: null },
    ]);
    for (const bad of ['rel(id)', 'a:rel!inner(id)', '...rel(id)', 'count()', 'qty.sum()', 'meta->a', 'a;drop', 'x::text;drop']) {
      expect(() => parseSelect(bad), bad).toThrow(PgrstError);
    }
  });

  it('parses order terms', () => {
    expect(parseOrder('a.desc.nullslast,b,"c d".asc')).toEqual([
      { column: 'a', direction: 'desc', nulls: 'last' },
      { column: 'b', direction: 'asc', nulls: null },
      { column: 'c d', direction: 'asc', nulls: null },
    ]);
    expect(() => parseOrder('a.sideways')).toThrow(PgrstError);
    expect(() => parseOrder('rel(a)')).toThrow(PgrstError);
  });

  it('parses query filters and rejects embedded filters and unknown operators', () => {
    const parsed = parseQuery(new URLSearchParams('select=id&qty=not.gte.3&code=in.("a,b",c)&limit=5&offset=10'));
    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(10);
    expect(parsed.conditions).toHaveLength(2);
    expect(() => parseQuery(new URLSearchParams('rel.id=eq.1'))).toThrow(PgrstError);
    expect(() => parseQuery(new URLSearchParams('id=zz.1'))).toThrow(PgrstError);
    expect(() => parseQuery(new URLSearchParams('id=eq'))).toThrow(PgrstError);
    expect(() => parseQuery(new URLSearchParams('limit=-1'))).toThrow(PgrstError);
    expect(() => parseQuery(new URLSearchParams('id=is.maybe'))).toThrow(PgrstError);
  });

  it('parses Prefer and Accept', () => {
    const prefs = parsePrefer('return=representation, count=exact,resolution=merge-duplicates, missing=default');
    expect(prefs).toMatchObject({ return: 'representation', count: 'exact', resolution: 'merge-duplicates', missing: 'default' });
    expect(() => parsePrefer('handling=strict, bogus=1')).toThrow(PgrstError);
    expect(negotiateAccept('application/vnd.pgrst.object+json')).toEqual({ kind: 'object', stripNulls: false });
    expect(negotiateAccept(undefined)).toEqual({ kind: 'array', stripNulls: false });
    expect(() => negotiateAccept('text/csv')).toThrow(PgrstError);
  });

  it('parses Go durations for ban_duration', () => {
    expect(parseGoDuration('876000h')).toBe(876000 * 3_600_000);
    expect(parseGoDuration('1h30m')).toBe(5_400_000);
    expect(parseGoDuration('1.5s')).toBe(1500);
    expect(parseGoDuration('forever')).toBeNull();
    expect(parseGoDuration('10')).toBeNull();
  });
});
