import { describe, expect, it } from 'vitest';
import { isFileDrag } from '../useFileDrop';

/**
 * Telling a file dragged in from outside apart from the app's own drag.
 *
 * The distinction is load-bearing in both directions. Miss a file drag and the
 * webview navigates to the file, replacing the app. Catch the library's own
 * drag — which carries `text/notes-entry` to move a note between folders — and
 * moving notes stops working.
 *
 * `types` is all there is to go on: the files themselves are withheld until the
 * drop, so a `dragover` handler cannot look at them even in principle.
 */
const transfer = (types: string[]): DataTransfer => ({ types }) as unknown as DataTransfer;

describe('recognising a file drag', () => {
  it('recognises files arriving from outside', () => {
    expect(isFileDrag(transfer(['Files']))).toBe(true);
    // Explorer sends a text flavour alongside the files.
    expect(isFileDrag(transfer(['text/plain', 'Files']))).toBe(true);
  });

  it('leaves the library’s own drag alone', () => {
    // Moving a note into a folder. Swallowing this would break the library.
    expect(isFileDrag(transfer(['text/notes-entry']))).toBe(false);
    expect(isFileDrag(transfer(['text/plain']))).toBe(false);
    expect(isFileDrag(transfer([]))).toBe(false);
  });

  it('says no when there is no transfer at all', () => {
    // A synthesised event, or one whose transfer the engine withheld.
    expect(isFileDrag(null)).toBe(false);
  });
});
