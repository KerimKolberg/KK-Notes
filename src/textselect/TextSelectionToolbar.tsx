import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Type } from 'lucide-react';
import { useDocumentStore } from '../document/store';
import { copySelection, highlightSelection, textBoxFromSelection } from './actions';
import { spansBounds } from './geometry';
import { TEXT_HIGHLIGHT_COLORS, useTextSelectStore, type TextSelection } from './textSelectStore';

const GAP = 8;

/** The element on screen showing the page a selection is on, if it is on screen. */
function frameOf(selection: TextSelection): HTMLElement | null {
  const id = CSS.escape(selection.pageId);
  return document.querySelector<HTMLElement>(
    selection.surface === 'editor' ? `[data-page-index][data-page-id="${id}"]` : `[data-reference-page-id="${id}"]`,
  );
}

/**
 * What to do with selected text, floating just under it (or over it, where there is no room below): copy it, put
 * it on the note as a text box, or highlight it in one of four colours. Highlighting is for the note being written
 * in; the reading pane is for reading, and marks nothing.
 */
export const TextSelectionToolbar = memo(function TextSelectionToolbar() {
  const selection = useTextSelectStore((s) => s.selection);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!selection) {
      setPlace(null);
      return;
    }
    let request = 0;
    const measure = (): void => {
      request = 0;
      const frame = frameOf(selection);
      const bounds = spansBounds(selection.lines);
      const bar = ref.current;
      if (!frame || !bounds) {
        setPlace(null);
        return;
      }
      const rect = frame.getBoundingClientRect();
      const sx = rect.width / selection.pageWidth;
      const sy = rect.height / selection.pageHeight;
      const box = { left: rect.left + bounds.x * sx, top: rect.top + bounds.y * sy, right: rect.left + (bounds.x + bounds.width) * sx, bottom: rect.top + (bounds.y + bounds.height) * sy };
      // Gone off screen: nothing to point at.
      if (box.bottom < 0 || box.top > window.innerHeight || box.right < 0 || box.left > window.innerWidth) {
        setPlace(null);
        return;
      }
      const width = bar?.offsetWidth ?? 240;
      const height = bar?.offsetHeight ?? 40;
      const below = box.bottom + GAP;
      const top = below + height <= window.innerHeight - GAP ? below : Math.max(GAP, box.top - height - GAP);
      const left = Math.min(Math.max(GAP, (box.left + box.right) / 2 - width / 2), window.innerWidth - width - GAP);
      setPlace((was) => (was && Math.abs(was.left - left) < 0.5 && Math.abs(was.top - top) < 0.5 ? was : { left, top }));
    };
    const schedule = (): void => {
      if (!request) request = requestAnimationFrame(measure);
    };
    measure();
    // Once more after the bar has its real size.
    schedule();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (request) cancelAnimationFrame(request);
    };
  }, [selection]);

  // A selection on a page that is no longer there (deleted, or the pane closed) goes with it.
  const pageGone = useDocumentStore((s) => (selection?.surface === 'editor' ? !s.document.pages.some((p) => p.id === selection.pageId) : false));
  useEffect(() => {
    if (pageGone) useTextSelectStore.getState().setSelection(null);
  }, [pageGone]);

  if (!selection) return null;
  const canMark = selection.surface === 'editor' && !readOnly;
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selected text"
      data-text-toolbar
      className="fixed z-[60] flex items-center gap-0.5 rounded-xl border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999, visibility: 'hidden' }}
    >
      <button
        type="button"
        data-text-copy
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
        onClick={() => void copySelection(selection)}
      >
        <Copy size={14} aria-hidden="true" />
        Copy
      </button>
      <button
        type="button"
        data-text-to-box
        disabled={readOnly}
        title={selection.surface === 'editor' ? 'Put these words on the page as a text box' : 'Put these words on the page you are writing on'}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800"
        onClick={() => textBoxFromSelection(selection)}
      >
        <Type size={14} aria-hidden="true" />
        Text box
      </button>
      {canMark && (
        <>
          <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />
          {TEXT_HIGHLIGHT_COLORS.map(({ color, name }) => (
            <button
              key={color}
              type="button"
              aria-label={`Highlight in ${name}`}
              title={`Highlight in ${name}`}
              data-text-highlight={name}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => highlightSelection(selection, color)}
            >
              <span className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ backgroundColor: color }} aria-hidden="true" />
            </button>
          ))}
        </>
      )}
    </div>
  );
});
