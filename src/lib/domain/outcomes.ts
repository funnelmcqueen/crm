import type { LeadStatus } from './statuses';

/** Same values as the `call_outcome` enum, in outcome-sheet order. */
export const CALL_OUTCOMES = [
  'NO_ANSWER',
  'VOICEMAIL',
  'CONNECTED',
  'INTERESTED',
  'FOLLOW_UP',
  'APPOINTMENT',
  'NOT_INTERESTED',
  'WRONG_NUMBER',
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const OUTCOME_LABELS: Readonly<Record<CallOutcome, string>> = {
  NO_ANSWER: 'No Answer',
  VOICEMAIL: 'Voicemail',
  CONNECTED: 'Connected',
  INTERESTED: 'Interested',
  FOLLOW_UP: 'Follow Up',
  APPOINTMENT: 'Appointment',
  NOT_INTERESTED: 'Not Interested',
  WRONG_NUMBER: 'Wrong Number',
};

export const CALL_OUTCOME_OPTIONS: ReadonlyArray<{ readonly value: CallOutcome; readonly label: string }> =
  CALL_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] }));

export function isCallOutcome(value: unknown): value is CallOutcome {
  return typeof value === 'string' && (CALL_OUTCOMES as readonly string[]).includes(value);
}

const OUTCOME_STATUS: Readonly<Record<CallOutcome, LeadStatus>> = {
  NO_ANSWER: 'NO_ANSWER',
  VOICEMAIL: 'VOICEMAIL',
  CONNECTED: 'CONNECTED',
  INTERESTED: 'INTERESTED',
  FOLLOW_UP: 'FOLLOW_UP',
  APPOINTMENT: 'APPOINTMENT',
  NOT_INTERESTED: 'NOT_INTERESTED',
  WRONG_NUMBER: 'DO_NOT_CONTACT',
};

const NO_DOWNGRADE_STATUSES: readonly LeadStatus[] = ['APPOINTMENT', 'PROPOSAL', 'CLIENT'];

/**
 * Mirrors SQL `public.outcome_to_status` (ARCHITECTURE 4.7). DO_NOT_CONTACT is sticky: no logged
 * outcome re-opens such a lead (DEVIATIONS D11).
 */
export function outcomeToStatus(outcome: CallOutcome, current: LeadStatus): LeadStatus {
  if (current === 'DO_NOT_CONTACT') return current;
  if ((outcome === 'NO_ANSWER' || outcome === 'VOICEMAIL') && NO_DOWNGRADE_STATUSES.includes(current)) {
    return current;
  }
  return OUTCOME_STATUS[outcome];
}

/** "Connected" in stats: any logged outcome except No Answer, Voicemail, Wrong Number. */
export function isConnectedOutcome(outcome: CallOutcome | null | undefined): boolean {
  return (
    outcome !== null &&
    outcome !== undefined &&
    outcome !== 'NO_ANSWER' &&
    outcome !== 'VOICEMAIL' &&
    outcome !== 'WRONG_NUMBER'
  );
}

/** FOLLOW_UP must be logged with a follow-up date (log_call raises 22023 otherwise). */
export function outcomeRequiresFollowUp(outcome: CallOutcome): boolean {
  return outcome === 'FOLLOW_UP';
}

export function preselectOutcomeForEndReason(
  reason: 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled',
): CallOutcome | null {
  return reason === 'busy' || reason === 'no-answer' || reason === 'failed' ? 'NO_ANSWER' : null;
}

export const WRONG_NUMBER_PREFIX = 'Wrong number';

const ASCII_WHITESPACE_EDGES = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const ALREADY_PREFIXED = /^wrong number(?: \u2014 |$)/i;

/** Mirrors how `log_call` stores notes: ASCII whitespace trimmed, blank becomes null. */
export function normalizeCallNotes(notes: string | null | undefined): string | null {
  const trimmed = (notes ?? '').replace(ASCII_WHITESPACE_EDGES, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * Mirrors what `log_call` stores for WRONG_NUMBER. Idempotent like the SQL: notes that already
 * start with the prefix ("Wrong number" alone, or followed by " \u2014 ") are kept as they are.
 */
export function applyWrongNumberPrefix(notes: string | null | undefined): string {
  const normalized = normalizeCallNotes(notes);
  if (normalized === null) return WRONG_NUMBER_PREFIX;
  return ALREADY_PREFIXED.test(normalized) ? normalized : `${WRONG_NUMBER_PREFIX} \u2014 ${normalized}`;
}
