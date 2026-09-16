// The messages shown after bulk actions (D41), skip reasons (D42) and the calling setup notice (D43).
import { describe, expect, it } from 'vitest';
import { pickNotice, type SetupState } from '@/components/dashboard/calling-setup-notice';
import {
  describeAssignResult,
  describeCompletedFollowUps,
  describeDeleteResult,
  describeFollowUpResult,
  describeSourceResult,
  describeStatusResult,
  describeUndoResult,
  leadCount,
} from '@/lib/domain/bulk-leads';
import { SKIP_REASONS, SKIP_REASON_LABELS, describeSkipReason, isSkipReason } from '@/lib/domain/skips';

describe('bulk result messages', () => {
  it('counts leads with correct plurals', () => {
    expect(leadCount(1)).toBe('1 lead');
    expect(leadCount(1250)).toBe('1,250 leads');
  });

  it('status: what moved and why the rest did not', () => {
    expect(describeStatusResult({ requested: 4, updated: 4, unchanged: 0, locked: 0, missing: 0, undo: null }, 'INTERESTED')).toBe(
      'Moved 4 leads to Interested.',
    );
    expect(describeStatusResult({ requested: 5, updated: 2, unchanged: 1, locked: 1, missing: 1, undo: null }, 'TO_CALL')).toBe(
      'Moved 2 leads to To Call. 1 lead already was To Call; 1 lead marked Do Not Contact stays as it is (only an admin can reopen them); 1 lead is no longer available.',
    );
  });

  it('assignment and unassignment', () => {
    expect(describeAssignResult({ requested: 3, updated: 3, unchanged: 0, missing: 0, undo: null }, 'Alex Rivera')).toBe('Assigned 3 leads to Alex Rivera.');
    expect(describeAssignResult({ requested: 2, updated: 1, unchanged: 1, missing: 0, undo: null }, null)).toBe(
      'Unassigned 1 lead. 1 lead already was unassigned.',
    );
    expect(describeAssignResult({ requested: 1, updated: 0, unchanged: 1, missing: 0, undo: null }, 'Blair')).toBe(
      "No leads were assigned to Blair. 1 lead already was Blair's.",
    );
  });

  it('follow-ups, source, delete and undo', () => {
    expect(describeFollowUpResult({ requested: 5, created: 3, rescheduled: 1, missing: 1 })).toBe(
      'Follow-up set on 4 leads (3 new, 1 rescheduled). 1 lead is no longer available.',
    );
    expect(describeCompletedFollowUps({ requested: 2, count: 0 })).toBe('There were no open follow-ups to clear on these leads.');
    expect(describeCompletedFollowUps({ requested: 2, count: 3 })).toBe('Cleared 3 open follow-ups.');
    expect(describeSourceResult({ requested: 3, count: 2 }, 'Expo 2026')).toBe(
      'Set the source to "Expo 2026" on 2 leads. 1 lead already had it or is no longer available.',
    );
    expect(describeSourceResult({ requested: 1, count: 1 }, null)).toBe('Cleared the source on 1 lead.');
    expect(describeDeleteResult({ requested: 3, count: 3 })).toBe('Deleted 3 leads.');
    expect(describeUndoResult({ restored: 4, skipped: 1, failed: 2 })).toBe(
      'Undid the change on 4 leads. 1 lead changed again since, so it was left alone. 2 leads could not go back to an agent who is no longer active.',
    );
    expect(describeUndoResult({ restored: 0, skipped: 0, failed: 0 })).toBe('Nothing to undo.');
  });
});

describe('skip reasons', () => {
  it('has a label for every reason and describes reason, note or neither', () => {
    for (const reason of SKIP_REASONS) expect(SKIP_REASON_LABELS[reason]).toBeTruthy();
    expect(isSkipReason('CALL_LATER')).toBe(true);
    expect(isSkipReason('call_later')).toBe(false);
    expect(describeSkipReason('BAD_DATA', ' number disconnected ')).toBe('Details look wrong: number disconnected');
    expect(describeSkipReason('OTHER', 'Owner on holiday')).toBe('Owner on holiday');
    expect(describeSkipReason('NOT_PRIORITY', null)).toBe('Not a priority now');
    expect(describeSkipReason(null, 'Wrong branch')).toBe('Wrong branch');
    expect(describeSkipReason(null, '   ')).toBe('No reason given');
  });
});

describe('calling setup notice', () => {
  const ready: SetupState = {
    driver: 'twilio',
    inAppEnabled: true,
    callerIdAvailable: true,
    isAdmin: false,
    wantsInApp: true,
    deviceReady: true,
    connecting: false,
  };

  it('says nothing when calling is ready, or when calls go through the phone by design', () => {
    expect(pickNotice(ready)).toBeNull();
    expect(pickNotice({ ...ready, driver: 'tel', callerIdAvailable: false })).toBeNull();
    expect(pickNotice({ ...ready, wantsInApp: false, callerIdAvailable: false })).toBeNull();
    expect(pickNotice({ ...ready, deviceReady: false, connecting: true })).toBeNull();
  });

  it('warns about a missing caller ID number, pointing agents to their admin and admins to Phone Numbers', () => {
    expect(pickNotice({ ...ready, callerIdAvailable: false })).toMatchObject({ tone: 'warning', href: '/settings' });
    expect(pickNotice({ ...ready, callerIdAvailable: false, isAdmin: true })).toMatchObject({ tone: 'warning', href: '/admin/phone-numbers' });
  });

  it('explains the phone fallback when in-app calling is off or not connected', () => {
    expect(pickNotice({ ...ready, inAppEnabled: false })).toMatchObject({ tone: 'info', href: null });
    expect(pickNotice({ ...ready, deviceReady: false })).toMatchObject({ tone: 'info', href: '/settings' });
  });
});
