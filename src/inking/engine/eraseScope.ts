/**
 * What an eraser is allowed to touch.
 *
 * The eraser normally takes whatever it is dragged over, which is wrong the
 * moment a page has layers: scrubbing out a highlight buries the writing
 * underneath it, and lifting a strip of washi tape means erasing everything it
 * was laid across. Narrowing the scope lets one layer be removed without
 * disturbing the others, and the same predicate drives the bulk clears.
 */
import type { Stroke } from '../types';

export type EraseScope = 'all' | 'highlighter' | 'washi-tape';

export const ERASE_SCOPES: readonly { readonly id: EraseScope; readonly label: string; readonly hint: string }[] = [
  { id: 'all', label: 'Everything', hint: 'Erase any ink the eraser touches' },
  { id: 'highlighter', label: 'Highlighter', hint: 'Erase highlighter strokes only, leaving the writing under them' },
  { id: 'washi-tape', label: 'Washi tape', hint: 'Lift tape only, leaving whatever it was laid across' },
];

/** Does this stroke fall inside `scope`? `all` takes everything. */
export function inEraseScope(stroke: Stroke, scope: EraseScope): boolean {
  if (scope === 'all') return true;
  // Only freehand strokes carry a tool that can be narrowed to; a geometric
  // stroke is never a highlight or a strip of tape.
  return stroke.kind === 'freehand' && stroke.tool === scope;
}

/** The strokes an erase of this scope would remove. */
export function strokesInScope(strokes: readonly Stroke[], scope: EraseScope = 'all'): Stroke[] {
  return strokes.filter((stroke) => inEraseScope(stroke, scope));
}

/**
 * What survives an erase of this scope — the new stroke list for a bulk clear.
 * Returns the same array when the scope matched nothing, so callers can skip
 * the write and the undo entry that would come with it.
 */
export function keepStrokes(strokes: readonly Stroke[], scope: EraseScope = 'all'): readonly Stroke[] {
  const kept = strokes.filter((stroke) => !inEraseScope(stroke, scope));
  return kept.length === strokes.length ? strokes : kept;
}

/** Narrow a set of hit ids to the ones the scope actually allows erasing. */
export function idsInScope(strokes: readonly Stroke[], ids: ReadonlySet<string>, scope: EraseScope = 'all'): Set<string> {
  if (scope === 'all') return new Set(ids);
  const allowed = new Set<string>();
  for (const stroke of strokes) {
    if (ids.has(stroke.id) && inEraseScope(stroke, scope)) allowed.add(stroke.id);
  }
  return allowed;
}
