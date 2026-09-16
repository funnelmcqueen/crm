// Review round 2: the admin dashboard's team tiles must be readable against the per-agent rows shown
// directly underneath them, and must mean the same thing as the identically labelled report numbers.
//
//   * Talk time: the rows render formatTalkTime (which floors), the tile rendered
//     round(seconds / 60). With the seeded data the rows read 22m + 10m + 0m + 0m and the tile read
//     "Talk min 33". Any agent under a minute ("45s") counted 0 in the rows and 1 in the tile.
//   * Clients: the tile counted every CLIENT lead in the pipeline while Reports counted only leads
//     currently assigned to someone, so the same data gave two different "Clients" numbers.
import { describe, expect, it } from 'vitest';
import { formatTalkTime, teamTotalsItems } from '@/components/dashboard/format';
import type { AgentStatsRow, TeamTotals } from '@/server/services/dashboard';

function totals(overrides: Partial<TeamTotals> = {}): TeamTotals {
  return {
    leadsTotal: 45,
    leadsUnassigned: 5,
    callsToday: 12,
    connectedToday: 4,
    interestedToday: 2,
    appointmentsToday: 1,
    clientsTotal: 3,
    clientsAssigned: 1,
    clientsUnassigned: 2,
    talkSecondsToday: 0,
    talkMinutesToday: 0,
    disabledAgentsWithLeads: 0,
    leadsOnDisabledAgents: 0,
    ...overrides,
  } as TeamTotals;
}

function agentRow(talkSecondsToday: number): Pick<AgentStatsRow, 'talkSecondsToday'> {
  return { talkSecondsToday };
}

function item(all: ReturnType<typeof teamTotalsItems>, label: string) {
  const found = all.find((entry) => entry.label === label);
  if (!found) throw new Error(`no "${label}" tile in ${all.map((entry) => entry.label).join(', ')}`);
  return found;
}

describe('team talk time agrees with the per-agent rows', () => {
  it('formats the team total with the helper the rows use', () => {
    // The seeded shape: Alex 1336s, Blair 617s, everyone else 0.
    const rows = [agentRow(1336), agentRow(617), agentRow(0), agentRow(0)];
    const seconds = rows.reduce((sum, row) => sum + row.talkSecondsToday, 0);

    const tile = item(teamTotalsItems(totals({ talkSecondsToday: seconds, talkMinutesToday: Math.round(seconds / 60) })), 'Talk time');
    expect(tile.value).toBe(formatTalkTime(seconds));
    expect(tile.value).toBe('32m');
  });

  it('does not round a sub-minute agent up to a whole minute', () => {
    // Five agents at 30s each: every row renders "30s", so a tile reading "3" is unreadable.
    const seconds = 5 * 30;
    const tile = item(teamTotalsItems(totals({ talkSecondsToday: seconds, talkMinutesToday: Math.round(seconds / 60) })), 'Talk time');
    expect(tile.value).toBe(formatTalkTime(seconds));
    expect(tile.value).toBe('2m');
  });
});

describe('the Clients tile means what Reports means', () => {
  it('shows the assigned client count that the reports total sums', () => {
    const tile = item(teamTotalsItems(totals({ clientsTotal: 3, clientsAssigned: 1, clientsUnassigned: 2 })), 'Clients');
    expect(tile.value).toBe('1');
  });

  it('still surfaces unassigned client leads instead of hiding them', () => {
    const tile = item(teamTotalsItems(totals({ clientsTotal: 3, clientsAssigned: 1, clientsUnassigned: 2 })), 'Clients');
    expect(tile.sub).toBe('2 unassigned');
  });

  it('shows no sub-line when every client lead is assigned', () => {
    const tile = item(teamTotalsItems(totals({ clientsTotal: 4, clientsAssigned: 4, clientsUnassigned: 0 })), 'Clients');
    expect(tile.value).toBe('4');
    expect(tile.sub).toBeUndefined();
  });
});
