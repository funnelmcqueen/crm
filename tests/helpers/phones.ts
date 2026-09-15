import { randomBytes, randomInt } from 'node:crypto';
import { SEED_LEADS, SEED_PHONE_NUMBERS, UNMATCHED_VOICEMAIL } from '../../scripts/lib/seed-data';
import { normalizePhone } from '../../src/lib/domain/phone';

/** Area codes used by seed data (leads, Twilio numbers, the unmatched voicemail). Fixtures avoid them. */
const SEED_AREA_CODES = new Set<string>([
  ...SEED_LEADS.map((lead) => lead.areaCode),
  ...SEED_PHONE_NUMBERS.map((n) => n.e164.slice(2, 5)),
  UNMATCHED_VOICEMAIL.remoteE164.slice(2, 5),
]);

/** Every NXX area code whose fictional 555-01xx numbers normalize and that the seed does not use. */
export const FIXTURE_AREA_CODES: readonly string[] = (() => {
  const codes: string[] = [];
  for (let code = 200; code <= 999; code += 1) {
    const area = String(code);
    if (area.endsWith('11') || area === '555' || SEED_AREA_CODES.has(area)) continue;
    const probe = normalizePhone(`+1${area}5550100`, 'US');
    if (probe.ok) codes.push(area);
  }
  return codes;
})();

export interface PhoneFactory {
  /** A new E.164 number in the reserved fictional range +1 NXX 555-0100..0199. */
  next(): string;
}

/**
 * Numbers are drawn from a partition of the area codes so parallel vitest workers never collide,
 * starting at a random offset so repeated runs against a persistent stack rarely reuse numbers.
 */
export function createPhoneFactory(options: { partition?: number; partitions?: number; random?: boolean } = {}): PhoneFactory {
  const partitions = Math.max(1, options.partitions ?? 1);
  const partition = ((options.partition ?? 0) % partitions + partitions) % partitions;
  const codes = FIXTURE_AREA_CODES.filter((_, index) => index % partitions === partition);
  if (codes.length === 0) throw new Error('no fixture area codes available for this partition');
  const size = codes.length * 100;
  let cursor = options.random === false ? 0 : randomInt(size);
  let issued = 0;
  return {
    next() {
      if (issued >= size) throw new Error('fictional phone space exhausted for this partition');
      const index = cursor % size;
      cursor += 1;
      issued += 1;
      const area = codes[Math.floor(index / 100)];
      const line = String(100 + (index % 100)).padStart(4, '0');
      return `+1${area}555${line}`;
    },
  };
}

/** Twilio-shaped SID: two-letter prefix plus 32 hex characters. */
export function fakeTwilioSid(prefix: 'CA' | 'PN' | 'RE' | 'AC'): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}
