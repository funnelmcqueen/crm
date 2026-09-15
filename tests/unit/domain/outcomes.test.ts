import { describe, expect, it } from 'vitest';
import {
  CALL_OUTCOMES,
  CALL_OUTCOME_OPTIONS,
  OUTCOME_LABELS,
  WRONG_NUMBER_PREFIX,
  applyWrongNumberPrefix,
  isCallOutcome,
  isConnectedOutcome,
  normalizeCallNotes,
  outcomeRequiresFollowUp,
  outcomeToStatus,
  preselectOutcomeForEndReason,
  type CallOutcome,
} from '../../../src/lib/domain/outcomes';
import { LEAD_STATUSES, type LeadStatus } from '../../../src/lib/domain/statuses';

describe('CALL_OUTCOMES', () => {
  it('lists the enum values in outcome-sheet order with labels', () => {
    expect(CALL_OUTCOMES).toEqual([
      'NO_ANSWER',
      'VOICEMAIL',
      'CONNECTED',
      'INTERESTED',
      'FOLLOW_UP',
      'APPOINTMENT',
      'NOT_INTERESTED',
      'WRONG_NUMBER',
    ]);
    expect(CALL_OUTCOMES.map((outcome) => OUTCOME_LABELS[outcome])).toEqual([
      'No Answer',
      'Voicemail',
      'Connected',
      'Interested',
      'Follow Up',
      'Appointment',
      'Not Interested',
      'Wrong Number',
    ]);
    expect(CALL_OUTCOME_OPTIONS).toEqual(CALL_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] })));
  });

  it('recognizes outcome values', () => {
    expect(isCallOutcome('CONNECTED')).toBe(true);
    expect(isCallOutcome('connected')).toBe(false);
    expect(isCallOutcome('DO_NOT_CONTACT')).toBe(false);
    expect(isCallOutcome(42)).toBe(false);
    expect(isCallOutcome(null)).toBe(false);
  });
});

describe('outcomeToStatus', () => {
  it.each<[CallOutcome, LeadStatus]>([
    ['NO_ANSWER', 'NO_ANSWER'],
    ['VOICEMAIL', 'VOICEMAIL'],
    ['CONNECTED', 'CONNECTED'],
    ['INTERESTED', 'INTERESTED'],
    ['FOLLOW_UP', 'FOLLOW_UP'],
    ['APPOINTMENT', 'APPOINTMENT'],
    ['NOT_INTERESTED', 'NOT_INTERESTED'],
    ['WRONG_NUMBER', 'DO_NOT_CONTACT'],
  ])('maps %s to %s on a NEW lead', (outcome, status) => {
    expect(outcomeToStatus(outcome, 'NEW')).toBe(status);
  });

  it.each<LeadStatus>(['APPOINTMENT', 'PROPOSAL', 'CLIENT'])('never downgrades %s on No Answer or Voicemail', (current) => {
    expect(outcomeToStatus('NO_ANSWER', current)).toBe(current);
    expect(outcomeToStatus('VOICEMAIL', current)).toBe(current);
  });

  it.each<LeadStatus>(['NEW', 'TO_CALL', 'NO_ANSWER', 'VOICEMAIL', 'CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'NOT_INTERESTED'])(
    'applies No Answer / Voicemail normally on %s',
    (current) => {
      expect(outcomeToStatus('NO_ANSWER', current)).toBe('NO_ANSWER');
      expect(outcomeToStatus('VOICEMAIL', current)).toBe('VOICEMAIL');
    },
  );

  it('applies every other outcome even on protected statuses', () => {
    expect(outcomeToStatus('WRONG_NUMBER', 'CLIENT')).toBe('DO_NOT_CONTACT');
    expect(outcomeToStatus('NOT_INTERESTED', 'APPOINTMENT')).toBe('NOT_INTERESTED');
    expect(outcomeToStatus('CONNECTED', 'PROPOSAL')).toBe('CONNECTED');
    expect(outcomeToStatus('FOLLOW_UP', 'CLIENT')).toBe('FOLLOW_UP');
  });

  it.each<CallOutcome>([...CALL_OUTCOMES])('keeps DO_NOT_CONTACT sticky on %s (DEVIATIONS D11)', (outcome) => {
    expect(outcomeToStatus(outcome, 'DO_NOT_CONTACT')).toBe('DO_NOT_CONTACT');
  });

  it('matches the ARCHITECTURE 4.7 rules for the full outcome x status matrix', () => {
    const mapping: Record<CallOutcome, LeadStatus> = {
      NO_ANSWER: 'NO_ANSWER',
      VOICEMAIL: 'VOICEMAIL',
      CONNECTED: 'CONNECTED',
      INTERESTED: 'INTERESTED',
      FOLLOW_UP: 'FOLLOW_UP',
      APPOINTMENT: 'APPOINTMENT',
      NOT_INTERESTED: 'NOT_INTERESTED',
      WRONG_NUMBER: 'DO_NOT_CONTACT',
    };
    let checked = 0;
    for (const outcome of CALL_OUTCOMES) {
      for (const current of LEAD_STATUSES) {
        const keep =
          current === 'DO_NOT_CONTACT' ||
          (['NO_ANSWER', 'VOICEMAIL'].includes(outcome) && ['APPOINTMENT', 'PROPOSAL', 'CLIENT'].includes(current));
        expect(outcomeToStatus(outcome, current)).toBe(keep ? current : mapping[outcome]);
        checked += 1;
      }
    }
    expect(checked).toBe(8 * 12);
  });
});

describe('isConnectedOutcome', () => {
  it.each<CallOutcome>(['CONNECTED', 'INTERESTED', 'FOLLOW_UP', 'APPOINTMENT', 'NOT_INTERESTED'])('counts %s', (outcome) => {
    expect(isConnectedOutcome(outcome)).toBe(true);
  });

  it.each([['NO_ANSWER'], ['VOICEMAIL'], ['WRONG_NUMBER'], [null], [undefined]] as Array<[CallOutcome | null | undefined]>)(
    'does not count %s',
    (outcome) => {
      expect(isConnectedOutcome(outcome)).toBe(false);
    },
  );
});

describe('outcomeRequiresFollowUp', () => {
  it('is true only for FOLLOW_UP', () => {
    expect(CALL_OUTCOMES.filter((outcome) => outcomeRequiresFollowUp(outcome))).toEqual(['FOLLOW_UP']);
  });
});

describe('preselectOutcomeForEndReason', () => {
  it('pre-selects No Answer for busy, no-answer and failed', () => {
    expect(preselectOutcomeForEndReason('busy')).toBe('NO_ANSWER');
    expect(preselectOutcomeForEndReason('no-answer')).toBe('NO_ANSWER');
    expect(preselectOutcomeForEndReason('failed')).toBe('NO_ANSWER');
  });

  it('pre-selects nothing for completed and canceled calls', () => {
    expect(preselectOutcomeForEndReason('completed')).toBeNull();
    expect(preselectOutcomeForEndReason('canceled')).toBeNull();
  });
});

describe('applyWrongNumberPrefix', () => {
  it.each([null, undefined, '', '   ', ' \n\t '])('uses the bare prefix for empty notes (%j)', (notes) => {
    expect(applyWrongNumberPrefix(notes)).toBe('Wrong number');
  });

  it('prefixes trimmed notes with an em dash separator', () => {
    expect(applyWrongNumberPrefix('Asked for Bob')).toBe('Wrong number \u2014 Asked for Bob');
    expect(applyWrongNumberPrefix('  padded note \n')).toBe('Wrong number \u2014 padded note');
    const result = applyWrongNumberPrefix('x');
    expect(result.charCodeAt(WRONG_NUMBER_PREFIX.length + 1)).toBe(0x2014);
    expect(result).not.toContain('-');
  });

  it('is idempotent, so a retried save never doubles the prefix', () => {
    const once = applyWrongNumberPrefix('Asked for Bob');
    expect(applyWrongNumberPrefix(once)).toBe(once);
    expect(applyWrongNumberPrefix('wrong NUMBER')).toBe('wrong NUMBER');
    expect(applyWrongNumberPrefix('WRONG NUMBER — x')).toBe('WRONG NUMBER — x');
  });

  it('only recognises the exact prefix form', () => {
    expect(applyWrongNumberPrefix('Wrong numbers again')).toBe('Wrong number — Wrong numbers again');
    expect(applyWrongNumberPrefix('Wrong number - dash')).toBe('Wrong number — Wrong number - dash');
  });

  it('trims ASCII whitespace only, like the SQL', () => {
    expect(applyWrongNumberPrefix(' note ')).toBe('Wrong number —  note ');
  });
});

describe('normalizeCallNotes', () => {
  it.each([null, undefined, '', ' \t\r\n\f\v '])('turns blank notes (%j) into null', (notes) => {
    expect(normalizeCallNotes(notes)).toBeNull();
  });

  it('trims surrounding ASCII whitespace and keeps inner text', () => {
    expect(normalizeCallNotes('  line one\nline two \n')).toBe('line one\nline two');
  });
});
