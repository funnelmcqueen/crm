const MAX_INPUT_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

interface ParsedWebsite {
  /** Lowercase ASCII hostname, validated, no trailing dot, `www.` kept. */
  host: string;
  /** Everything after the authority (path, query, fragment), untouched. */
  rest: string;
}

function toAsciiHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function parseWebsite(raw: string | null | undefined): ParsedWebsite | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === '' || s.length > MAX_INPUT_LENGTH) return null;

  let explicitAuthority = false;
  const scheme = SCHEME.exec(s);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name !== 'http' && name !== 'https') return null;
    s = s.slice(scheme[0].length);
    explicitAuthority = true;
  } else if (s.startsWith('//')) {
    s = s.slice(2);
    explicitAuthority = true;
  }

  const end = s.search(/[/?#\\]/);
  let authority = end === -1 ? s : s.slice(0, end);
  const rest = end === -1 ? '' : s.slice(end);

  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    // Without a scheme, `name@domain` is an email address, not a website.
    if (!explicitAuthority) return null;
    authority = authority.slice(at + 1);
  }

  const port = /:\d{0,5}$/.exec(authority);
  if (port) authority = authority.slice(0, port.index);

  let host = authority.toLowerCase().replace(/\.+$/, '');
  if (host === '' || /[\s:@[\]%]/.test(host)) return null;
  if (/[^ -~]/.test(host)) {
    const ascii = toAsciiHost(host);
    if (ascii === null) return null;
    host = ascii.replace(/\.+$/, '');
  }
  if (host.length > MAX_HOST_LENGTH) return null;

  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (!TLD.test(labels[labels.length - 1])) return null;
  return { host, rest };
}

/**
 * Normalized domain for duplicate checks: no scheme, credentials, `www.`, port, path, query or
 * trailing dot; lowercase ASCII (IDN -> punycode). Emails, IPs and garbage -> null.
 */
export function normalizeWebsiteDomain(raw: string | null | undefined): string | null {
  const parsed = parseWebsite(raw);
  if (!parsed) return null;
  const labels = parsed.host.split('.');
  return labels.length > 2 && labels[0] === 'www' ? labels.slice(1).join('.') : parsed.host;
}

/**
 * Safe `https://` link for a stored website value (path and query kept; credentials, port and
 * fragment dropped; `www.` kept so the link still resolves). Null when the value is not a website.
 */
export function websiteHref(raw: string | null | undefined): string | null {
  const parsed = parseWebsite(raw);
  if (!parsed) return null;

  let rest = parsed.rest;
  const hash = rest.indexOf('#');
  if (hash !== -1) rest = rest.slice(0, hash);
  rest = rest.replace(/\\/g, '/');
  if (rest.startsWith('?')) rest = `/${rest}`;

  let url: URL;
  try {
    url = new URL(`https://${parsed.host}${rest}`);
  } catch {
    return null;
  }
  if (url.hostname !== parsed.host) return null;
  const path = url.pathname === '/' && url.search === '' ? '' : url.pathname;
  return `https://${url.hostname}${path}${url.search}`;
}
