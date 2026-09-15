// decideInboundRoute (ARCHITECTURE 7): target selection and the ring conditions, exhaustively.
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PRESENCE_MAX_AGE_MS,
  canRingTarget,
  decideInboundRoute,
  pickInboundTarget,
  type InboundFacts,
  type InboundLeadFacts,
  type InboundNumberFacts,
  type InboundTargetFacts,
} from '@/server/twilio/inbound-routing';

const NOW = new Date('2026-09-15T15:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const NUMBER_AGENT = '22222222-2222-4222-8222-222222222222';
const LEAD = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const NUMBER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

const seconds = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();

function available(id: string, overrides: Partial<InboundTargetFacts> = {}): InboundTargetFacts {
  return { id, active: true, inAppCallingEnabled: true, deviceSeenAt: seconds(30), busy: false, ...overrides };
}

const LEADS: Record<string, InboundLeadFacts | null> = {
  none: null,
  owned: { ...LEAD, assignedTo: OWNER },
  unassigned: { ...LEAD, assignedTo: null },
};

const NUMBERS: Record<string, InboundNumberFacts | null> = {
  none: null,
  pool: { ...NUMBER, assignedTo: null, active: true },
  assigned: { ...NUMBER, assignedTo: NUMBER_AGENT, active: true },
  assignedInactive: { ...NUMBER, assignedTo: NUMBER_AGENT, active: false },
  ownersNumber: { ...NUMBER, assignedTo: OWNER, active: true },
};

describe('pickInboundTarget', () => {
  const expected: Record<string, Record<string, { userId: string | null; reason: string }>> = {
    none: {
      none: { userId: null, reason: 'no_owner' },
      pool: { userId: null, reason: 'no_owner' },
      assigned: { userId: NUMBER_AGENT, reason: 'assigned_number' },
      assignedInactive: { userId: null, reason: 'no_owner' },
      ownersNumber: { userId: OWNER, reason: 'assigned_number' },
    },
    owned: Object.fromEntries(Object.keys(NUMBERS).map((key) => [key, { userId: OWNER, reason: 'lead_owner' }])),
    unassigned: Object.fromEntries(Object.keys(NUMBERS).map((key) => [key, { userId: null, reason: 'unassigned_lead' }])),
  };

  for (const [leadKey, lead] of Object.entries(LEADS)) {
    for (const [numberKey, number] of Object.entries(NUMBERS)) {
      it(`lead=${leadKey}, number=${numberKey}`, () => {
        expect(pickInboundTarget(lead, number)).toEqual(expected[leadKey][numberKey]);
      });
    }
  }

  it("a matched lead's owner wins over the agent the dialed number belongs to", () => {
    expect(pickInboundTarget(LEADS.owned, NUMBERS.assigned).userId).toBe(OWNER);
  });
});

describe('canRingTarget', () => {
  const variants: { name: string; target: InboundTargetFacts | null; userId: string | null; ring: boolean }[] = [
    { name: 'available', target: available(OWNER), userId: OWNER, ring: true },
    { name: 'no target user (admin-only)', target: available(OWNER), userId: null, ring: false },
    { name: 'no profile facts', target: null, userId: OWNER, ring: false },
    { name: 'facts for a different user', target: available(NUMBER_AGENT), userId: OWNER, ring: false },
    { name: 'inactive', target: available(OWNER, { active: false }), userId: OWNER, ring: false },
    { name: 'in-app calling off', target: available(OWNER, { inAppCallingEnabled: false }), userId: OWNER, ring: false },
    { name: 'busy', target: available(OWNER, { busy: true }), userId: OWNER, ring: false },
    { name: 'Device never registered', target: available(OWNER, { deviceSeenAt: null }), userId: OWNER, ring: false },
    { name: 'presence exactly 3 minutes old', target: available(OWNER, { deviceSeenAt: new Date(NOW.getTime() - DEVICE_PRESENCE_MAX_AGE_MS).toISOString() }), userId: OWNER, ring: true },
    { name: 'presence 3 minutes + 1 ms old', target: available(OWNER, { deviceSeenAt: new Date(NOW.getTime() - DEVICE_PRESENCE_MAX_AGE_MS - 1).toISOString() }), userId: OWNER, ring: false },
    { name: 'presence 10 minutes old', target: available(OWNER, { deviceSeenAt: seconds(600) }), userId: OWNER, ring: false },
    { name: 'unparseable presence', target: available(OWNER, { deviceSeenAt: 'yesterday' }), userId: OWNER, ring: false },
    { name: 'presence slightly in the future (clock skew)', target: available(OWNER, { deviceSeenAt: seconds(-5) }), userId: OWNER, ring: true },
  ];
  for (const variant of variants) {
    it(variant.name, () => {
      expect(canRingTarget(variant.target, variant.userId, NOW)).toBe(variant.ring);
    });
  }
});

describe('decideInboundRoute: every combination', () => {
  const targetFlags = [true, false];
  const presences = { fresh: seconds(10), stale: seconds(400), never: null } as const;

  for (const [leadKey, lead] of Object.entries(LEADS)) {
    for (const [numberKey, number] of Object.entries(NUMBERS)) {
      for (const active of targetFlags) {
        for (const inApp of targetFlags) {
          for (const busy of targetFlags) {
            for (const [presenceKey, deviceSeenAt] of Object.entries(presences)) {
              const pick = pickInboundTarget(lead, number);
              const target = pick.userId ? { id: pick.userId, active, inAppCallingEnabled: inApp, busy, deviceSeenAt } : null;
              const facts: InboundFacts = { fromE164: '+12125550100', lead, number, target };
              const name = `lead=${leadKey} number=${numberKey} active=${active} inApp=${inApp} busy=${busy} presence=${presenceKey}`;
              it(name, () => {
                const decision = decideInboundRoute(facts, NOW);
                const shouldRing = pick.userId !== null && active && inApp && !busy && presenceKey === 'fresh';
                expect(decision).toEqual({
                  action: shouldRing ? 'ring' : 'voicemail',
                  userId: pick.userId,
                  reason: pick.reason,
                  leadId: lead?.id ?? null,
                  phoneNumberId: number?.id ?? null,
                });
              });
            }
          }
        }
      }
    }
  }

  it('never rings anyone for an unmatched caller on a pool number, whatever the facts say', () => {
    const decision = decideInboundRoute({ fromE164: null, lead: null, number: NUMBERS.pool, target: available(NUMBER_AGENT) }, NOW);
    expect(decision).toEqual({ action: 'voicemail', userId: null, reason: 'no_owner', leadId: null, phoneNumberId: NUMBER.id });
  });

  it("never rings the number's agent for another agent's lead, even when the owner is unavailable", () => {
    const decision = decideInboundRoute(
      { fromE164: '+12125550100', lead: LEADS.owned, number: NUMBERS.assigned, target: available(NUMBER_AGENT) },
      NOW,
    );
    expect(decision.action).toBe('voicemail');
    expect(decision.userId).toBe(OWNER);
  });
});
