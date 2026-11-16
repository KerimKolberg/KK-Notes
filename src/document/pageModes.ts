import { useSnipStore } from '../snip/snipStore';
import { useTextSelectStore } from '../textselect/textSelectStore';

/**
 * Selecting a PDF's text and snipping are modes the pages are in, not tools: while one is on, it takes every press
 * on a PDF page before the ink does. Left on and forgotten, a pen chosen on the toolbar wrote nothing on a PDF and
 * said nothing about why (found looking into a report from the Flow Z13). Reaching for a tool on the toolbar is
 * reaching for the pen, so it ends them.
 */
export function endPageModes(): void {
  const text = useTextSelectStore.getState();
  if (text.mode) text.setMode(false);
  const snip = useSnipStore.getState();
  if (snip.mode) snip.setMode(false);
}
