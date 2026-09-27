/**
 * Files dragged onto the window — the fourth door into the app.
 *
 * The other three are a file association or intent ({@link useOpenWith}), the
 * library's picker (`openFileFromLibrary`), and the document stage's own drop,
 * which places images on a page. This is the rest of the window.
 *
 * Two jobs, and the second matters more than the first.
 *
 * **Routing.** A `.notex`, a PDF or a `.goodnotes` dropped anywhere sensible
 * should open, through the same decision every other door takes rather than a
 * fourth copy of it.
 *
 * **Swallowing everything else.** A webview's default action for a file drop it
 * was not offered is to *navigate to the file*. Drop a PDF on the top bar and
 * the app is replaced by the browser's PDF viewer, with whatever was unsaved
 * gone and no way back but relaunching. That is not hypothetical — every pixel
 * outside the page stage was such a target. So the guard here prevents the
 * default for file drags across the whole window, and only explicit handlers
 * act.
 *
 * It is careful to touch *file* drags only. The library moves entries between
 * folders with its own HTML5 drag-and-drop carrying `text/notes-entry`, and a
 * guard that swallowed that would break moving notes.
 */
import { useEffect } from 'react';

/** Does this drag carry files from outside the app, rather than our own payload? */
export function isFileDrag(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  // `types` is the only thing readable during `dragover` — the files themselves
  // are withheld until the drop, by design.
  return [...transfer.types].includes('Files');
}

/**
 * Stop the webview navigating away when a file is dropped on nothing.
 *
 * Mounted once, above the router. Inner handlers run first and prevent the
 * default themselves; this only catches what they did not, where the default is
 * destructive. Registered on `window` in the bubble phase for exactly that
 * reason: a capture-phase listener would fire *before* the real targets and make
 * their own `dropEffect` decisions moot.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
    };
    // `dragover` as well as `drop`: without preventing the drag, the drop never
    // fires as a drop at all — the webview treats it as a navigation.
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);
}
