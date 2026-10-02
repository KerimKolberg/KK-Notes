/**
 * What can be done with text selected in a PDF: copy it, highlight it, or put it on the note as a text box.
 */
import { useDesktopStore } from '../desktop/desktopStore';
import { createTextBox, DEFAULT_TEXT_STYLE, nextZIndex } from '../document/media';
import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';
import { createStrokeId } from '../inking/engine/ids';
import { freehandBBox } from '../inking/engine/strokeBuilder';
import { styleForTool } from '../inking/engine/toolStyles';
import type { FreehandStroke, InkPoint, StrokeStyle } from '../inking/types';
import { spanHighlight, spansBounds, type LineSpan } from './geometry';
import { useTextSelectStore, type TextSelection } from './textSelectStore';

const notice = (text: string): void => useDesktopStore.getState().setNotice({ text });

/** Put text on the clipboard; `false` when the platform would not. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the old way, which some webviews still allow when the new one is refused.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    Object.assign(area.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copySelection(selection: TextSelection): Promise<void> {
  const ok = await copyText(selection.text);
  const words = selection.text.split(/\s+/).filter(Boolean).length;
  notice(ok ? `Copied ${words === 1 ? 'a word' : `${words} words`}.` : 'Could not copy: this system did not allow it.');
}

/** Points along a straight line, for a stroke made without a pen. */
function lineOfPoints(from: { x: number; y: number }, to: { x: number; y: number }): InkPoint[] {
  const steps = 6;
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
    pressure: 0.5,
  }));
}

/**
 * Highlighter strokes over each selected line, as if drawn with a ruler: the highlighter's own look (its
 * opacity and blend, so ink under it shows through) in `color`, as thick as the line's letters. They are ordinary
 * highlighter strokes, so the eraser, the lasso and the PDF export treat them like any other, and several lines
 * are one group, taken by the lasso together and back by one Undo.
 */
export function highlightStrokes(lines: readonly LineSpan[], color: string): FreehandStroke[] {
  const base = styleForTool('highlighter', useToolStore.getState().settings, 'mouse');
  const { gradient: _gradient, ...plain } = base;
  const groupId = lines.length > 1 ? `g_${createStrokeId()}` : undefined;
  const now = performance.now();
  return lines.map((line) => {
    const { from, to, width } = spanHighlight(line);
    // Straight already, so nothing to smooth: streamlining would pull the stroke's far end back from the text's.
    const style: StrokeStyle = { ...plain, color, size: width, pattern: 'solid', arrowheads: 'none', streamline: 0 };
    const points = lineOfPoints(from, to);
    return {
      kind: 'freehand',
      id: createStrokeId(),
      tool: 'highlighter',
      points,
      style,
      bbox: freehandBBox(points, style),
      pointerType: 'mouse',
      createdAt: now,
      ...(groupId ? { groupId } : {}),
    };
  });
}

/** Highlight the selection on the note's page it is on. Only the note being written in can be marked. */
export function highlightSelection(selection: TextSelection, color: string): boolean {
  if (selection.surface !== 'editor') return false;
  const state = useDocumentStore.getState();
  if (state.readOnly) {
    notice('This note is locked for presenting, so nothing can be marked on it.');
    return false;
  }
  if (!state.document.pages.some((p) => p.id === selection.pageId)) return false;
  state.commitStrokes(selection.pageId, highlightStrokes(selection.lines, color));
  useTextSelectStore.getState().setSelection(null);
  return true;
}

const TEXT_BOX_MAX_WIDTH = 420;
const LINE_HEIGHT = 1.35;

/**
 * Put the selected words on the note as a text box. From the note's own page it goes just under the words it came
 * from; from the reading pane, on the page being written in, in the middle. It is left selected, with the select
 * tool, so it can be moved straight away — and selecting text is put away, since a drag on a PDF page would
 * otherwise select text instead of moving the box.
 */
export function textBoxFromSelection(selection: TextSelection): boolean {
  const state = useDocumentStore.getState();
  if (state.readOnly) {
    notice('This note is locked for presenting, so nothing can be added to it.');
    return false;
  }
  const doc = state.document;
  const onNote = selection.surface === 'editor' ? doc.pages.findIndex((p) => p.id === selection.pageId) : -1;
  const index = onNote >= 0 ? onNote : doc.activePageIndex;
  const page = doc.pages[index];
  if (!page) return false;

  const lines = selection.text.split('\n');
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const fontSize = DEFAULT_TEXT_STYLE.fontSize;
  const width = Math.min(TEXT_BOX_MAX_WIDTH, page.dimensions.width - 32, Math.max(120, longest * fontSize * 0.55 + 24));
  // Room for the lines as they will wrap at that width.
  const perLine = Math.max(1, Math.floor((width - 16) / (fontSize * 0.55)));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const height = Math.min(page.dimensions.height - 32, rows * fontSize * LINE_HEIGHT + 24);

  let centre: { x: number; y: number } | undefined;
  if (onNote >= 0) {
    const bounds = spansBounds(selection.lines);
    if (bounds) {
      const x = Math.min(Math.max(16, bounds.x), page.dimensions.width - width - 16);
      const below = bounds.y + bounds.height + 12;
      const y = below + height <= page.dimensions.height - 16 ? below : Math.max(16, bounds.y - height - 12);
      centre = { x: x + width / 2, y: y + height / 2 };
    }
  }
  const box = createTextBox(page.dimensions, nextZIndex(page.media), centre, { text: selection.text, width, height });

  useTextSelectStore.getState().setMode(false);
  state.addMediaUndoable(page.id, box, 'adding text from the PDF');
  state.setActivePage(index);
  useToolStore.getState().update({ tool: 'select' });
  state.selectMedia({ pageId: page.id, mediaId: box.id });
  return true;
}
