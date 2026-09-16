import { describe, expect, it } from 'vitest';
import { ALL_PIPELINE_COLUMNS, pipelineColumnByKey, visiblePipelineColumns } from '@/components/pipeline/board-state';
import { PIPELINE_PAGE_SIZE_CLIENT } from '@/components/pipeline/constants';
import { DEFAULT_PIPELINE_PARAMS, parsePipelineParams, pipelineHref, serializePipelineParams } from '@/components/pipeline/params';
import { MousePointerSensor, columnStepDelta } from '@/components/pipeline/sensors';
import { LEAD_STATUSES, pipelineBadgeFor, pipelineColumnFor } from '@/lib/domain/statuses';
import { PIPELINE_COLUMN_KEYS, PIPELINE_PAGE_SIZE } from '@/server/services/pipeline';

const UUID = '3f1c2b7e-8a9d-4c1e-9b2a-6d5e4f3a2b1c';

describe('pipeline columns and statuses', () => {
  it('shows the seven open columns by default and adds the two closed ones', () => {
    expect(visiblePipelineColumns(false).map((c) => c.label)).toEqual([
      'New',
      'To Call',
      'Connected',
      'Interested',
      'Appointment',
      'Proposal',
      'Client',
    ]);
    expect(visiblePipelineColumns(true).map((c) => c.key).slice(7)).toEqual(['NOT_INTERESTED', 'DO_NOT_CONTACT']);
  });

  it('maps every status to exactly one column, whose drop status is a member of it', () => {
    for (const status of LEAD_STATUSES) {
      const owners = ALL_PIPELINE_COLUMNS.filter((c) => c.statuses.includes(status));
      expect(owners, status).toHaveLength(1);
      expect(pipelineColumnFor(status).key).toBe(owners[0].key);
    }
    for (const column of ALL_PIPELINE_COLUMNS) expect(column.statuses).toContain(column.dropStatus);
  });

  it('puts No Answer and Voicemail in To Call and Follow Up in Connected, with badges', () => {
    expect(pipelineColumnFor('NO_ANSWER').key).toBe('TO_CALL');
    expect(pipelineColumnFor('VOICEMAIL').key).toBe('TO_CALL');
    expect(pipelineColumnFor('FOLLOW_UP').key).toBe('CONNECTED');
    expect(LEAD_STATUSES.filter((s) => pipelineBadgeFor(s) !== null)).toEqual(['NO_ANSWER', 'VOICEMAIL', 'FOLLOW_UP']);
  });

  it('keeps the service column keys and page size in sync with the domain and the client', () => {
    expect([...PIPELINE_COLUMN_KEYS]).toEqual(ALL_PIPELINE_COLUMNS.map((c) => c.key));
    expect(PIPELINE_PAGE_SIZE_CLIENT).toBe(PIPELINE_PAGE_SIZE);
    expect(pipelineColumnByKey('CLIENT')?.label).toBe('Client');
    expect(pipelineColumnByKey('FOLLOW_UP')).toBeNull();
  });
});

describe('pipeline URL params', () => {
  it('defaults', () => {
    expect(parsePipelineParams({})).toEqual(DEFAULT_PIPELINE_PARAMS);
    expect(pipelineHref(DEFAULT_PIPELINE_PARAMS)).toBe('/pipeline');
  });

  it('reads closed, agent and unassigned leniently', () => {
    expect(parsePipelineParams({ closed: '1', agent: UUID.toUpperCase() })).toEqual({ closed: true, agent: UUID, unassigned: false });
    expect(parsePipelineParams(new URLSearchParams(`closed=true&unassigned=1&agent=${UUID}`))).toEqual({
      closed: true,
      agent: null,
      unassigned: true,
    });
    expect(parsePipelineParams({ closed: 'yes', agent: 'not-a-uuid', unassigned: ['0', '1'] })).toEqual(DEFAULT_PIPELINE_PARAMS);
  });

  it('round-trips', () => {
    for (const params of [
      { closed: true, agent: UUID, unassigned: false },
      { closed: false, agent: null, unassigned: true },
      DEFAULT_PIPELINE_PARAMS,
    ]) {
      expect(parsePipelineParams(new URLSearchParams(serializePipelineParams(params)))).toEqual(params);
    }
    expect(pipelineHref({ closed: true, agent: UUID, unassigned: false })).toBe(`/pipeline?agent=${UUID}&closed=1`);
  });
});

describe('drag sensors', () => {
  const [activator] = MousePointerSensor.activators;
  const press = (pointerType: string, extra: Partial<{ isPrimary: boolean; button: number }> = {}) => {
    let activated = false;
    const result = activator.handler(
      { nativeEvent: { pointerType, isPrimary: true, button: 0, ...extra } } as never,
      { onActivation: () => (activated = true) },
    );
    return { result, activated };
  };

  it('lets mouse and pen start a pointer drag but leaves touch to the long-press TouchSensor', () => {
    expect(press('mouse')).toEqual({ result: true, activated: true });
    expect(press('pen')).toEqual({ result: true, activated: true });
    expect(press('touch')).toEqual({ result: false, activated: false });
    expect(press('mouse', { button: 2 }).result).toBe(false);
    expect(press('mouse', { isPrimary: false }).result).toBe(false);
  });

  it('columnStepDelta jumps a keyboard drag to the center of the neighboring column', () => {
    const columns = [0, 300, 600].map((left) => ({ left, width: 288 }));
    const cardInFirst = { left: 10, width: 260 };
    expect(columnStepDelta(cardInFirst, columns, 'right')).toBe(300 + 14 - 10);
    expect(columnStepDelta(cardInFirst, columns, 'left')).toBeNull();
    expect(columnStepDelta({ left: 614, width: 260 }, columns, 'right')).toBeNull();
    expect(columnStepDelta({ left: 614, width: 260 }, columns, 'left')).toBe(300 + 14 - 614);
    // In the gap between columns: the next column in the direction of travel.
    expect(columnStepDelta({ left: 160, width: 260 }, columns, 'right')).toBe(300 + 14 - 160);
    expect(columnStepDelta({ left: 160, width: 260 }, [], 'right')).toBeNull();
  });
});
