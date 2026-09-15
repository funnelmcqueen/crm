import { describe, expect, it } from 'vitest';
import {
  CLOSED_PIPELINE_COLUMNS,
  LEAD_STATUSES,
  PIPELINE_COLUMNS,
  STATUS_LABELS,
  STATUS_TONE,
  isDialable,
  isLeadStatus,
  pipelineBadgeFor,
  pipelineColumnFor,
  type LeadStatus,
} from '../../../src/lib/domain/statuses';

describe('LEAD_STATUSES', () => {
  it('follows the SPEC section 6 order', () => {
    expect(LEAD_STATUSES).toEqual([
      'NEW',
      'TO_CALL',
      'NO_ANSWER',
      'VOICEMAIL',
      'CONNECTED',
      'INTERESTED',
      'FOLLOW_UP',
      'APPOINTMENT',
      'PROPOSAL',
      'CLIENT',
      'NOT_INTERESTED',
      'DO_NOT_CONTACT',
    ]);
  });

  it('recognizes status values', () => {
    expect(isLeadStatus('CLIENT')).toBe(true);
    expect(isLeadStatus('client')).toBe(false);
    expect(isLeadStatus('WRONG_NUMBER')).toBe(false);
    expect(isLeadStatus(undefined)).toBe(false);
  });
});

describe('STATUS_LABELS and STATUS_TONE', () => {
  it('labels every status', () => {
    expect(LEAD_STATUSES.map((status) => STATUS_LABELS[status])).toEqual([
      'New',
      'To Call',
      'No Answer',
      'Voicemail',
      'Connected',
      'Interested',
      'Follow Up',
      'Appointment',
      'Proposal',
      'Client',
      'Not Interested',
      'Do Not Contact',
    ]);
  });

  it('gives every status a known tone', () => {
    const tones = ['neutral', 'info', 'warning', 'success', 'gold', 'danger', 'muted'];
    for (const status of LEAD_STATUSES) expect(tones).toContain(STATUS_TONE[status]);
    expect(Object.keys(STATUS_TONE).sort()).toEqual([...LEAD_STATUSES].sort());
    expect(STATUS_TONE.DO_NOT_CONTACT).toBe('danger');
    expect(STATUS_TONE.CLIENT).toBe('gold');
    expect(LEAD_STATUSES.filter((status) => STATUS_TONE[status] === 'gold')).toEqual(['CLIENT']);
  });
});

describe('pipeline columns', () => {
  it('has the SPEC columns in order', () => {
    expect(PIPELINE_COLUMNS.map((column) => [column.key, column.label])).toEqual([
      ['NEW', 'New'],
      ['TO_CALL', 'To Call'],
      ['CONNECTED', 'Connected'],
      ['INTERESTED', 'Interested'],
      ['APPOINTMENT', 'Appointment'],
      ['PROPOSAL', 'Proposal'],
      ['CLIENT', 'Client'],
    ]);
    expect(CLOSED_PIPELINE_COLUMNS.map((column) => [column.key, column.label])).toEqual([
      ['NOT_INTERESTED', 'Not Interested'],
      ['DO_NOT_CONTACT', 'Do Not Contact'],
    ]);
    expect(PIPELINE_COLUMNS.every((column) => !column.closed)).toBe(true);
    expect(CLOSED_PIPELINE_COLUMNS.every((column) => column.closed)).toBe(true);
  });

  it('groups badge statuses into TO CALL and CONNECTED', () => {
    expect(PIPELINE_COLUMNS.find((column) => column.key === 'TO_CALL')?.statuses).toEqual(['TO_CALL', 'NO_ANSWER', 'VOICEMAIL']);
    expect(PIPELINE_COLUMNS.find((column) => column.key === 'CONNECTED')?.statuses).toEqual(['CONNECTED', 'FOLLOW_UP']);
  });

  it('covers every status exactly once', () => {
    const all = [...PIPELINE_COLUMNS, ...CLOSED_PIPELINE_COLUMNS].flatMap((column) => column.statuses);
    expect([...all].sort()).toEqual([...LEAD_STATUSES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('drops set a status that belongs to the column itself', () => {
    for (const column of [...PIPELINE_COLUMNS, ...CLOSED_PIPELINE_COLUMNS]) {
      expect(column.statuses).toContain(column.dropStatus);
      expect(column.dropStatus).toBe(column.key);
      expect(pipelineColumnFor(column.dropStatus)).toBe(column);
    }
  });

  it.each<[LeadStatus, string]>([
    ['NEW', 'NEW'],
    ['TO_CALL', 'TO_CALL'],
    ['NO_ANSWER', 'TO_CALL'],
    ['VOICEMAIL', 'TO_CALL'],
    ['CONNECTED', 'CONNECTED'],
    ['FOLLOW_UP', 'CONNECTED'],
    ['INTERESTED', 'INTERESTED'],
    ['APPOINTMENT', 'APPOINTMENT'],
    ['PROPOSAL', 'PROPOSAL'],
    ['CLIENT', 'CLIENT'],
    ['NOT_INTERESTED', 'NOT_INTERESTED'],
    ['DO_NOT_CONTACT', 'DO_NOT_CONTACT'],
  ])('puts %s in column %s', (status, key) => {
    expect(pipelineColumnFor(status).key).toBe(key);
  });

  it('throws for values that are not statuses', () => {
    expect(() => pipelineColumnFor('BOGUS' as LeadStatus)).toThrow(RangeError);
  });

  it('badges only the grouped statuses', () => {
    expect(pipelineBadgeFor('NO_ANSWER')).toBe('No answer');
    expect(pipelineBadgeFor('VOICEMAIL')).toBe('Voicemail');
    expect(pipelineBadgeFor('FOLLOW_UP')).toBe('Follow-up');
    const unbadged = LEAD_STATUSES.filter((status) => !['NO_ANSWER', 'VOICEMAIL', 'FOLLOW_UP'].includes(status));
    for (const status of unbadged) expect(pipelineBadgeFor(status)).toBeNull();
  });
});

describe('isDialable', () => {
  it('is false only for DO_NOT_CONTACT', () => {
    expect(LEAD_STATUSES.filter((status) => !isDialable(status))).toEqual(['DO_NOT_CONTACT']);
  });
});
