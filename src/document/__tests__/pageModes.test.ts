import { describe, expect, it } from 'vitest';
import { endPageModes } from '../pageModes';
import { useSnipStore } from '../../snip/snipStore';
import { useTextSelectStore } from '../../textselect/textSelectStore';

describe('reaching for a tool', () => {
  it('ends selecting text, which would take the pen on a PDF', () => {
    useTextSelectStore.getState().setMode(true);
    endPageModes();
    expect(useTextSelectStore.getState().mode).toBe(false);
  });

  it('ends snipping', () => {
    useSnipStore.getState().setMode(true);
    endPageModes();
    expect(useSnipStore.getState().mode).toBe(false);
  });
});
