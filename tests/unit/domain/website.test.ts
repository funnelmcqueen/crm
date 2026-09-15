import { describe, expect, it } from 'vitest';
import { normalizeWebsiteDomain, websiteHref } from '../../../src/lib/domain/website';

describe('normalizeWebsiteDomain', () => {
  it.each([
    ['https://www.Example.com/path?q=1#x', 'example.com'],
    ['http://user:pass@shop.example.co.uk:8080/a', 'shop.example.co.uk'],
    ['EXAMPLE.COM.', 'example.com'],
    ['www.example.com', 'example.com'],
    ['example.com:443', 'example.com'],
    ['//cdn.example.org/x', 'cdn.example.org'],
    ['example.com/some path with spaces', 'example.com'],
    ['example.com?ref=abc', 'example.com'],
    ['example.com#top', 'example.com'],
    ['  https://Joes-Pizza.NYC/menu  ', 'joes-pizza.nyc'],
    ['https://www.example.com.:8443', 'example.com'],
    ['HTTPS://EXAMPLE.COM', 'example.com'],
    ['example.com\\path', 'example.com'],
    ['a1-b2.example-site.io', 'a1-b2.example-site.io'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de'],
    // Only strip www. when a registrable domain remains.
    ['www.com', 'www.com'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeWebsiteDomain(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'john@example.com',
    'mailto:john@example.com',
    'localhost',
    'http://localhost:3000',
    '192.168.0.1',
    'http://10.0.0.1/admin',
    'not a website',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'ftp://example.com',
    'exa mple.com',
    '-example.com',
    'example-.com',
    'example..com',
    '.com',
    'example.c',
    'example.123',
    'http://[::1]/',
    'N/A',
    'https://',
    'http://example.com:abc',
    'example%2Ecom',
    `${'a'.repeat(64)}.com`,
    'example_site.com',
  ])('rejects %j', (input) => {
    expect(normalizeWebsiteDomain(input)).toBeNull();
  });

  it('treats different spellings of the same site as one domain', () => {
    const spellings = ['acme.com', 'https://acme.com', 'http://www.acme.com/', 'ACME.COM/contact', 'www.acme.com.'];
    expect(new Set(spellings.map((s) => normalizeWebsiteDomain(s)))).toEqual(new Set(['acme.com']));
  });
});

describe('websiteHref', () => {
  it.each([
    ['www.example.com/about', 'https://www.example.com/about'],
    ['http://Example.com', 'https://example.com'],
    ['example.com/', 'https://example.com'],
    ['example.com/?a=1#frag', 'https://example.com/?a=1'],
    ['example.com?a=1', 'https://example.com/?a=1'],
    ['https://user:pw@example.com:8443/x y', 'https://example.com/x%20y'],
    ['EXAMPLE.com/Path/Keeps/Case', 'https://example.com/Path/Keeps/Case'],
    ['example.com\\evil', 'https://example.com/evil'],
    ['münchen.de/karte', 'https://xn--mnchen-3ya.de/karte'],
  ])('builds a link for %j', (input, expected) => {
    expect(websiteHref(input)).toBe(expected);
  });

  it.each(['javascript:alert(1)', 'john@example.com', 'data:text/html,hi', 'localhost', '', null, undefined])(
    'returns null for %j',
    (input) => {
      expect(websiteHref(input)).toBeNull();
    },
  );

  it('percent-encodes markup in the path and keeps the host fixed', () => {
    const href = websiteHref('example.com/"><script>alert(1)</script>');
    expect(href?.startsWith('https://example.com/')).toBe(true);
    expect(href).not.toMatch(/[<>"\s]/);
  });
});
