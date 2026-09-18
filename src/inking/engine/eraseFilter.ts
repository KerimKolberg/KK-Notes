/**
 * What an eraser is allowed to touch.
 *
 * An eraser normally takes whatever it is dragged over, which is wrong the
 * moment a page has layers: scrubbing out a highlight buries the writing
 * underneath it, and lifting a strip of washi tape means erasing everything it
 * was laid across. The filter narrows the eraser to one or more decorative
 * layers so they can be removed without disturbing anything else.
 *
 * The two switches are independent rather than a three-way choice: turning
 * both on erases highlighter *and* tape and still spares the writing, which a
 * single "only this one layer" setting could not express. With neither on the
 * eraser is unfiltered and takes everything, which is the default.
 *
 * The same predicate drives the stroke eraser, the area eraser and both bulk
 * clears, so there is exactly one answer to "may this be erased?".
 */
import type { Stroke } from '../types';

export interface EraseFilter {
  /** Take highlighter strokes. */
  readonly highlighter: boolean;
  /** Take washi tape strokes. */
  readonly washiTape: boolean;
}

/** No filter: the eraser takes whatever it touches. */
export const ERASE_EVERYTHING: EraseFilter = { highlighter: false, washiTape: false };

/** The toggles the eraser's flyout shows, in order. */
export const ERASE_FILTERS: readonly { readonly key: keyof EraseFilter; readonly label: string; readonly hint: string }[] = [
  { key: 'highlighter', label: 'Highlighter only', hint: 'Erase highlighter strokes only, leaving the writing under them' },
  { key: 'washiTape', label: 'Washi tape only', hint: 'Lift tape only, leaving whatever it was laid across' },
];

/** True when at least one layer is selected, i.e. the eraser is narrowed. */
export function filterIsActive(filter: EraseFilter): boolean {
  return filter.highlighter || filter.washiTape;
}

/**
 * May this stroke be erased under `filter`? An unfiltered eraser takes
 * everything; a filtered one takes only the selected layers, so a pen stroke
 * — and any geometric shape, which is never a highlight or a strip of tape —
 * is passed straight over.
 */
export function inEraseFilter(stroke: Stroke, filter: EraseFilter): boolean {
  if (!filterIsActive(filter)) return true;
  if (stroke.kind !== 'freehand') return false;
  return (filter.highlighter && stroke.tool === 'highlighter') || (filter.washiTape && stroke.tool === 'washi-tape');
}

/** The strokes an erase under this filter would remove. */
export function strokesInFilter(strokes: readonly Stroke[], filter: EraseFilter = ERASE_EVERYTHING): Stroke[] {
  return strokes.filter((stroke) => inEraseFilter(stroke, filter));
}

/**
 * What survives — the new stroke list for a bulk clear. Returns the same array
 * when the filter matched nothing, so the caller can skip the write and the
 * undo entry that would come with it.
 */
export function keepStrokes(strokes: readonly Stroke[], filter: EraseFilter = ERASE_EVERYTHING): readonly Stroke[] {
  const kept = strokes.filter((stroke) => !inEraseFilter(stroke, filter));
  return kept.length === strokes.length ? strokes : kept;
}

/** Narrow a set of hit ids to the ones the filter actually allows erasing. */
export function idsInFilter(
  strokes: readonly Stroke[],
  ids: ReadonlySet<string>,
  filter: EraseFilter = ERASE_EVERYTHING,
): Set<string> {
  if (!filterIsActive(filter)) return new Set(ids);
  const allowed = new Set<string>();
  for (const stroke of strokes) {
    if (ids.has(stroke.id) && inEraseFilter(stroke, filter)) allowed.add(stroke.id);
  }
  return allowed;
}
