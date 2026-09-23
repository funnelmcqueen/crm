// Availability through the service layer with real sessions (docs/DEVIATIONS.md D46): slots and busy time come back
// as bare times, event titles never do, and another agent's booking vanishes from the picker at once.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CalendarClient, CalendarInterval } from '@/server/calendar/types';
import type { RequestContext } from '@/server/context';
import { getAgentAvailability } from '@/server/services/calendar-booking';
import { contextForUser } from '../../helpers/context';
import { createLead, createUser, type FixtureUser } from '../../helpers/fixtures';

const TAG = `AVL${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
// Monday 2032-03-01 13:00Z (08:00 EST). Far from any other suite's bookings.
const NOW = new Date(Date.UTC(2032, 2, 1, 13, 0));

/** A deliberately sloppy client: busy entries carry a summary, as a raw Google event would. */
function leakyCalendar(windows: CalendarInterval[], busy: Array<CalendarInterval & { summary: string }>): CalendarClient {
  return {
    async readAvailability() {
      return { windows, busy };
    },
    async createMeeting() {
      return { eventId: `evt-${randomUUID()}` };
    },
  };
}

const hours = (from: number, to: number): CalendarInterval => ({ start: new Date(NOW.getTime() + from * HOUR), end: new Date(NOW.getTime() + to * HOUR) });

let agent: FixtureUser;
let ctx: RequestContext;

beforeAll(async () => {
  agent = await createUser({ name: `Avail Agent ${TAG}` });
  ctx = await contextForUser(agent);
});

describe('getAgentAvailability', () => {
  it('returns slots and anonymous busy time, never an event title', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Pizzeria`, state: 'FL', country: 'US' });
    const calendar = leakyCalendar([hours(3, 8)], [{ ...hours(4, 5), summary: 'SECRET: dentist' }]);

    const availability = await getAgentAvailability(ctx, lead.id, { calendar, now: () => NOW });

    expect(JSON.stringify(availability)).not.toContain('SECRET');
    expect(availability.busy).toContainEqual({ start: hours(4, 5).start.toISOString(), end: hours(4, 5).end.toISOString() });
    const starts = availability.slots.map((slot) => slot.start);
    expect(starts).toContain(hours(3, 3.5).start.toISOString());
    expect(starts).not.toContain(hours(4, 4.5).start.toISOString());
    expect(availability).toMatchObject({ businessType: 'restaurant', businessTypeIsGuess: true, leadTimeZone: 'America/New_York', leadTimeZoneIsGuess: false });
    expect(availability.suggestions.length).toBeGreaterThan(0);
    expect(availability.suggestions.length).toBeLessThanOrEqual(3);
    expect(availability.slots[0].phrase).toMatch(/^Today at /);
  });

  it('never exposes busy time outside the bookable windows, and clips a block that straddles a window edge', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} OffHours`, state: 'FL', country: 'US' });
    const calendar = leakyCalendar(
      [hours(3, 8)],
      [
        { ...hours(20, 22), summary: 'SECRET: closer dinner' }, // entirely outside the one bookable window
        { ...hours(2, 3.5), summary: 'SECRET: straddles the window opening' }, // half before it opens, half inside
      ],
    );

    const availability = await getAgentAvailability(ctx, lead.id, { calendar, now: () => NOW });

    // Off-hours busy time never reaches the browser at all -- not even clipped to nothing, just absent.
    expect(availability.busy).not.toContainEqual({ start: hours(20, 22).start.toISOString(), end: hours(20, 22).end.toISOString() });
    // The straddling block is clipped to the window's own bounds, not the closer's real (pre-window) start.
    expect(availability.busy).toContainEqual({ start: hours(3, 3.5).start.toISOString(), end: hours(3, 3.5).end.toISOString() });
    expect(availability.busy).not.toContainEqual({ start: hours(2, 3.5).start.toISOString(), end: hours(2, 3.5).end.toISOString() });
    // Slot computation still used the real, unclipped busy time: the half hour the straddling block actually
    // covers inside the window is excluded exactly as it would be without any clipping.
    const starts = availability.slots.map((slot) => slot.start);
    expect(starts).not.toContain(hours(3, 3.5).start.toISOString());
    expect(starts).toContain(hours(3.5, 4).start.toISOString());
  });

  it('answers not_found for a lead the agent cannot see, and unavailable without a calendar', async () => {
    const other = await createUser({ name: `Avail Other ${TAG}` });
    const theirs = await createLead({ assigned_to: other.id, business_name: `${TAG} Theirs` });
    await expect(getAgentAvailability(ctx, theirs.id, { calendar: leakyCalendar([], []), now: () => NOW })).rejects.toMatchObject({ code: 'not_found' });

    const mine = await createLead({ assigned_to: agent.id, business_name: `${TAG} Mine` });
    await expect(getAgentAvailability(ctx, mine.id, { calendar: null, now: () => NOW })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports a calendar that fails to load as unavailable', async () => {
    const lead = await createLead({ assigned_to: agent.id, business_name: `${TAG} Failing` });
    const broken: CalendarClient = {
      async readAvailability() {
        throw new Error('google down');
      },
      async createMeeting() {
        throw new Error('unused');
      },
    };
    await expect(getAgentAvailability(ctx, lead.id, { calendar: broken, now: () => NOW })).rejects.toMatchObject({ code: 'unavailable', message: "Couldn't load the calendar. Try again." });
  });
});
