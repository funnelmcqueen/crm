// Read-only accessors for the seed data (scripts/seed.ts). Tests must never mutate seeded rows;
// create fixtures with tests/helpers/fixtures.ts instead.
import {
  SEED_ADMIN_EMAIL,
  SEED_PASSWORD,
  SEED_PHONE_NUMBERS,
  SEED_USERS,
  UNMATCHED_VOICEMAIL,
  leadE164,
  seedLead,
  type NumberKey,
  type UserKey,
} from '../../scripts/lib/seed-data';
import { serviceClient, signInAs, type SignedInUser } from './clients';

export { SEED_ADMIN_EMAIL, SEED_PASSWORD, UNMATCHED_VOICEMAIL };
export type { NumberKey, UserKey };

export const SEEDED_EMAILS: Readonly<Record<UserKey, string>> = {
  admin: SEED_ADMIN_EMAIL,
  alex: 'alex@funnelmcqueen.test',
  blair: 'blair@funnelmcqueen.test',
  casey: 'casey@funnelmcqueen.test',
  dana: 'dana@funnelmcqueen.test',
};

for (const user of SEED_USERS) {
  if (SEEDED_EMAILS[user.key] !== user.email) throw new Error(`seeded.ts is out of date for ${user.key}`);
}

const userIdCache = new Map<string, string>();
const leadIdCache = new Map<string, string>();
const numberIdCache = new Map<string, string>();

/** profiles.id of a seeded user, looked up by email through the service client. */
export async function seededUserId(key: UserKey): Promise<string> {
  const email = SEEDED_EMAILS[key];
  const cached = userIdCache.get(email);
  if (cached) return cached;
  const { data, error } = await serviceClient().from('profiles').select('id').eq('email', email).maybeSingle();
  if (error || !data) throw new Error(`seeded user ${email} not found: ${error?.message ?? 'no row'}`);
  userIdCache.set(email, data.id);
  return data.id;
}

/** Signs in as a seeded user. Dana is disabled and banned, so she cannot sign in. */
export function signInSeeded(key: Exclude<UserKey, 'dana'>): Promise<SignedInUser> {
  return signInAs(SEEDED_EMAILS[key], SEED_PASSWORD);
}

/** leads.id of a seeded lead by its stable ref (e.g. 'alex-06'), found by its unique phone. */
export async function seededLeadId(ref: string): Promise<string> {
  const cached = leadIdCache.get(ref);
  if (cached) return cached;
  const phone = leadE164(seedLead(ref));
  const { data, error } = await serviceClient().from('leads').select('id').eq('phone', phone).limit(2);
  if (error || !data || data.length !== 1) {
    throw new Error(`seeded lead ${ref} not found uniquely: ${error?.message ?? `${data?.length ?? 0} rows`}`);
  }
  leadIdCache.set(ref, data[0].id);
  return data[0].id;
}

export function seededLeadPhone(ref: string): string {
  return leadE164(seedLead(ref));
}

/** phone_numbers.id of a seeded Twilio number. */
export async function seededPhoneNumberId(key: NumberKey): Promise<string> {
  const number = SEED_PHONE_NUMBERS.find((n) => n.key === key);
  if (!number) throw new Error(`unknown seeded number ${key}`);
  const cached = numberIdCache.get(number.e164);
  if (cached) return cached;
  const { data, error } = await serviceClient().from('phone_numbers').select('id').eq('e164', number.e164).maybeSingle();
  if (error || !data) throw new Error(`seeded number ${number.e164} not found: ${error?.message ?? 'no row'}`);
  numberIdCache.set(number.e164, data.id);
  return data.id;
}

export function seededPhoneNumberE164(key: NumberKey): string {
  const number = SEED_PHONE_NUMBERS.find((n) => n.key === key);
  if (!number) throw new Error(`unknown seeded number ${key}`);
  return number.e164;
}
