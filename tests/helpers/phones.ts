import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** One area code's worth of numbers: 555-0100..0199. */
const BLOCK_SIZE = 100;

/**
 * Reserves a block index that no other factory in this test run can hold.
 *
 * Partitioning by worker keeps concurrent workers apart, but vitest re-initializes module state for
 * every test file, so a per-file cursor (random or not) can overlap another file that ran in the same
 * partition — and phone_numbers.e164 is UNIQUE, so an overlap turns an insert into a conflict and makes
 * "nothing was stored" assertions fail. Creating the marker with 'wx' is atomic, so the first caller to
 * claim an index wins even if two processes race. The directory is keyed on the vitest main process, so
 * it is shared by every worker of this run and survives worker recycling, and a new run starts clean.
 */
function reserveBlock(partition: number, blocks: number): number {
  const dir = join(tmpdir(), `fmq-phone-blocks-${process.ppid}`, `p${partition}`);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < blocks; index += 1) {
    try {
      closeSync(openSync(join(dir, String(index)), 'wx'));
      return index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`fictional phone blocks exhausted for partition ${partition} (${blocks} blocks)`);
}

export interface PhoneFactory {
  /** A new E.164 number in the reserved fictional range +1 NXX 555-0100..0199. */
  next(): string;
}

/**
 * Numbers are drawn from a partition of the area codes so parallel vitest workers never collide, and
 * from a reserved block inside that partition so test files never collide with each other.
 */
export function createPhoneFactory(options: { partition?: number; partitions?: number } = {}): PhoneFactory {
  const partitions = Math.max(1, options.partitions ?? 1);
  const partition = (((options.partition ?? 0) % partitions) + partitions) % partitions;
  const codes = FIXTURE_AREA_CODES.filter((_, index) => index % partitions === partition);
  if (codes.length === 0) throw new Error('no fixture area codes available for this partition');

  // One block per area code: a file that needs more than 100 numbers takes the next block.
  let block = reserveBlock(partition, codes.length);
  let issued = 0;

  return {
    next() {
      if (issued >= BLOCK_SIZE) {
        block = reserveBlock(partition, codes.length);
        issued = 0;
      }
      const area = codes[block];
      const line = String(100 + issued).padStart(4, '0');
      issued += 1;
      return `+1${area}555${line}`;
    },
  };
}

/** Twilio-shaped SID: two-letter prefix plus 32 hex characters. */
export function fakeTwilioSid(prefix: 'CA' | 'PN' | 'RE' | 'AC'): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}
