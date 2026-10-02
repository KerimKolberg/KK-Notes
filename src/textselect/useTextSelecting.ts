import { useEffect } from 'react';
import { startAutoScroll, viewerElement, type AutoScroll } from '../document/autoScroll';
import type { Page } from '../document/types';
import { isPenNearby, notePenPresence } from '../inking/engine/gestureState';
import { pdfPageTextRuns } from '../pdf/pdfTextLayout';
import { pageOfFrame } from '../snip/useSnipping';
import { copySelection } from './actions';
import { caretAt, isCollapsed, selectedText, selectionLines, wordAround, type Caret, type TextRun } from './geometry';
import { useTextSelectStore, type TextSurface } from './textSelectStore';

/** Every page on screen, in the editor and in the reference pane. */
const FRAME = '[data-page-index], [data-reference-page-frame]';

/** How near text (page units) a drag has to start to select any. */
const START_DISTANCE = 36;
/** Two taps this close in time and place are a double tap, which takes the word under them. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 24;
/** A press that moves less than this is a tap, which clears the selection. */
const TAP_SLOP_PX = 5;

interface Drag {
  readonly frame: HTMLElement;
  readonly surface: TextSurface;
  readonly page: Page;
  readonly pointerId: number;
  readonly start: { x: number; y: number };
  last: { x: number; y: number };
  moved: boolean;
  /** A double tap: the word is selected and the rest of the press does nothing. */
  word: boolean;
  runs: readonly TextRun[] | null;
  anchor: Caret | null;
  scroll: AutoScroll | null;
  /** Let go: a page whose text arrives after this still gets the selection the drag made. */
  ended: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * Selecting the text of a PDF: while it is on, dragging a pen, a mouse or a finger over a PDF page — in the editor
 * or the reading pane — selects the words it passes over, a double tap takes one word, and a tap clears it. Pages
 * that are not from a PDF have no text to select and are left to the pen.
 *
 * It listens in the capture phase on the window, as snipping does, so the drag never reaches the page's own
 * handlers; and dragging to the edge of the page area scrolls it, so a long page can be selected down to its foot.
 */
export function useTextSelecting(): void {
  const mode = useTextSelectStore((s) => s.mode);

  useEffect(() => {
    if (!mode) return;
    document.documentElement.dataset.textSelecting = 'true';
    let drag: Drag | null = null;
    let frameRequest = 0;
    let lastTap = { time: 0, x: 0, y: 0 };

    const toPage = (d: Drag, client: { x: number; y: number }) => {
      const rect = d.frame.getBoundingClientRect();
      return {
        x: ((client.x - rect.left) / Math.max(1, rect.width)) * d.page.dimensions.width,
        y: ((client.y - rect.top) / Math.max(1, rect.height)) * d.page.dimensions.height,
      };
    };

    const publish = (d: Drag, a: Caret, b: Caret): void => {
      const runs = d.runs!;
      const { setSelection } = useTextSelectStore.getState();
      if (isCollapsed(runs, a, b)) {
        setSelection(null);
        return;
      }
      setSelection({
        surface: d.surface,
        pageId: d.page.id,
        pageWidth: d.page.dimensions.width,
        pageHeight: d.page.dimensions.height,
        lines: selectionLines(runs, a, b),
        text: selectedText(runs, a, b),
      });
    };

    const update = (): void => {
      frameRequest = 0;
      const d = drag;
      if (!d || !d.runs || !d.anchor || d.word || !d.moved) return;
      const focus = caretAt(d.runs, toPage(d, d.last));
      if (focus) publish(d, d.anchor, focus);
    };
    const schedule = (): void => {
      if (!frameRequest) frameRequest = requestAnimationFrame(update);
    };

    const end = (): void => {
      drag?.scroll?.stop();
      drag = null;
    };

    const onDown = (e: PointerEvent): void => {
      if (e.pointerType === 'pen') notePenPresence();
      if (drag) {
        // A second finger: the selection stays as it is, and the pinch is the page's.
        if (e.pointerType === 'touch') end();
        return;
      }
      if (e.button !== 0) return;
      if (e.pointerType === 'touch' && isPenNearby()) return;
      const frame = e.target instanceof Element ? e.target.closest<HTMLElement>(FRAME) : null;
      if (!frame) return;
      const found = pageOfFrame(frame);
      const pdf = found?.page.pdf;
      if (!found || !pdf) return;
      e.preventDefault();
      e.stopPropagation();

      const client = { x: e.clientX, y: e.clientY };
      const now = performance.now();
      const doubleTap = now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(client.x - lastTap.x, client.y - lastTap.y) < DOUBLE_TAP_PX;
      lastTap = doubleTap ? { time: 0, x: 0, y: 0 } : { time: now, ...client };

      const surface: TextSurface = frame.dataset.pageIndex !== undefined ? 'editor' : 'reference';
      const d: Drag = {
        frame,
        surface,
        page: found.page,
        pointerId: e.pointerId,
        start: client,
        last: client,
        moved: false,
        word: doubleTap,
        runs: null,
        anchor: null,
        scroll: null,
        ended: false,
      };
      drag = d;
      d.scroll = startAutoScroll(
        () => (drag === d && d.moved ? d.last : null),
        () => schedule(),
        surface === 'editor' ? viewerElement : () => frame.closest<HTMLElement>('[data-reference-scroll]'),
      );

      pdfPageTextRuns(pdf).then(
        (runs) => {
          d.runs = runs;
          const p = toPage(d, d.start);
          if (d.word) {
            const caret = caretAt(runs, p, START_DISTANCE);
            const word = caret ? wordAround(runs, caret) : null;
            if (word) publish(d, word[0], word[1]);
            return;
          }
          d.anchor = caretAt(runs, p, START_DISTANCE);
          if (drag === d) schedule();
          else if (d.ended && d.moved && d.anchor) {
            // A quick drag, over before the page's text was read.
            const focus = caretAt(runs, toPage(d, d.last));
            if (focus) publish(d, d.anchor, focus);
          }
        },
        () => {
          if (drag === d) end();
        },
      );
    };

    const onMove = (e: PointerEvent): void => {
      const d = drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      d.last = { x: e.clientX, y: e.clientY };
      if (!d.moved && Math.hypot(d.last.x - d.start.x, d.last.y - d.start.y) >= TAP_SLOP_PX) d.moved = true;
      schedule();
    };

    const onUp = (e: PointerEvent): void => {
      const d = drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      // A tap (that is not the first of a double tap's pair being completed) clears what was selected.
      d.last = { x: e.clientX, y: e.clientY };
      if (!d.moved && Math.hypot(d.last.x - d.start.x, d.last.y - d.start.y) >= TAP_SLOP_PX) d.moved = true;
      if (!d.moved && !d.word) useTextSelectStore.getState().setSelection(null);
      else update();
      d.ended = true;
      end();
    };

    const onCancel = (e: PointerEvent): void => {
      if (drag && e.pointerId === drag.pointerId) end();
    };

    const onKey = (e: KeyboardEvent): void => {
      const { selection, setSelection, setMode } = useTextSelectStore.getState();
      if (e.key === 'Escape') {
        if (drag) end();
        if (selection) setSelection(null);
        else setMode(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c' && selection && !isEditable(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        void copySelection(selection);
      }
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      if (frameRequest) cancelAnimationFrame(frameRequest);
      end();
      delete document.documentElement.dataset.textSelecting;
    };
  }, [mode]);
}
