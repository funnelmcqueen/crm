// Enter in the outcome sheet: on an outcome button it chooses that outcome (a second Enter saves it);
// it never saves a different outcome than the one the focused button shows.
import { describe, expect, it } from 'vitest';
import { outcomeSheetEnterAction } from '@/lib/dialer/outcome-form';

const outcomeButton = (outcome: string) => ({ tagName: 'BUTTON', isButton: true, outcome, isSaveNext: false });

describe('outcomeSheetEnterAction', () => {
  it('selects the focused outcome when it differs from the preselected one instead of saving the old one', () => {
    expect(outcomeSheetEnterAction(outcomeButton('CONNECTED'), 'NO_ANSWER')).toEqual({ kind: 'select', outcome: 'CONNECTED' });
    expect(outcomeSheetEnterAction(outcomeButton('WRONG_NUMBER'), 'NO_ANSWER')).toEqual({ kind: 'select', outcome: 'WRONG_NUMBER' });
  });

  it('selects the focused outcome when nothing is selected yet', () => {
    expect(outcomeSheetEnterAction(outcomeButton('VOICEMAIL'), null)).toEqual({ kind: 'select', outcome: 'VOICEMAIL' });
  });

  it('saves when the focused outcome button is the selected one', () => {
    expect(outcomeSheetEnterAction(outcomeButton('CONNECTED'), 'CONNECTED')).toEqual({ kind: 'save' });
  });

  it('saves from Save & Next and from plain inputs, and leaves textareas and other buttons alone', () => {
    expect(outcomeSheetEnterAction({ tagName: 'BUTTON', isButton: true, outcome: null, isSaveNext: true }, 'CONNECTED')).toEqual({ kind: 'save' });
    expect(outcomeSheetEnterAction({ tagName: 'INPUT', isButton: false, outcome: null, isSaveNext: false }, 'CONNECTED')).toEqual({ kind: 'save' });
    expect(outcomeSheetEnterAction({ tagName: 'TEXTAREA', isButton: false, outcome: null, isSaveNext: false }, 'CONNECTED')).toEqual({ kind: 'ignore' });
    expect(outcomeSheetEnterAction({ tagName: 'BUTTON', isButton: true, outcome: null, isSaveNext: false }, 'CONNECTED')).toEqual({ kind: 'ignore' });
  });

  it('ignores an outcome attribute that is not a real outcome', () => {
    expect(outcomeSheetEnterAction(outcomeButton('DROP_TABLE'), 'CONNECTED')).toEqual({ kind: 'ignore' });
  });
});
